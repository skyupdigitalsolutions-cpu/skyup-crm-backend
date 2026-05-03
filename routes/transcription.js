// routes/transcription.js
const express      = require('express');
const router       = express.Router();
const { protect }      = require('../middlewares/authMiddleware');
const { protectAdmin } = require('../middlewares/adminAuthMiddleware');
const {
  transcribeTwilioCall,
  getTwilioTranscription,
  transcribeMobileCall,
  getMobileTranscription,
} = require('../controllers/transcriptionController');

// ── Twilio recordings (admin only — Twilio SID is admin-visible data) ─────────
router.post('/twilio/:recordingSid', protectAdmin, transcribeTwilioCall);
router.get('/twilio/:recordingSid',  protectAdmin, getTwilioTranscription);

// ── Mobile recordings (user — scoped to their own call logs) ──────────────────
router.post('/mobile/:callLogId/:recordingId', protect, transcribeMobileCall);
router.get('/mobile/:callLogId/:recordingId',  protect, getMobileTranscription);

module.exports = router;