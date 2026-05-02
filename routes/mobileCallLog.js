const express = require('express');
const router  = express.Router();
const { protect }      = require('../middlewares/authMiddleware');
const { adminProtect } = require('../middlewares/adminAuthMiddleware');
const {
  syncCallLogs, getCallLogs, matchPhone, uploadRecording, upload,
  getCompanyRecordings, getCallLogsForLead, saveRemark,
} = require('../controllers/mobileCallLogController');

router.get('/match',              protect, matchPhone);
router.get('/',                   protect, getCallLogs);
router.post('/sync',              protect, syncCallLogs);
router.post('/recording',         protect, upload.single('recording'), uploadRecording);
router.post('/remark',            protect, saveRemark);
router.get('/recordings',         protect, getCompanyRecordings);
router.get('/lead/:leadId',       protect, getCallLogsForLead);

module.exports = router;
