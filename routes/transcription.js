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
  getLeadCombinedSummary,
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

// ── Lead combined summary (admin or user) ─────────────────────────────────────
// Aggregates all transcribed call summaries for a lead into one master summary.
router.get('/lead/:leadId/summary', protectAny, getLeadCombinedSummary);

module.exports = router;
