// routes/transcription.js
const express      = require('express');
const router       = express.Router();
const { protect, protectAny } = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const {
  transcribeTwilioCall,
  getTwilioTranscription,
  transcribeMobileCall,
  getMobileTranscription,
} = require('../controllers/transcriptionController');

// ── Twilio recordings (admin only — Twilio SID is admin-visible data) ─────────
router.post('/twilio/:recordingSid', protectAdmin, transcribeTwilioCall);
router.get('/twilio/:recordingSid',  protectAdmin, getTwilioTranscription);

// ── Mobile recordings ─────────────────────────────────────────────────────────
// FIX: Use protectAny so both admin and user tokens are accepted.
// The admin views call recordings in the CallRecording dashboard and needs
// to trigger transcription — but the original route used protect (user-only).
router.post('/mobile/:callLogId/:recordingId', protectAny, transcribeMobileCall);
router.get('/mobile/:callLogId/:recordingId',  protectAny, getMobileTranscription);

module.exports = router;