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
// NOTE (still open, needs a product decision — NOT auto-fixed here):
//   1. The chat models are NOT company-scoped. A username is global, so two
//      tenants with the same username could see each other's messages. Consider
//      adding a `company` field to ChatUser/Message and scoping every query.
//   2. editMessage/deleteMessage trust a `requester` value from the request
//      BODY rather than the authenticated identity (req.user/req.admin). A
//      logged-in user can still edit/delete another person's message by passing
//      someone else's username as `requester`. The handler should derive the
//      requester from the token, not the body.
router.use(protectAny);

router.post('/users',              createOrFetchChatUser);  // POST   /api/chat/users
router.get('/users',               getAllChatUsers);         // GET    /api/chat/users
router.get('/history/:username',   getChatHistory);          // GET    /api/chat/history/:username
router.put('/message/:id',         editMessage);             // PUT    /api/chat/message/:id
router.delete('/message/:id',      deleteMessage);           // DELETE /api/chat/message/:id

module.exports = router;