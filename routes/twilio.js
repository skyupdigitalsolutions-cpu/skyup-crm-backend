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
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID.trim(), // .trim() guards against trailing space in .env
    incomingAllow: false,
  }));
  res.json({ token: token.toJwt(), identity });
});

// ── 2. TwiML voice handler ────────────────────────────────────────────────────
// Twilio posts here when a call is initiated from the browser SDK
// "To" is now the real E.164 phone number sent from the frontend
// "LeadId" is the MongoDB lead _id for logging only
router.post('/voice', async (req, res) => {
  const twiml  = new twilio.twiml.VoiceResponse();
  const { To, LeadId, CallSid, Caller } = req.body;

  try {
    if (!To) {
      twiml.say('No destination number provided.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Log the call if we have a LeadId
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
      record:   'record-from-answer',
      recordingStatusCallback:       `${process.env.SERVER_URL}/api/twilio/recording-status`,
      recordingStatusCallbackMethod: 'POST',
    });

    dial.number(To); // ✅ already E.164 from frontend
  } catch (err) {
    console.error('Voice error:', err);
    twiml.say('An error occurred.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── 3. Recording webhook ──────────────────────────────────────────────────────
router.post('/recording-status', async (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingDuration } = req.body;
  try {
    await Call.findOneAndUpdate(
      { callSid: CallSid },
      {
        recordingSid:      RecordingSid,
        recordingUrl:      RecordingUrl + '.mp3',
        recordingDuration: RecordingDuration,
        status:            'completed',
        recordedAt:        new Date(),
      }
    );
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

module.exports = router;