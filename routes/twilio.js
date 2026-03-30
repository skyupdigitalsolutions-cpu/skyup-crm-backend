// routes/twilio.js
const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
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
  const twiml  = new twilio.twiml.VoiceResponse();
  // FIX #3: Twilio auto-injects CallSid — log it so we can verify matching later
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
      // FIX #1: 'record-from-answer-dual' captures both caller + callee audio
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

  // FIX #2 + #3: Log every webhook hit so you can confirm Render is awake
  // and verify which CallSid Twilio is sending back
  console.log('[/recording-status] received:', { CallSid, ParentCallSid, RecordingSid, RecordingStatus, RecordingDuration });

  // Only save when recording is actually complete
  if (RecordingStatus !== 'completed') {
    return res.sendStatus(200);
  }

  try {
    // FIX #3: Twilio may send the child leg's CallSid — try both child + parent
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

    // If no match on child CallSid, try the parent CallSid
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

// ── 5. Stream recording audio (proxies Twilio auth so browser can play it) ───
router.get('/recording/:recordingSid/audio', async (req, res) => {
  try {
    const { recordingSid } = req.params;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

    const response = await fetch(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64'),
      },
    });

    if (!response.ok) {
      console.error('[/recording/audio] Twilio returned:', response.status);
      return res.status(response.status).send('Could not fetch recording');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    response.body.pipe(res);
  } catch (err) {
    console.error('Audio proxy error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;