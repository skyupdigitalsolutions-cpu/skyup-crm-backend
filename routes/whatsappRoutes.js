// routes/whatsappRoutes.js
const express = require("express");
const router  = express.Router();

const { verifyWebhook, receiveWebhook } = require("../controllers/whatsappWebhookController");
const {
  getConversations,
  getMessages,
  sendMessage,
  sendTemplate,
  assignConversation,
  closeConversation,
  saveConfig,
  getConfig,
} = require("../controllers/whatsappChatController");

// Import your existing auth middleware
const { protect }      = require("../middlewares/authMiddleware");
const { adminProtect } = require("../middlewares/adminAuthMiddleware");

// ─── Webhook (public — NO auth, Meta calls these directly) ──────────────────
// Register these in Meta Developer Console as your callback URL:
// https://your-domain.com/wa-webhook
router.get("/",  verifyWebhook);   // GET  /wa-webhook
router.post("/", receiveWebhook);  // POST /wa-webhook

// ─── API routes (auth required) ─────────────────────────────────────────────

// Config (admin only)
router.get( "/config",   adminProtect, getConfig);
router.post("/config",   adminProtect, saveConfig);

// Conversations
router.get("/conversations",                            protect, getConversations);
router.get("/conversations/:conversationId/messages",   protect, getMessages);
router.patch("/conversations/:id/assign",               adminProtect, assignConversation);
router.patch("/conversations/:id/close",                protect, closeConversation);

// Sending messages
router.post("/send",          protect, sendMessage);
router.post("/send-template", protect, sendTemplate);

module.exports = router;