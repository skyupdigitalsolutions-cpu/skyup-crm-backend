// controllers/whatsappChatController.js
// API endpoints used by the CRM frontend (agents + admin)

const axios                  = require("axios");
const WhatsAppConfig         = require("../models/WhatsAppConfig");
const WhatsAppConversation   = require("../models/WhatsAppConversation");
const crypto                  = require("crypto");
const WhatsAppMessage        = require("../models/WhatsAppMessage");
const Lead                   = require("../models/Leads");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations
// ─────────────────────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
  try {
    const { companyId, userId, role } = req.user;

    const filter = { company: companyId };

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
// ─────────────────────────────────────────────────────────────────────────────
const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { companyId, userId, role } = req.user;

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    if (role !== "admin" && conversation.assignedAgent?.toString() !== userId) {
      return res.status(403).json({ error: "Not authorised" });
    }

    const messages = await WhatsAppMessage.find({ conversation: conversationId })
      .populate("sentBy", "name")
      .sort({ waTimestamp: 1 });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, { unreadCount: 0 });

    res.json({ success: true, messages, conversation });
  } catch (err) {
    console.error("getMessages error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send
// Send a plain text message within the 24h session window
// ─────────────────────────────────────────────────────────────────────────────
const sendMessage = async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    const { companyId, userId, role } = req.user;

    if (!text?.trim()) return res.status(400).json({ error: "Message text is required" });

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp is not configured for this company" });

    // Check 24-hour session window
    const now         = new Date();
    const sessionOpen = conversation.sessionExpiresAt && conversation.sessionExpiresAt > now;

    if (!sessionOpen) {
      return res.status(400).json({
        error: "24-hour session window has expired. You must send a pre-approved template message to re-engage this customer.",
        code:  "SESSION_EXPIRED",
      });
    }

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = config.msg91IntegratedNumber  || process.env.MSG91_INTEGRATED_NUMBER;

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({
        error: "MSG91 credentials missing. Set MSG91_AUTH_KEY and MSG91_INTEGRATED_NUMBER in your .env",
      });
    }

    let waMessageId;
    try {
      if (provider === "msg91") {
        // ── MSG91 session (text) message ──────────────────────────────────────
        // The session message API uses a completely different flat payload
        // compared to the /bulk/ template API.
        // Correct endpoint: control.msg91.com (NOT api.msg91.com)
        // Correct payload: { integrated_number, recipient_number, content_type, text }
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/",
          {
            integrated_number: senderNumber,
            recipient_number:  conversation.waPhone,
            content_type:      "text",
            text:              text.trim(),
          },
          {
            headers: {
              Authkey:         authKey,
              "Content-Type":  "application/json",
              "accept":        "application/json",
            },
          }
        );
        // MSG91 session API often returns no message ID — generate a unique fallback
        // so the sparse unique index on waMessageId never receives two nulls (E11000)
        waMessageId =
          msg91Response.data?.data?.id  ||
          msg91Response.data?.requestId ||
          `out_${Date.now()}_${crypto.randomUUID()}`;
        console.log(`✅ MSG91 send success → ${conversation.waPhone}`, msg91Response.data);
      } else {
        // ── Meta Cloud API fallback ───────────────────────────────────────────
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            recipient_type:    "individual",
            to:                conversation.waPhone,
            type:              "text",
            text: { preview_url: false, body: text.trim() },
          },
          {
            headers: {
              Authorization:  `Bearer ${config.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        waMessageId = metaResponse.data?.messages?.[0]?.id || `out_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      const errData = apiErr.response?.data;
      const errMsg  = errData?.message || errData?.error?.message || apiErr.message;
      console.error("❌ WA send error:", JSON.stringify(errData || errMsg));
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    const savedMsg = await WhatsAppMessage.create({
      conversation: conversationId,
      direction:    "outbound",
      body:         text.trim(),
      messageType:  "text",
      waMessageId,          // always a real string — never null (avoids E11000)
      sentBy:       userId,
      status:       "sent",
      waTimestamp:  new Date(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage:      text.trim(),
      lastMessageAt:    new Date(),
      status:           "open",
      // Refresh session window — the 24h clock resets each time we send
      sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

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
        waPhone:   conversation.waPhone,
        companyId: companyId.toString(),
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
// Send a template message when 24h session has expired
// ─────────────────────────────────────────────────────────────────────────────
const sendTemplate = async (req, res) => {
  try {
    const { conversationId, templateName, languageCode = "en_US", components = [] } = req.body; // en_US is the correct MSG91 default
    const { companyId, userId } = req.user;

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp not configured" });

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = config.msg91IntegratedNumber  || process.env.MSG91_INTEGRATED_NUMBER;

    let waMessageId;
    try {
      if (provider === "msg91") {
        if (!authKey || !senderNumber) {
          return res.status(500).json({ error: "MSG91 credentials missing in .env" });
        }
        const msg91Response = await axios.post(
          "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          {
            integrated_number: senderNumber,
            content_type:      "template",
            payload: [
              {
                to:   conversation.waPhone,
                type: "template",
                template: {
                  name:       templateName,
                  language:   { code: languageCode },
                  components: components,
                },
              },
            ],
          },
          {
            headers: {
              authkey:        authKey,
              "Content-Type": "application/json",
            },
          }
        );
        waMessageId = msg91Response.data?.data?.[0]?.id || `tmpl_${Date.now()}_${crypto.randomUUID()}`;
        console.log(`✅ MSG91 template send → ${conversation.waPhone} [${templateName}]`);
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            to:   conversation.waPhone,
            type: "template",
            template: { name: templateName, language: { code: languageCode }, components },
          },
          {
            headers: {
              Authorization:  `Bearer ${config.accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        waMessageId = metaResponse.data?.messages?.[0]?.id;
      }
    } catch (apiErr) {
      const errData = apiErr.response?.data;
      const errMsg  = errData?.message || errData?.error?.message || apiErr.message;
      console.error("❌ WA template send error:", JSON.stringify(errData || errMsg));
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    const templatePreview = `[Template: ${templateName}]`;

    const savedMsg = await WhatsAppMessage.create({
      conversation:  conversationId,
      direction:     "outbound",
      body:          templatePreview,
      messageType:   "template",
      waMessageId,          // always a real string — never null (avoids E11000)
      sentBy:        userId,
      status:        "sent",
      waTimestamp:   new Date(),
      isTemplate:    true,
      templateName,
    });

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
// ─────────────────────────────────────────────────────────────────────────────
const assignConversation = async (req, res) => {
  try {
    const { id }      = req.params;
    const { agentId } = req.body;

    const updated = await WhatsAppConversation.findByIdAndUpdate(
      id,
      { assignedAgent: agentId },
      { new: true }
    ).populate("assignedAgent", "name email");

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
// ─────────────────────────────────────────────────────────────────────────────
const saveConfig = async (req, res) => {
  try {
    const {
      provider = "msg91",
      msg91AuthKey,
      msg91IntegratedNumber,
      phoneNumberId,
      accessToken,
      verifyToken,
      businessAccountId,
      graphApiVersion,
      phoneNumber,
    } = req.body;
    const { companyId } = req.user;

    if (provider !== "msg91") {
      if (!phoneNumberId || !accessToken || !verifyToken) {
        return res.status(400).json({ error: "phoneNumberId, accessToken and verifyToken are required for Meta provider" });
      }
    }

    const updateData = {
      provider,
      phoneNumber: phoneNumber || "",
      isActive:    true,
      company:     companyId,
    };

    if (provider === "msg91") {
      updateData.msg91AuthKey          = msg91AuthKey          || "";
      updateData.msg91IntegratedNumber = msg91IntegratedNumber || "";
    } else {
      updateData.phoneNumberId      = phoneNumberId     || "";
      updateData.accessToken        = accessToken       || "";
      updateData.verifyToken        = verifyToken       || "";
      updateData.businessAccountId  = businessAccountId || "";
      updateData.graphApiVersion    = graphApiVersion   || "v21.0";
    }

    const config = await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      updateData,
      { upsert: true, new: true }
    );

    const safeConfig = { ...config.toObject() };
    if (safeConfig.msg91AuthKey) safeConfig.msg91AuthKey = "***hidden***";
    if (safeConfig.accessToken)  safeConfig.accessToken  = "***hidden***";

    res.json({ success: true, config: safeConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/config
// ─────────────────────────────────────────────────────────────────────────────
const getConfig = async (req, res) => {
  try {
    const { companyId } = req.user;
    const config = await WhatsAppConfig.findOne({ company: companyId });

    if (!config) {
      const envAuthKey = process.env.MSG91_AUTH_KEY;
      const envNumber  = process.env.MSG91_INTEGRATED_NUMBER;
      if (envAuthKey && envNumber) {
        return res.json({
          configured:            true,
          provider:              "msg91",
          msg91Configured:       true,
          msg91IntegratedNumber: envNumber,
          source:                "env",
        });
      }
      return res.json({ configured: false });
    }

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = config.msg91IntegratedNumber  || process.env.MSG91_INTEGRATED_NUMBER;

    res.json({
      configured:            true,
      provider,
      phoneNumber:           config.phoneNumber,
      isActive:              config.isActive,
      msg91Configured:       !!(authKey && senderNumber),
      msg91IntegratedNumber: senderNumber || "",
      ...(provider === "meta" && {
        phoneNumberId:     config.phoneNumberId,
        businessAccountId: config.businessAccountId,
        graphApiVersion:   config.graphApiVersion,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/start-conversation
// Admin initiates a new WhatsApp conversation with a client number.
// Since no session exists, a template message MUST be sent first.
// ─────────────────────────────────────────────────────────────────────────────
const startConversation = async (req, res) => {
  try {
    const {
      phone,              // client number e.g. "919876543210" (with country code, no +)
      contactName = "",   // optional display name
      templateName,       // MSG91 pre-approved template name (required)
      languageCode = "en_US",  // FIX: MSG91 rejects bare "en" — must be "en_US" or "en_GB"
      components   = [],  // template variable components
    } = req.body;

    const { companyId, userId } = req.user;

    // ── Validate phone ────────────────────────────────────────────────────────
    if (!phone?.trim()) {
      return res.status(400).json({ error: "Phone number is required" });
    }
    // Strip any non-digit characters and leading +
    const cleanPhone = phone.trim().replace(/\D/g, "");
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({ error: "Invalid phone number. Include country code (e.g. 919876543210)" });
    }

    if (!templateName?.trim()) {
      return res.status(400).json({
        error: "A pre-approved template name is required to start a new conversation (WhatsApp rule: first message must be a template)",
        code:  "TEMPLATE_REQUIRED",
      });
    }

    // ── Load config ───────────────────────────────────────────────────────────
    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) {
      return res.status(400).json({ error: "WhatsApp is not configured for this company" });
    }

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = config.msg91IntegratedNumber  || process.env.MSG91_INTEGRATED_NUMBER;

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({ error: "MSG91 credentials missing" });
    }

    // ── Find or create conversation ───────────────────────────────────────────
    let conversation = await WhatsAppConversation.findOne({
      waPhone:  cleanPhone,
      company:  companyId,
    });

    // Try to link a known lead by phone number
    const lead = await Lead.findOne({ mobile: { $regex: cleanPhone.slice(-10) } });

    if (!conversation) {
      conversation = await WhatsAppConversation.create({
        waPhone:       cleanPhone,
        contactName:   contactName.trim() || lead?.name || "",
        company:       companyId,
        assignedAgent: userId,
        lead:          lead?._id || null,
        status:        "open",
        lastMessage:   "",
        lastMessageAt: new Date(),
        sessionExpiresAt: null, // session opens only after client replies
      });
    }

    // ── Send template via MSG91 ───────────────────────────────────────────────
    let waMessageId;
    try {
      if (provider === "msg91") {
        const msg91Response = await axios.post(
          "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          {
            integrated_number: senderNumber,
            content_type:      "template",
            payload: [
              {
                to:   cleanPhone,
                type: "template",
                template: {
                  name:       templateName.trim(),
                  language:   { code: languageCode },
                  components: components,
                },
              },
            ],
          },
          {
            headers: {
              authkey:        authKey,
              "Content-Type": "application/json",
            },
          }
        );
        waMessageId =
          msg91Response.data?.data?.[0]?.id ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
        console.log(`✅ MSG91 initiation template sent → ${cleanPhone}`, msg91Response.data);
      } else {
        // Meta Cloud API
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            to:   cleanPhone,
            type: "template",
            template: {
              name:       templateName.trim(),
              language:   { code: languageCode },
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
        waMessageId =
          metaResponse.data?.messages?.[0]?.id ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      const errData = apiErr.response?.data;
      const errMsg  = errData?.message || errData?.error?.message || apiErr.message;
      console.error("❌ start-conversation template error:", JSON.stringify(errData || errMsg));
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    // ── Save the outbound template message ────────────────────────────────────
    const templatePreview = `[Template: ${templateName}]`;

    const savedMsg = await WhatsAppMessage.create({
      conversation:  conversation._id,
      direction:     "outbound",
      body:          templatePreview,
      messageType:   "template",
      waMessageId,
      sentBy:        userId,
      status:        "sent",
      waTimestamp:   new Date(),
      isTemplate:    true,
      templateName:  templateName.trim(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:   templatePreview,
      lastMessageAt: new Date(),
      status:        "open",
    });

    // ── Broadcast to admin socket room so UI updates live ─────────────────────
    const io = global._io;
    if (io) {
      io.to("wa_admin").emit("wa_new_conversation", {
        conversation: await WhatsAppConversation.findById(conversation._id)
          .populate("lead",          "name mobile email status")
          .populate("assignedAgent", "name email"),
      });
      io.to("wa_admin").emit("wa_message", {
        type:           "wa_new_message",
        conversationId: conversation._id.toString(),
        message: {
          _id:         savedMsg._id.toString(),
          direction:   "outbound",
          body:        templatePreview,
          messageType: "template",
          waTimestamp: new Date(),
          status:      "sent",
          sentBy:      { _id: userId, name: req.user.name },
        },
        waPhone:   cleanPhone,
        companyId: companyId.toString(),
      });
    }

    res.json({ success: true, conversation, message: savedMsg });
  } catch (err) {
    console.error("startConversation error:", err.message);
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
  startConversation,
};