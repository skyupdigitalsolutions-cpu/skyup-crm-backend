// routes/mobileCallLog.js
const express = require('express');
const router  = express.Router();
const { protect, protectAny } = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const {
  syncCallLogs, getCallLogs, matchPhone, uploadRecording, upload,
  getCompanyRecordings, getCallLogsForLead, saveRemark,
} = require('../controllers/mobileCallLogController');

router.get('/match',              protect,    matchPhone);
router.get('/',                   protect,    getCallLogs);
router.post('/sync',              protect,    syncCallLogs);
router.post('/recording',         protect,    upload.single('recording'), uploadRecording);
router.post('/remark',            protect,    saveRemark);
router.get('/recordings',         protectAny, getCompanyRecordings);  // admin views all company recordings
router.get('/lead/:leadId',       protectAny, getCallLogsForLead);  // ✅ accepts admin + user tokens

module.exports = router;