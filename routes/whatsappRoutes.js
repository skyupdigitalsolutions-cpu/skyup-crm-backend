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
  getUnreadCounts,
  sendMedia,
  editMessage,
  refreshMedia,
  markConversationRead,
  getSendLogReport,
} = require("../controllers/whatsappChatController");
const { makeCompanyUploadMiddleware } = require("../services/cloudinaryService");

// Uploads the attachment to Cloudinary first so WhatsApp gets a public HTTPS
// URL (it cannot read local files). resource_type 'auto' handles images,
// video, audio and documents alike.
const waMediaUpload = makeCompanyUploadMiddleware({
  field: "file",
  folderBase: "skyup-crm/whatsapp",
});

const { protect, protectAny }            = require("../middlewares/authMiddleware");
const { protectAdmin: adminProtect }     = require("../middlewares/adminAuthMiddleware");
const { requireFeature }                 = require("../middlewares/entitlementMiddleware");

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
// Persistent unread inbound counts for the Communications lead-list badges
router.get("/unread-counts", protectAny, getUnreadCounts);
// Send an image / video / audio / document (incl. GIF) in an open chat
router.post("/send-media", protectAny, waMediaUpload, sendMedia);
// Edit the CRM's stored copy of an outbound message (does NOT change the
// lead's copy — WhatsApp has no edit-sent-message API).
router.patch("/messages/:id", protectAny, editMessage);
// Retry fetching a lead-sent attachment that failed to mirror on arrival
router.post("/messages/:id/refresh-media", protectAny, refreshMedia);
// Clear the unread badge for a conversation the agent is actively reading
router.post("/conversations/:id/mark-read", protectAny, markConversationRead);

// ─── Admin or agent starts a fresh conversation with any client number ────────
router.post("/start-conversation", protectAny, startConversation);

// ─── Admin deletes a zombie/failed conversation ───────────────────────────────
router.delete("/conversations/:id", adminProtect, deleteConversation);

// ─── Bulk send: all leads (or campaign-filtered leads) — whatsappBlast feature required ──
router.post("/bulk-send",     adminProtect, requireFeature("whatsappBlast"), bulkSendToLeads);

// ─── Bulk send: arbitrary recipients from CSV — whatsappBlast feature required ──
router.post("/bulk-send-csv", adminProtect, requireFeature("whatsappBlast"), bulkSendCSV);

// ─── Get all leads for WhatsApp panel (Leads tab) ────────────────────────────
router.get("/leads", protectAny, getLeadsForWhatsApp);

// ─── Employee WhatsApp blast — only their own assigned leads — whatsappBlast feature required ──
router.post("/employee-bulk-send", protect, requireFeature("whatsappBlast"), employeeBulkSend);

// ─── Sent-template report (blast + CSV blast + employee blast + nurture) ─────
// protectAny — admin/super_admin see the whole company; employees see only
// their own employee-blast sends (scoped inside the controller).
router.get("/send-log", protectAny, getSendLogReport);

module.exports = router;
