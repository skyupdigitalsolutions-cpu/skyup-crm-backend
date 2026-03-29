// // routes/twilio.js
// const express  = require('express');
// const router   = express.Router();
// const twilio   = require('twilio');
// const Call     = require('../models/Call');
// const Contact  = require('../models/Contact'); // your existing contacts model

// const { AccessToken } = twilio.jwt;
// const { VoiceGrant }  = AccessToken;
// const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// // ── 1. Token ──────────────────────────────────────────────────────────────────
// router.get('/token', (req, res) => {
//   const identity = req.query.identity || 'crm_user';
//   const token = new AccessToken(
//     process.env.TWILIO_ACCOUNT_SID,
//     process.env.TWILIO_API_KEY,
//     process.env.TWILIO_API_SECRET,
//     { identity }
//   );
//   token.addGrant(new VoiceGrant({
//     outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
//     incomingAllow: false,
//   }));
//   res.json({ token: token.toJwt(), identity });
// });

// // ── 2. TwiML voice handler ────────────────────────────────────────────────────
// // Frontend sends contactId as "To" — real number resolved here, never exposed
// router.post('/voice', async (req, res) => {
//   const twiml = new twilio.twiml.VoiceResponse();
//   const { To: contactId, CallSid, Caller } = req.body;

//   try {
//     const contact = await Contact.findById(contactId);
//     if (!contact) {
//       twiml.say('Contact not found.');
//       return res.type('text/xml').send(twiml.toString());
//     }

//     // Save initial call record
//     await Call.create({
//       callSid:       CallSid,
//       contactId:     contact._id,
//       contactName:   contact.name,
//       agentIdentity: Caller,
//       status:        'initiated',
//     });

//     const dial = twiml.dial({
//       callerId: process.env.TWILIO_PHONE_NUMBER,
//       record:   'record-from-answer',
//       recordingStatusCallback:       `${process.env.SERVER_URL}/api/twilio/recording-status`,
//       recordingStatusCallbackMethod: 'POST',
//     });

//     dial.number(contact.phone); // ✅ real number used only here, server-side

//   } catch (err) {
//     console.error('Voice error:', err);
//     twiml.say('An error occurred.');
//   }

//   res.type('text/xml').send(twiml.toString());
// });

// // ── 3. Recording webhook — Twilio posts here when recording is ready ──────────
// router.post('/recording-status', async (req, res) => {
//   const { CallSid, RecordingSid, RecordingUrl, RecordingDuration } = req.body;
//   try {
//     await Call.findOneAndUpdate(
//       { callSid: CallSid },
//       {
//         recordingSid:      RecordingSid,
//         recordingUrl:      RecordingUrl + '.mp3',
//         recordingDuration: RecordingDuration,
//         status:            'completed',
//         recordedAt:        new Date(),
//       }
//     );
//     console.log('Recording saved for call:', CallSid);
//   } catch (err) {
//     console.error('Recording save error:', err);
//   }
//   res.sendStatus(200);
// });

// // ── 4. Admin: fetch all recordings ───────────────────────────────────────────
// router.get('/admin/recordings', async (req, res) => {
//   try {
//     const calls = await Call.find({ recordingUrl: { $exists: true, $ne: null } })
//       .sort({ recordedAt: -1 })
//       .limit(200);
//     res.json(calls);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// module.exports = router;
// routes/twilio.js
const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const Call     = require('../models/Call');
const Lead     = require('../models/Leads'); // ✅ FIX: use Lead (has mobile numbers), Contact collection is empty

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
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  }));
  res.json({ token: token.toJwt(), identity });
});

// ── 2. TwiML voice handler ────────────────────────────────────────────────────
// Frontend sends lead _id as "To" — real mobile number resolved here, never exposed
router.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { To: leadId, CallSid, Caller } = req.body;

  try {
    // ✅ FIX: look up from Lead model (has mobile field), not Contact (empty collection)
    const lead = await Lead.findById(leadId);
    if (!lead) {
      twiml.say('Contact not found.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Save initial call record
    await Call.create({
      callSid:       CallSid,
      contactId:     lead._id,
      contactName:   lead.name,
      agentIdentity: Caller,
      status:        'initiated',
    });

    const dial = twiml.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
      record:   'record-from-answer',
      recordingStatusCallback:       `${process.env.SERVER_URL}/api/twilio/recording-status`,
      recordingStatusCallbackMethod: 'POST',
    });

    // ✅ FIX: Lead model uses 'mobile' (Number), not 'phone'
    dial.number(String(lead.mobile));

  } catch (err) {
    console.error('Voice error:', err);
    twiml.say('An error occurred.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── 3. Recording webhook — Twilio posts here when recording is ready ──────────
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
    console.log('Recording saved for call:', CallSid);
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