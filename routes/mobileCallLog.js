// routes/mobileCallLog.js
// CHANGE: Added GET /today route for mobile app to fetch only today's synced logs.
//         Mobile app uses this instead of GET / (which returns full history).
// CHANGE: Added invalidateCache on write routes (/sync, /recording, /remark) so
//         cached GET /today and GET / responses refresh immediately after a sync.

const express = require('express');
const { withCache, invalidateCache } = require('../middlewares/redisCache');
const router  = express.Router();
const { protect, protectAny } = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const {
  syncCallLogs, getCallLogs, getTodayCallLogs, matchPhone,
  uploadRecording, upload, getCompanyRecordings,
  getCompanyAllLogs, getCallLogsForLead, saveRemark,
  summarizeUnmatchedCall, getUncalledLeads,
  getMyCallHistory,
} = require('../controllers/mobileCallLogController');
const {
  getMonitoringSummary, getMonitoringHistory, getNeverAttended, getMonitoringClients,
} = require('../controllers/callMonitoringController');
const { makeCompanyUploadMiddleware } = require('../services/cloudinaryService');

// Per-company recording upload — routes the file to the company's own Cloudinary
// account when configured, else the global account. Replaces the module-level
// global `upload.single('recording')`.
const recordingUpload = makeCompanyUploadMiddleware({
  field: 'recording',
  folderBase: 'skyup-crm/recordings',
  allowedFormats: ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'mp4', '3g2'],
});

// ── Reads (cached per company + user, 30s TTL via /call-logs rule) ────────────
router.get('/match',        protectAny, matchPhone);
router.get('/my-history',   protectAny, getMyCallHistory);  // employee web: full call log + talk time
router.get('/today',        protectAny, withCache, getTodayCallLogs);   // protectAny: agents see own, admins see all company
router.get('/',             protectAny, withCache, getCallLogs);        // supports ?date=YYYY-MM-DD
router.get('/recordings',   protectAny, getCompanyRecordings);
router.get('/all',          protectAny, getCompanyAllLogs);
router.get('/lead/:leadId', protectAny, getCallLogsForLead);

// ── Admin Call Monitoring report (admin / super_admin only — the controller
//    returns 403 for employees). Cached 30s per company+user+query.
router.get('/monitoring/summary',        protectAny, withCache, getMonitoringSummary);
router.get('/monitoring/history',        protectAny, withCache, getMonitoringHistory);
router.get('/monitoring/never-attended', protectAny, withCache, getNeverAttended);
router.get('/monitoring/clients',        protectAny, withCache, getMonitoringClients);

// Leads assigned to this user that have NOT been called on/before the selected day.
// Carry-forward: appears every day until the lead is actually called.
router.get('/uncalled',     protectAny, getUncalledLeads);

// ── Writes (clear the company's cached responses after success) ───────────────
router.post('/sync',                protectAny, invalidateCache, syncCallLogs);
router.post('/recording',           protectAny, invalidateCache, recordingUpload, uploadRecording);
router.post('/remark',              protectAny, invalidateCache, saveRemark);
router.post('/summarize-unmatched', protectAny, summarizeUnmatchedCall); // AI summary for non-lead calls

module.exports = router;