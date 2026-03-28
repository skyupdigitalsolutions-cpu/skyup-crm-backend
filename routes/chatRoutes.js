const express = require('express');
const router  = express.Router();
const {
  createOrFetchChatUser,
  getAllChatUsers,
  getChatHistory
} = require('../controllers/chatController');

router.post('/users',              createOrFetchChatUser);  // POST   /api/chat/users
router.get('/users',               getAllChatUsers);         // GET    /api/chat/users
router.get('/history/:username',   getChatHistory);          // GET    /api/chat/history/:username

module.exports = router;