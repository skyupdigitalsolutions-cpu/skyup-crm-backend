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
  bulkSendCSV,
  getLeadsForWhatsApp,
  employeeBulkSend,
  getConversationByLead,
} = require("../controllers/whatsappChatController");

const { protect, protectAny }            = require("../middlewares/authMiddleware");
const { protectAdmin: adminProtect }     = require("../middlewares/adminAuthMiddleware");

// ─── Webhook (public — NO auth, Meta/MSG91 calls these directly) ─────────────
router.get("/",  verifyWebhook);   // GET  /wa-webhook
router.post("/", receiveWebhook);  // POST /wa-webhook

// ─── Config (admin only) ─────────────────────────────────────────────────────
router.get( "/config",   adminProtect, getConfig);
router.post("/config",   adminProtect, saveConfig);

// ─── Conversations ────────────────────────────────────────────────────────────
// protectAny — employees need to list their own assigned conversations too.
// getConversations already scopes results to assignedAgent when role !== "admin".
router.get("/conversations",                            protectAny, getConversations);
// protectAny — both admin and employee can fetch messages & send in the 24h window
router.get("/conversations/:conversationId/messages",   protectAny, getMessages);
router.patch("/conversations/:id/assign",               adminProtect, assignConversation);
router.patch("/conversations/:id/close",                adminProtect, closeConversation);

// ─── Sending messages ─────────────────────────────────────────────────────────
// protectAny — employees need to send text replies within an open 24h session
// protectAny — employees also need to send templates to re-engage expired sessions
router.post("/send",               protectAny, sendMessage);
router.post("/send-template",      protectAny, sendTemplate);

// ─── Look up conversation by lead ID (employee chat) ─────────────────────────
router.get("/conversation-by-lead/:leadId", protectAny, getConversationByLead);

// ─── Admin or agent starts a fresh conversation with any client number ────────
router.post("/start-conversation", protectAny, startConversation);

// ─── Admin deletes a zombie/failed conversation ───────────────────────────────
router.delete("/conversations/:id", adminProtect, deleteConversation);

// ─── Bulk send: all leads (or campaign-filtered leads) ───────────────────────
router.post("/bulk-send",     adminProtect, bulkSendToLeads);

// ─── Bulk send: arbitrary recipients from CSV ────────────────────────────────
router.post("/bulk-send-csv", adminProtect, bulkSendCSV);

// ─── Get all leads for WhatsApp panel (Leads tab) ────────────────────────────
router.get("/leads", protectAny, getLeadsForWhatsApp);

// ─── Employee WhatsApp blast — only their own assigned leads ─────────────────
router.post("/employee-bulk-send", protect, employeeBulkSend);

module.exports = router;