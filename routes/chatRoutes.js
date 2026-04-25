const express = require('express');
const router  = express.Router();
const {
  createOrFetchChatUser,
  getAllChatUsers,
  getChatHistory,
  editMessage,
  deleteMessage,
} = require('../controllers/chatController');

router.post('/users',              createOrFetchChatUser);  // POST   /api/chat/users
router.get('/users',               getAllChatUsers);         // GET    /api/chat/users
router.get('/history/:username',   getChatHistory);          // GET    /api/chat/history/:username
router.put('/message/:id',         editMessage);             // PUT    /api/chat/message/:id
router.delete('/message/:id',      deleteMessage);           // DELETE /api/chat/message/:id

module.exports = router;