// routes/mobileCallLog.js
// CHANGE: Added GET /today route for mobile app to fetch only today's synced logs.
//         Mobile app uses this instead of GET / (which returns full history).

const express = require('express');
const router  = express.Router();
const { protect, protectAny } = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const {
  syncCallLogs, getCallLogs, getTodayCallLogs, matchPhone,
  uploadRecording, upload, getCompanyRecordings,
  getCompanyAllLogs, getCallLogsForLead, saveRemark,
  summarizeUnmatchedCall,
} = require('../controllers/mobileCallLogController');
const { makeCompanyUploadMiddleware } = require('../services/cloudinaryService');

// Per-company recording upload — routes the file to the company's own Cloudinary
// account when configured, else the global account. Replaces the module-level
// global `upload.single('recording')`.
const recordingUpload = makeCompanyUploadMiddleware({
  field: 'recording',
  folderBase: 'skyup-crm/recordings',
  allowedFormats: ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'mp4', '3g2'],
});

router.get('/match',        protectAny, matchPhone);
router.get('/today',        protectAny, getTodayCallLogs);   // protectAny: agents see own, admins see all company
router.get('/',             protectAny, getCallLogs);        // supports ?date=YYYY-MM-DD
router.post('/sync',        protectAny, syncCallLogs);
router.post('/recording',   protectAny, recordingUpload, uploadRecording);
router.post('/remark',      protectAny, saveRemark);
router.post('/summarize-unmatched', protectAny, summarizeUnmatchedCall); // AI summary for non-lead calls
router.get('/recordings',   protectAny, getCompanyRecordings);
router.get('/all',          protectAny, getCompanyAllLogs);
router.get('/lead/:leadId', protectAny, getCallLogsForLead);

module.exports = router;
