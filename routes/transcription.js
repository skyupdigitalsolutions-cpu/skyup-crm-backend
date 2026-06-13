// routes/transcription.js — UPDATED
// Added requireFeature gates:
//   callTranscription — for all transcription endpoints
//   aiSummary        — for the combined lead summary endpoint
// These are independent features — AI Summary can exist without Transcription and vice versa
// (though in practice summary is only useful after transcription, the gates are separate per spec).

const express      = require('express');
const router       = express.Router();
const { protectAny }     = require('../middlewares/authMiddleware');
const { requireFeature } = require('../middlewares/entitlementMiddleware');
const {
  transcribeMobileCall,
  getMobileTranscription,
  getLeadCombinedSummary,
} = require('../controllers/transcriptionController');

// ── Mobile recordings ─────────────────────────────────────────────────────────
router.post('/mobile/:callLogId/:recordingId', protectAny, requireFeature("callTranscription"), transcribeMobileCall);
router.get('/mobile/:callLogId/:recordingId',  protectAny, requireFeature("callTranscription"), getMobileTranscription);

// ── Lead combined summary — requires aiSummary feature (independent of transcription) ──
router.get('/lead/:leadId/summary', protectAny, requireFeature("aiSummary"), getLeadCombinedSummary);

module.exports = router;
