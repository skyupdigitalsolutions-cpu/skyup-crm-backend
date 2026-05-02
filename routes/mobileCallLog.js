const express = require('express');
const router  = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  syncCallLogs,
  getCallLogs,
  matchPhone,
  uploadRecording,
  deleteRecording,
  upload,
} = require('../controllers/mobileCallLogController');

// All routes require user auth (same JWT as web frontend)
router.get('/match',              protect, matchPhone);
router.get('/',                   protect, getCallLogs);
router.post('/sync',              protect, syncCallLogs);
router.post('/recording',         protect, upload.single('recording'), uploadRecording);
router.delete('/recording',       protect, deleteRecording);   // ✅ new — delete a specific recording

module.exports = router;
