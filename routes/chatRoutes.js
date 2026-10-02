const express = require('express');
const router  = express.Router();
const { protectAny } = require('../middlewares/authMiddleware');
const {
  createOrFetchChatUser,
  getAllChatUsers,
  getChatHistory,
  editMessage,
  deleteMessage,
} = require('../controllers/chatController');

// SECURITY FIX: every chat route was previously PUBLIC — no authentication at
// all. Anyone could list all chat users, read any user's history, and edit or
// delete any message by ID. protectAny accepts both admin and employee tokens,
// which matches the admin <-> employee chat use case.
//
// Company scoping + token-derived identity are enforced in chatController.js
// (every query filtered by the caller's company; body `requester` ignored).
router.use(protectAny);

router.post('/users',              createOrFetchChatUser);  // POST   /api/chat/users
router.get('/users',               getAllChatUsers);         // GET    /api/chat/users
router.get('/history/:username',   getChatHistory);          // GET    /api/chat/history/:username
router.put('/message/:id',         editMessage);             // PUT    /api/chat/message/:id
router.delete('/message/:id',      deleteMessage);           // DELETE /api/chat/message/:id

module.exports = router;