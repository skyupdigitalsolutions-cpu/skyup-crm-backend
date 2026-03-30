// routes/twilio.js
const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const axios    = require('axios');
const Call     = require('../models/Call');
const Lead     = require('../models/Leads');

const { AccessToken } = twilio.jwt;
const { VoiceGrant }  = AccessToken;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── 1. Token ──────────────────────────────────────────────────────────────────
router.get('/token', (req, res) => {
  const identity = req.query.identity || 'crm_user';
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity }
  );
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID.trim(),
    incomingAllow: false,
  }));
  res.json({ token: token.toJwt(), identity });
});

// ── 2. TwiML voice handler ────────────────────────────────────────────────────
router.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { To, LeadId, CallSid, Caller } = req.body;

  console.log('[/voice] incoming:', { To, LeadId, CallSid, Caller });

  try {
    if (!To) {
      twiml.say('No destination number provided.');
      return res.type('text/xml').send(twiml.toString());
    }

    if (LeadId) {
      const lead = await Lead.findById(LeadId).catch(() => null);
      await Call.create({
        callSid:       CallSid,
        contactId:     LeadId,
        contactName:   lead?.name || 'Unknown',
        agentIdentity: Caller,
        status:        'initiated',
      }).catch((err) => console.error('Call log error:', err));
    }

    const dial = twiml.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
      record:   'record-from-answer-dual',
      recordingStatusCallback:       `${process.env.SERVER_URL}/api/twilio/recording-status`,
      recordingStatusCallbackMethod: 'POST',
    });

    dial.number(To);
  } catch (err) {
    console.error('Voice error:', err);
    twiml.say('An error occurred.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── 3. Recording webhook ──────────────────────────────────────────────────────
router.post('/recording-status', async (req, res) => {
  const { CallSid, ParentCallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus } = req.body;

  console.log('[/recording-status] received:', { CallSid, ParentCallSid, RecordingSid, RecordingStatus, RecordingDuration });

  if (RecordingStatus !== 'completed') {
    return res.sendStatus(200);
  }

  try {
    let result = await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        recordingSid:      RecordingSid,
        recordingUrl:      RecordingUrl + '.mp3',
        recordingDuration: RecordingDuration,
        status:            'completed',
        recordedAt:        new Date(),
      },
      { new: true }
    );

    if (!result && ParentCallSid) {
      console.log('[/recording-status] No match on CallSid, trying ParentCallSid:', ParentCallSid);
      result = await Call.findOneAndUpdate(
        { callSid: ParentCallSid },
        {
          recordingSid:      RecordingSid,
          recordingUrl:      RecordingUrl + '.mp3',
          recordingDuration: RecordingDuration,
          status:            'completed',
          recordedAt:        new Date(),
        },
        { new: true }
      );
    }

    if (!result) {
      console.warn('[/recording-status] No Call document found for CallSid:', CallSid, 'or ParentCallSid:', ParentCallSid);
    } else {
      console.log('[/recording-status] Recording saved for call:', result._id);
    }
  } catch (err) {
    console.error('Recording save error:', err);
  }

  res.sendStatus(200);
});

// ── 4. Admin: fetch all recordings ───────────────────────────────────────────
router.get('/admin/recordings', async (req, res) => {
  try {
    const calls = await Call.find({ recordingUrl: { $exists: true, $ne: null } })
      .sort({ recordedAt: -1 })
      .limit(200);
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. Stream recording audio (proxied via axios so browser can play it) ──────
router.get('/recording/:recordingSid/audio', async (req, res) => {
  try {
    const { recordingSid } = req.params;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

    const response = await axios.get(url, {
      responseType: 'stream',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    response.data.pipe(res);
  } catch (err) {
    console.error('Audio proxy error:', err?.response?.status, err.message);
    res.status(err?.response?.status || 500).send('Could not fetch recording');
  }
});

module.exports = router;