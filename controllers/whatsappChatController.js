// controllers/whatsappChatController.js
// API endpoints used by the CRM frontend (agents + admin)

const axios                  = require("axios");
const WhatsAppConfig         = require("../models/WhatsAppConfig");
const WhatsAppConversation   = require("../models/WhatsAppConversation");
const WhatsAppMessage        = require("../models/WhatsAppMessage");
const Lead                   = require("../models/Leads");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations
// Admin: returns ALL conversations | Agent: returns their assigned ones
// ─────────────────────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
  try {
    const { companyId, userId, role } = req.user; // from your auth middleware

    const filter = { company: companyId };

    // Agents only see their own conversations; admin sees all
    if (role !== "admin") {
      filter.assignedAgent = userId;
    }

    const conversations = await WhatsAppConversation.find(filter)
      .populate("lead",          "name mobile email status")
      .populate("assignedAgent", "name email")
      .sort({ lastMessageAt: -1 });

    res.json({ success: true, conversations });
  } catch (err) {
    console.error("getConversations error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations/:conversationId/messages
// Returns full message history for a conversation
// ─────────────────────────────────────────────────────────────────────────────
const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { companyId, userId, role } = req.user;

    // Verify the agent has access to this conversation
    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    if (role !== "admin" && conversation.assignedAgent?.toString() !== userId) {
      return res.status(403).json({ error: "Not authorised" });
    }

    const messages = await WhatsAppMessage.find({ conversation: conversationId })
      .populate("sentBy", "name")
      .sort({ waTimestamp: 1 });

    // Mark as read — reset unread count
    await WhatsAppConversation.findByIdAndUpdate(conversationId, { unreadCount: 0 });

    res.json({ success: true, messages, conversation });
  } catch (err) {
    console.error("getMessages error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send
// Agent sends a message to a WhatsApp contact
// Body: { conversationId, text }
// ─────────────────────────────────────────────────────────────────────────────
const sendMessage = async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    const { companyId, userId, role } = req.user;

    if (!text?.trim()) return res.status(400).json({ error: "Message text is required" });

    // Get conversation
    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    // Get WA config for this company
    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp is not configured for this company" });

    // Check 24-hour session window
    const now = new Date();
    const sessionOpen = conversation.sessionExpiresAt && conversation.sessionExpiresAt > now;

    if (!sessionOpen) {
      return res.status(400).json({
        error: "24-hour session window has expired. You must send a pre-approved template message to re-engage this customer.",
        code: "SESSION_EXPIRED",
      });
    }

    // ── Send message via Meta WhatsApp Cloud API ───────────────────────────
    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

    let waResponse;
    try {
      waResponse = await axios.post(
        apiUrl,
        {
          messaging_product: "whatsapp",
          recipient_type:    "individual",
          to:                conversation.waPhone,
          type:              "text",
          text: {
            preview_url: false,
            body:        text.trim(),
          },
        },
        {
          headers: {
            Authorization:  `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (apiErr) {
      const errMsg = apiErr.response?.data?.error?.message || apiErr.message;
      console.error("❌ WA send error:", errMsg);
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    const waMessageId = waResponse.data?.messages?.[0]?.id;

    // ── Save the outbound message ──────────────────────────────────────────
    const savedMsg = await WhatsAppMessage.create({
      conversation: conversationId,
      direction:    "outbound",
      body:         text.trim(),
      messageType:  "text",
      waMessageId:  waMessageId || null,
      sentBy:       userId,
      status:       "sent",
      waTimestamp:  new Date(),
    });

    // ── Update conversation ────────────────────────────────────────────────
    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage:   text.trim(),
      lastMessageAt: new Date(),
      status:        "open",
    });

    // ── Real-time: push to admin room and to other agents ─────────────────
    const io = global._io;
    if (io) {
      const payload = {
        type:           "wa_new_message",
        conversationId: conversationId.toString(),
        message: {
          _id:         savedMsg._id.toString(),
          direction:   "outbound",
          body:        text.trim(),
          messageType: "text",
          waTimestamp: new Date(),
          status:      "sent",
          sentBy:      { _id: userId, name: req.user.name },
        },
        waPhone:      conversation.waPhone,
        companyId:    companyId.toString(),
      };
      io.to("wa_admin").emit("wa_message", payload);
      io.to(`wa_agent_${conversation.assignedAgent?.toString()}`).emit("wa_message", payload);
    }

    res.json({ success: true, message: savedMsg });
  } catch (err) {
    console.error("sendMessage error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send-template
// Send a template message (used when 24h session has expired)
// Body: { conversationId, templateName, languageCode, components }
// ─────────────────────────────────────────────────────────────────────────────
const sendTemplate = async (req, res) => {
  try {
    const { conversationId, templateName, languageCode = "en_US", components = [] } = req.body;
    const { companyId, userId } = req.user;

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp not configured" });

    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

    let waResponse;
    try {
      waResponse = await axios.post(
        apiUrl,
        {
          messaging_product: "whatsapp",
          to:   conversation.waPhone,
          type: "template",
          template: {
            name:     templateName,
            language: { code: languageCode },
            components,
          },
        },
        {
          headers: {
            Authorization:  `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (apiErr) {
      const errMsg = apiErr.response?.data?.error?.message || apiErr.message;
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    const waMessageId = waResponse.data?.messages?.[0]?.id;
    const templatePreview = `[Template: ${templateName}]`;

    const savedMsg = await WhatsAppMessage.create({
      conversation:  conversationId,
      direction:     "outbound",
      body:          templatePreview,
      messageType:   "template",
      waMessageId:   waMessageId || null,
      sentBy:        userId,
      status:        "sent",
      waTimestamp:   new Date(),
      isTemplate:    true,
      templateName,
    });

    // Reopen the 24h session window
    const newExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage:      templatePreview,
      lastMessageAt:    new Date(),
      status:           "open",
      sessionExpiresAt: newExpiry,
    });

    res.json({ success: true, message: savedMsg });
  } catch (err) {
    console.error("sendTemplate error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/whatsapp/conversations/:id/assign
// Admin reassigns a conversation to a different agent
// Body: { agentId }
// ─────────────────────────────────────────────────────────────────────────────
const assignConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;

    const updated = await WhatsAppConversation.findByIdAndUpdate(
      id,
      { assignedAgent: agentId },
      { new: true }
    ).populate("assignedAgent", "name email");

    // Notify new agent via socket
    const io = global._io;
    if (io) {
      io.to(`wa_agent_${agentId}`).emit("wa_assigned", {
        conversationId: id,
        message:        "A new WhatsApp conversation has been assigned to you",
      });
    }

    res.json({ success: true, conversation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/whatsapp/conversations/:id/close
// Close a conversation (mark as resolved)
// ─────────────────────────────────────────────────────────────────────────────
const closeConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const updated = await WhatsAppConversation.findByIdAndUpdate(
      id,
      { status: "closed" },
      { new: true }
    );

    res.json({ success: true, conversation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/config
// Admin saves/updates WhatsApp Business API credentials
// Body: { phoneNumberId, accessToken, verifyToken, businessAccountId, phoneNumber }
// ─────────────────────────────────────────────────────────────────────────────
const saveConfig = async (req, res) => {
  try {
    const { phoneNumberId, accessToken, verifyToken, businessAccountId, phoneNumber, graphApiVersion } = req.body;
    const { companyId } = req.user;

    if (!phoneNumberId || !accessToken || !verifyToken) {
      return res.status(400).json({ error: "phoneNumberId, accessToken and verifyToken are required" });
    }

    const config = await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      {
        phoneNumberId,
        accessToken,
        verifyToken,
        businessAccountId: businessAccountId || "",
        phoneNumber:       phoneNumber || "",
        graphApiVersion:   graphApiVersion || "v21.0",
        isActive:          true,
        company:           companyId,
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, config: { ...config.toObject(), accessToken: "***hidden***" } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/whatsapp/config
const getConfig = async (req, res) => {
  try {
    const { companyId } = req.user;
    const config = await WhatsAppConfig.findOne({ company: companyId });
    if (!config) return res.json({ configured: false });

    res.json({
      configured:       true,
      phoneNumber:      config.phoneNumber,
      phoneNumberId:    config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      graphApiVersion:  config.graphApiVersion,
      isActive:         config.isActive,
      // Never return accessToken or verifyToken to frontend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getConversations,
  getMessages,
  sendMessage,
  sendTemplate,
  assignConversation,
  closeConversation,
  saveConfig,
  getConfig,
};