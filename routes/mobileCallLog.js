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
} = require('../controllers/mobileCallLogController');

router.get('/match',        protect,    matchPhone);
router.get('/today',        protect,    getTodayCallLogs);   // NEW: mobile app — today only
router.get('/',             protect,    getCallLogs);        // supports ?date=YYYY-MM-DD
router.post('/sync',        protect,    syncCallLogs);
router.post('/recording',   protect,    upload.single('recording'), uploadRecording);
router.post('/remark',      protect,    saveRemark);
router.get('/recordings',   protectAny, getCompanyRecordings);
router.get('/all',          protectAny, getCompanyAllLogs);
router.get('/lead/:leadId', protectAny, getCallLogsForLead);

module.exports = router;
