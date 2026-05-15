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
  deleteConversation,
  saveConfig,
  getConfig,
  startConversation,
  bulkSendToLeads,
  getLeadsForWhatsApp,
} = require("../controllers/whatsappChatController");

const { protect }                        = require("../middlewares/authMiddleware");
const { protectAdmin: adminProtect }     = require("../middlewares/adminAuthMiddleware");

// ─── Webhook (public — NO auth, Meta/MSG91 calls these directly) ─────────────
router.get("/",  verifyWebhook);   // GET  /wa-webhook
router.post("/", receiveWebhook);  // POST /wa-webhook

// ─── Config (admin only) ─────────────────────────────────────────────────────
router.get( "/config",   adminProtect, getConfig);
router.post("/config",   adminProtect, saveConfig);

// ─── Conversations ────────────────────────────────────────────────────────────
router.get("/conversations",                            adminProtect, getConversations);
router.get("/conversations/:conversationId/messages",   adminProtect, getMessages);
router.patch("/conversations/:id/assign",               adminProtect, assignConversation);
router.patch("/conversations/:id/close",                adminProtect, closeConversation);

// ─── Sending messages ─────────────────────────────────────────────────────────
router.post("/send",               adminProtect, sendMessage);
router.post("/send-template",      adminProtect, sendTemplate);

// ─── Admin starts a fresh conversation with any client number ────────────────
router.post("/start-conversation", adminProtect, startConversation);

// ─── Admin deletes a zombie/failed conversation ───────────────────────────────
router.delete("/conversations/:id", adminProtect, deleteConversation);

// ─── Admin bulk-sends a template to ALL leads ────────────────────────────────
router.post("/bulk-send", adminProtect, bulkSendToLeads);

// ─── Get all leads for WhatsApp panel (Leads tab) ────────────────────────────
router.get("/leads", adminProtect, getLeadsForWhatsApp);

module.exports = router;