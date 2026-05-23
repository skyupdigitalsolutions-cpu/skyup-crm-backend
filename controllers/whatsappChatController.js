// controllers/whatsappChatController.js
// API endpoints used by the CRM frontend (agents + admin)

const axios                  = require("axios");
const WhatsAppConfig         = require("../models/WhatsAppConfig");
const WhatsAppConversation   = require("../models/WhatsAppConversation");
const crypto                  = require("crypto");
const WhatsAppMessage        = require("../models/WhatsAppMessage");
const Lead                   = require("../models/Leads");
const { normalizePhone: _sharedNormalizePhone } = require("../utils/normalizePhone");

// ─────────────────────────────────────────────────────────────────────────────
// normalizePhone — ensures every WhatsApp number has the 91 country code.
// Numbers from Facebook Ads, Google Ads, and website forms often arrive as
// 10-digit local numbers (e.g. "9876543210") without the country prefix.
// MSG91 and Meta both require the full E.164-style number (e.g. "919876543210").
//
// Rules:
//   "9876543210"      → "919876543210"   (10 digits → prefix 91)
//   "919876543210"    → "919876543210"   (already correct, leave as-is)
//   "+919876543210"   → "919876543210"   (strip + only)
//   "09876543210"     → "919876543210"   (leading 0 → replace with 91)
//   "00919876543210"  → "919876543210"   (00 prefix → strip)
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  // Strip everything except digits
  let digits = String(raw).replace(/\D/g, "");
  // Strip leading double-zero international prefix (0091...)
  if (digits.startsWith("0091")) digits = digits.slice(4);
  // Strip leading single zero (091...)
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  // If 10 digits assume Indian local number — prepend 91
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

// ─────────────────────────────────────────────────────────────────────────────
// safeWaPhone — always returns a clean digits-only phone for WA API calls,
// even if the value stored in DB still has a leading "+".
// This is the fix for numbers that were manually updated in MongoDB Atlas
// but may have been stored as "+919XXXXXXXXXX" instead of "919XXXXXXXXXX".
// ─────────────────────────────────────────────────────────────────────────────
function safeWaPhone(stored) {
  return normalizePhone(stored);
}

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

    if (role !== "admin" && role !== "super_admin") {
      const isAssigned = conversation.assignedAgent?.toString() === userId;
      // Also allow if the employee owns the lead linked to this conversation
      // (handles the case where the webhook assigned a different round-robin agent
      //  but the conversation belongs to this employee's lead)
      let ownsLead = false;
      if (!isAssigned && conversation.lead) {
        const lead = await Lead.findOne({ _id: conversation.lead, user: userId, company: companyId }).lean();
        ownsLead = !!lead;
      }
      if (!isAssigned && !ownsLead) {
        return res.status(403).json({ error: "Not authorised" });
      }
      // If employee owns the lead but isn't the assigned agent, fix that now
      if (!isAssigned && ownsLead) {
        await WhatsAppConversation.findByIdAndUpdate(conversationId, { assignedAgent: userId });
      }
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
    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({
        error: "MSG91 credentials not configured for your company. Go to Communications → Integrations → WhatsApp/SMS and connect MSG91.",
      });
    }

    // Always sanitize waPhone before calling external API —
    // numbers stored in DB may have a leading "+" from manual Atlas edits
    const recipientPhone = safeWaPhone(conversation.waPhone);

    let waMessageId;
    try {
      if (provider === "msg91") {
        // Plain text reply — uses control.msg91.com single-message endpoint
        // This is the endpoint that was confirmed working in production logs
        const msg91Payload = {
          integrated_number: senderNumber,
          recipient_number:  recipientPhone,
          content_type:      "text",
          text:              text.trim(),
        };
        console.log("📤 MSG91 sendMessage request:", JSON.stringify(msg91Payload, null, 2));
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/",
          msg91Payload,
          {
            headers: {
              authkey:        authKey,
              "Content-Type": "application/json",
              accept:         "application/json",
            },
          }
        );
        waMessageId =
          msg91Response.data?.data?.message_uuid ||
          msg91Response.data?.data?.id ||
          msg91Response.data?.requestId ||
          `out_${Date.now()}_${crypto.randomUUID()}`;
        console.log(`✅ MSG91 send success → ${recipientPhone}`, JSON.stringify(msg91Response.data, null, 2));
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            recipient_type:    "individual",
            to:                recipientPhone,
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
      waMessageId,
      sentBy:       userId,
      status:       "sent",
      waTimestamp:  new Date(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage:      text.trim(),
      lastMessageAt:    new Date(),
      status:           "open",
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
          sentBy:      { _id: userId, name: req.admin?.name || req.user?.name || 'Admin' },
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
    const { conversationId, templateName, languageCode = "en_US", components: reqComponents = [] } = req.body;
    const { companyId, userId } = req.user;

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp not configured" });

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    // Sanitize stored waPhone — may have a leading "+" from manual DB edits
    const recipientPhone = safeWaPhone(conversation.waPhone);

    let waMessageId;
    try {
      if (provider === "msg91") {
        if (!authKey || !senderNumber) {
          return res.status(500).json({ error: "MSG91 credentials not configured. Go to Communications → Integrations → WhatsApp/SMS and connect MSG91." });
        }
        const resolvedLangCode = languageCode || "en";
        const namespace = config.msg91Namespace || "";

        // BUG FIX: Build components for MSG91 — use the contact name from the conversation.
        // Do NOT shadow or discard reqComponents from the request body.
        // MSG91 expects components as an OBJECT (key-value map), not an array.
        // If the template has no variables, send an empty object {}.
        let msg91Components = {};
        if (conversation.contactName && conversation.contactName.trim()) {
          msg91Components = {
            body_1: {
              type:           "text",
              value:          conversation.contactName.trim(),
              
            },
          };
        }
        // If caller explicitly passed structured components, prefer those
        if (reqComponents && Array.isArray(reqComponents) && reqComponents.length > 0) {
          // Convert Meta-style array components to MSG91 object format if needed
          msg91Components = reqComponents;
        }

        const requestPayload = {
          integrated_number: senderNumber,
          content_type:      "template",
          payload: {
            messaging_product: "whatsapp",
            type:              "template",
            template: {
              name:     templateName,
              language: { code: resolvedLangCode, policy: "deterministic" },
              ...(namespace ? { namespace } : {}),
              to_and_components: [{ to: [recipientPhone], components: msg91Components }],
            },
          },
        };

        console.log("📤 MSG91 sendTemplate request:", JSON.stringify(requestPayload, null, 2));

        // BUG FIX: Use control.msg91.com (same host as plain-text send) — api.msg91.com
        // returns authentication errors for many accounts even with valid keys.
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          requestPayload,
          { headers: { authkey: authKey, "Content-Type": "application/json" } }
        );
        waMessageId = msg91Response.data?.data?.[0]?.id || msg91Response.data?.requestId || `tmpl_${Date.now()}_${crypto.randomUUID()}`;
        console.log(`✅ MSG91 template send → ${recipientPhone} [${templateName}]`, JSON.stringify(msg91Response.data, null, 2));
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaTmpl = { name: templateName, language: { code: languageCode } };
        if (reqComponents && reqComponents.length > 0) metaTmpl.components = reqComponents;
        const metaResponse = await axios.post(
          apiUrl,
          { messaging_product: "whatsapp", to: recipientPhone, type: "template", template: metaTmpl },
          { headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" } }
        );
        waMessageId = metaResponse.data?.messages?.[0]?.id;
      }
    } catch (apiErr) {
      const errData = apiErr.response?.data;
      const errMsg  = errData?.message || errData?.error?.message || apiErr.message;
      console.error("❌ WA template send error:", JSON.stringify(errData || errMsg));
      console.error("❌ HTTP status:", apiErr.response?.status);
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }

    const templatePreview = `[Template: ${templateName}]`;

    const savedMsg = await WhatsAppMessage.create({
      conversation:  conversationId,
      direction:     "outbound",
      body:          templatePreview,
      messageType:   "template",
      waMessageId,
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
// DELETE /api/whatsapp/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.user;

    if (role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete conversations" });
    }

    await WhatsAppMessage.deleteMany({ conversation: id });
    await WhatsAppConversation.findByIdAndDelete(id);

    res.json({ success: true });
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
      // No config saved for this company — they must set up their own credentials
      return res.json({ configured: false });
    }

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

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
// ─────────────────────────────────────────────────────────────────────────────
const startConversation = async (req, res) => {
  try {
    const {
      phone,
      contactName = "",
      templateName,
      languageCode = "en_US",
      components   = [],
    } = req.body;

    console.log("🚀 startConversation called with:", JSON.stringify({ phone, contactName, templateName, languageCode }, null, 2));

    const isAdmin   = !!req.admin;
    const companyId = isAdmin
      ? (req.admin.company?._id || req.admin.company)
      : req.user.company;
    const userId    = isAdmin ? null : req.user._id;

    if (!phone?.trim()) {
      return res.status(400).json({ error: "Phone number is required" });
    }
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({ error: "Invalid phone number. Include country code (e.g. 919876543210)" });
    }

    if (!templateName?.trim()) {
      return res.status(400).json({
        error: "A pre-approved template name is required to start a new conversation (WhatsApp rule: first message must be a template)",
        code:  "TEMPLATE_REQUIRED",
      });
    }

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) {
      return res.status(400).json({ error: "WhatsApp is not configured for this company" });
    }

    const provider     = config.provider || "msg91";
    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({ error: "MSG91 credentials missing" });
    }

    // FIX: always scope lead lookup to this company; the regex previously had no company
    // filter and could return a lead from a different tenant, or null when it shouldn't.
    const lastTen = cleanPhone.slice(-10);
    const lead = await Lead.findOne({
      company: companyId,
      $or: [
        { mobile: cleanPhone },
        { mobile: lastTen },
        { mobile: `+${cleanPhone}` },
      ],
    });


    let waMessageId;
    try {
      if (provider === "msg91") {
        const resolvedLangCode = languageCode || "en";
        const namespace = config.msg91Namespace || "";

        // BUG FIX: `components` from req.body was being shadowed by a new `const components`
        // built from contactName. This meant the frontend's component values were lost.
        // Now we build msg91Components correctly without shadowing the outer variable.
        let msg91Components = {};
        if (contactName && contactName.trim()) {
          msg91Components = {
            body_1: {
              type:           "text",
              value:          contactName.trim(),
              
            },
          };
        }
        // If caller passed explicit components array (e.g. from bulk panel), prefer those
        if (components && Array.isArray(components) && components.length > 0) {
          msg91Components = components;
        }

        const requestPayload = {
          integrated_number: senderNumber,
          content_type:      "template",
          payload: {
            messaging_product: "whatsapp",
            type:              "template",
            template: {
              name:     templateName.trim(),
              language: { code: resolvedLangCode, policy: "deterministic" },
              ...(namespace ? { namespace } : {}),
              to_and_components: [{ to: [cleanPhone], components: msg91Components }],
            },
          },
        };

        console.log("📤 MSG91 start-conversation request:", JSON.stringify(requestPayload, null, 2));

        // BUG FIX: Use control.msg91.com — api.msg91.com returns auth errors for many accounts.
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          requestPayload,
          {
            headers: {
              authkey:        authKey,
              "Content-Type": "application/json",
            },
          }
        );
        waMessageId =
          msg91Response.data?.data?.[0]?.id ||
          msg91Response.data?.requestId ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
        console.log("✅ MSG91 start-conversation FULL RESPONSE:", JSON.stringify(msg91Response.data, null, 2));
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaPayload = {
          messaging_product: "whatsapp",
          to:   cleanPhone,
          type: "template",
          template: {
            name:     templateName.trim(),
            language: { code: languageCode },
          },
        };
        if (components && components.length > 0) {
          metaPayload.template.components = components;
        }
        const metaResponse = await axios.post(apiUrl, metaPayload, {
          headers: {
            Authorization:  `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        });
        waMessageId =
          metaResponse.data?.messages?.[0]?.id ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      const errData = apiErr.response?.data;
      const errMsg  = errData?.message || errData?.error?.message || apiErr.message;
      console.error("❌ start-conversation template FULL ERROR:", JSON.stringify(errData, null, 2));
      console.error("❌ HTTP status:", apiErr.response?.status);
      console.error("❌ Error message:", errMsg);
      return res.status(502).json({ error: `WhatsApp API error: ${errMsg}` });
    }


    let conversation = await WhatsAppConversation.findOne({
      waPhone:  cleanPhone,
      company:  companyId,
    });

    if (!conversation) {
      conversation = await WhatsAppConversation.create({
        waPhone:          cleanPhone,
        contactName:      contactName.trim() || lead?.name || "",
        company:          companyId,
        assignedAgent:    userId,
        lead:             lead?._id || null,
        status:           "open",
        lastMessage:      "",
        lastMessageAt:    new Date(),
        sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    } else {
      // FIX: backfill lead and assignedAgent if the existing conversation is missing them.
      // This happens when a previous startConversation failed to find the lead (null company
      // filter bug) or when the webhook created the conversation before the employee opened it.
      const patch = {};
      if (!conversation.lead && lead?._id)    patch.lead          = lead._id;
      if (!conversation.assignedAgent && userId) patch.assignedAgent = userId;
      if (Object.keys(patch).length) {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
        const convPlain = typeof conversation.toObject === "function" ? conversation.toObject() : conversation;
        conversation = Object.assign({}, convPlain, patch);
      }
    }

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

    const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      templatePreview,
      lastMessageAt:    new Date(),
      status:           "open",
      sessionExpiresAt: sessionExpiry,
    });

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
          sentBy:      { _id: userId, name: req.admin?.name || req.user?.name || 'Admin' },
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: send a template to one phone number via MSG91 / Meta
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: send a template to one phone number via MSG91 / Meta
// ─────────────────────────────────────────────────────────────────────────────
const _sendTemplateToPhone = async ({ cleanPhone, templateName, languageCode, config, authKey, senderNumber, contactName = "" }) => {
  const provider = config.provider || "msg91";

  if (provider === "msg91") {
    const namespace = config.msg91Namespace || "";
    // BUG FIX: Use named variable msg91Components to avoid any shadowing confusion.
    // MSG91 expects components as an OBJECT (key-value map), not an array.
    // Empty object {} is correct when template has no variables.
    const msg91Components = contactName.trim()
      ? { body_1: { type: "text", value: contactName.trim() } }
      : {};

    // BUG FIX: Use control.msg91.com — api.msg91.com was causing auth failures.
    const resp = await axios.post(
      "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      {
        integrated_number: senderNumber,
        content_type:      "template",
        payload: {
          messaging_product: "whatsapp",
          type:              "template",
          template: {
            name:     templateName.trim(),
            language: { code: languageCode || "en", policy: "deterministic" },
            ...(namespace ? { namespace } : {}),
            to_and_components: [{ to: [cleanPhone], components: msg91Components }],
          },
        },
      },
      { headers: { authkey: authKey, "Content-Type": "application/json" } }
    );
    return (
      resp.data?.data?.[0]?.id ||
      resp.data?.requestId ||
      `bulk_${Date.now()}_${crypto.randomUUID()}`
    );
  } else {
    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
    const resp = await axios.post(
      apiUrl,
      {
        messaging_product: "whatsapp",
        to:   cleanPhone,
        type: "template",
        template: { name: templateName.trim(), language: { code: languageCode } },
      },
      { headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" } }
    );
    return resp.data?.messages?.[0]?.id || `bulk_${Date.now()}_${crypto.randomUUID()}`;
  }
};

const _saveConversationAndMessage = async ({ cleanPhone, contactName, companyId, userId, leadId, templateName, waMessageId }) => {
  const templatePreview = `[Template: ${templateName}]`;

  let conversation = await WhatsAppConversation.findOne({ waPhone: cleanPhone, company: companyId });
  if (!conversation) {
    conversation = await WhatsAppConversation.create({
      waPhone:          cleanPhone,
      contactName:      contactName || "",
      company:          companyId,
      assignedAgent:    userId,
      lead:             leadId || null,
      status:           "open",
      lastMessage:      templatePreview,
      lastMessageAt:    new Date(),
      sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  } else {
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status:           "open",
      lastMessage:      templatePreview,
      lastMessageAt:    new Date(),
    });
  }

  await WhatsAppMessage.create({
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

  return conversation;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/bulk-send
// Send a template to ALL leads in a company (or filtered by campaign)
// Body: { templateName, languageCode, campaign? }
// ─────────────────────────────────────────────────────────────────────────────
const bulkSendToLeads = async (req, res) => {
  try {
    const { templateName, languageCode = "en_US", campaign } = req.body;
    const { companyId, userId } = req.user;

    if (!templateName?.trim()) {
      return res.status(400).json({ error: "templateName is required" });
    }

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp is not configured for this company" });

    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (!authKey || !senderNumber) {
      return res.status(500).json({ error: "MSG91 credentials missing" });
    }

    // Build filter — optionally restrict to a campaign
    const filter = {
      company: companyId,
      mobile:  { $exists: true, $ne: "" },
    };
    if (campaign && campaign.trim()) {
      filter.campaign = campaign.trim();
    }

    const leads = await Lead.find(filter).lean();

    if (leads.length === 0) {
      return res.json({ success: true, sent: 0, failed: 0, total: 0, results: [] });
    }

    const results = [];
    let sent = 0;
    let failed = 0;

    for (const lead of leads) {
      const cleanPhone = normalizePhone(lead.mobile);
      if (cleanPhone.length < 10) {
        results.push({ leadId: lead._id, name: lead.name, phone: lead.mobile, status: "skipped", reason: "Invalid phone number" });
        failed++;
        continue;
      }

      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone, templateName, languageCode, config, authKey, senderNumber,
          contactName: lead.name,
        });

        await _saveConversationAndMessage({
          cleanPhone, contactName: lead.name, companyId, userId,
          leadId: lead._id, templateName, waMessageId,
        });

        results.push({ leadId: lead._id, name: lead.name, phone: cleanPhone, status: "sent" });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({ leadId: lead._id, name: lead.name, phone: cleanPhone, status: "failed", reason: errMsg });
        failed++;
      }

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`📣 Bulk WA send complete: ${sent} sent, ${failed} failed out of ${leads.length} leads`);
    res.json({ success: true, sent, failed, total: leads.length, results });

  } catch (err) {
    console.error("bulkSendToLeads error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/bulk-send-csv
// Send a template to an arbitrary list of phone numbers from CSV
// Body: { recipients: [{name, phone}], templateName, languageCode }
// ─────────────────────────────────────────────────────────────────────────────
const bulkSendCSV = async (req, res) => {
  try {
    const { recipients, templateName, languageCode = "en_US" } = req.body;
    const { companyId, userId } = req.user;

    if (!templateName?.trim()) {
      return res.status(400).json({ error: "templateName is required" });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array is required and must not be empty" });
    }

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp is not configured for this company" });

    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (!authKey || !senderNumber) {
      return res.status(500).json({ error: "MSG91 credentials missing" });
    }

    const results = [];
    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      const cleanPhone = normalizePhone(recipient.phone);
      const contactName = recipient.name || "";

      if (cleanPhone.length < 10) {
        results.push({ name: contactName, phone: recipient.phone, status: "skipped", reason: "Invalid phone number" });
        failed++;
        continue;
      }

      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone, templateName, languageCode, config, authKey, senderNumber,
          contactName,
        });

        // Try to link to an existing lead by phone
        const lead = await Lead.findOne({
          company: companyId,
          mobile:  { $regex: cleanPhone.slice(-10) },
        }).lean();

        await _saveConversationAndMessage({
          cleanPhone, contactName, companyId, userId,
          leadId: lead?._id || null, templateName, waMessageId,
        });

        results.push({ name: contactName, phone: cleanPhone, status: "sent" });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({ name: contactName, phone: cleanPhone, status: "failed", reason: errMsg });
        failed++;
      }

      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`📣 Bulk WA CSV send: ${sent} sent, ${failed} failed out of ${recipients.length}`);
    res.json({ success: true, sent, failed, total: recipients.length, results });

  } catch (err) {
    console.error("bulkSendCSV error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/leads
// ─────────────────────────────────────────────────────────────────────────────
const getLeadsForWhatsApp = async (req, res) => {
  try {
    const isAdmin   = !!req.admin;
    const companyId = isAdmin
      ? (req.admin.company?._id || req.admin.company)
      : req.user.company;

    const filter = {
      company: companyId,
      mobile:  { $exists: true, $ne: "" },
    };
    if (!isAdmin) {
      filter.user = req.user._id;
    }

    const leads = await Lead.find(filter)
      .select("name mobile email status source campaign date createdAt user")
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .lean();

    const phones = leads.map(l => (l.mobile || "").replace(/\D/g, ""));
    const existingConvs = await WhatsAppConversation.find({
      company:  companyId,
      waPhone:  { $in: phones },
    }).select("waPhone _id status").lean();

    const convByPhone = {};
    for (const c of existingConvs) {
      convByPhone[c.waPhone] = c;
    }

    const result = leads.map(l => {
      const cleanPhone = normalizePhone(l.mobile);
      const existingConv = convByPhone[cleanPhone] || null;
      return {
        ...l,
        cleanPhone,
        existingConversationId: existingConv?._id || null,
        existingConversationStatus: existingConv?.status || null,
      };
    });

    res.json({ success: true, leads: result });
  } catch (err) {
    console.error("getLeadsForWhatsApp error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversation-by-lead/:leadId
// Returns the WhatsApp conversation for a given lead (if one exists).
// Used by the employee chat panel — leads from /lead/my-leads have no
// conversationId directly, so the frontend must look it up here.
// Auth: protectAny (admin or employee token)
// ─────────────────────────────────────────────────────────────────────────────
const getConversationByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { companyId, userId, role } = req.user;

    // Employees can only see conversations for their own leads
    const lead = await Lead.findOne({ _id: leadId, company: companyId }).lean();
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    if (role !== "admin" && role !== "super_admin") {
      if (lead.user?.toString() !== userId) {
        return res.status(403).json({ error: "This lead is not assigned to you" });
      }
    }

    // FIX: search by lead._id first, then fall back to phone number match.
    // Conversations created via startConversation may have lead: null if the
    // original lead lookup failed (missing company scope bug). In that case,
    // find the conversation by the lead's normalised phone number so employees
    // can always open their chat history after a page refresh.
    let conversation = await WhatsAppConversation.findOne({
      lead:    leadId,
      company: companyId,
    }).sort({ lastMessageAt: -1, createdAt: -1 });

    if (!conversation && lead.mobile) {
      // Normalise the phone the same way the rest of the system does
      let digits = String(lead.mobile).replace(/\D/g, "");
      if (digits.startsWith("0091")) digits = digits.slice(4);
      if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
      if (digits.length === 10) digits = "91" + digits;
      const lastTen = digits.slice(-10);

      conversation = await WhatsAppConversation.findOne({
        company: companyId,
        $or: [
          { waPhone: digits },
          { waPhone: lastTen },
        ],
      }).sort({ lastMessageAt: -1, createdAt: -1 });

      // Backfill the lead reference so future lookups use the fast path
      if (conversation && !conversation.lead) {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
          lead: leadId,
          ...(!conversation.assignedAgent && userId ? { assignedAgent: userId } : {}),
        });
      }
    }

    if (!conversation) {
      return res.json({ success: true, conversation: null });
    }

    res.json({ success: true, conversation });
  } catch (err) {
    console.error("getConversationByLead error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/employee-bulk-send
// Employee sends a WhatsApp template blast to ONLY their own assigned leads.
// Body: { templateName, languageCode? }
// Auth: user/employee token (protect middleware)
// ─────────────────────────────────────────────────────────────────────────────
const employeeBulkSend = async (req, res) => {
  try {
    const { templateName, languageCode = "en_US" } = req.body;
    const { _id: userId, company: companyId } = req.user;

    if (!templateName?.trim()) {
      return res.status(400).json({ error: "templateName is required" });
    }

    // Use the company's shared WhatsApp config (set up by admin)
    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) {
      return res.status(400).json({ error: "WhatsApp is not configured for this company. Ask your admin to set it up." });
    }

    const authKey      = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (!authKey || !senderNumber) {
      return res.status(500).json({ error: "MSG91 credentials missing in company config" });
    }

    // Fetch ONLY leads assigned to this employee
    const leads = await Lead.find({
      company: companyId,
      user:    userId,
      mobile:  { $exists: true, $ne: "" },
    }).lean();

    if (leads.length === 0) {
      return res.json({ success: true, sent: 0, failed: 0, total: 0, results: [] });
    }

    const results = [];
    let sent   = 0;
    let failed = 0;

    for (const lead of leads) {
      const cleanPhone = normalizePhone(lead.mobile);
      if (cleanPhone.length < 10) {
        results.push({ leadId: lead._id, name: lead.name, phone: lead.mobile, status: "skipped", reason: "Invalid phone number" });
        failed++;
        continue;
      }

      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone, templateName, languageCode, config, authKey, senderNumber,
          contactName: lead.name,
        });

        await _saveConversationAndMessage({
          cleanPhone, contactName: lead.name, companyId, userId,
          leadId: lead._id, templateName, waMessageId,
        });

        results.push({ leadId: lead._id, name: lead.name, phone: cleanPhone, status: "sent" });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({ leadId: lead._id, name: lead.name, phone: cleanPhone, status: "failed", reason: errMsg });
        failed++;
      }

      // Small delay to respect MSG91 rate limits
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`📣 Employee WA blast [user:${userId}]: ${sent} sent, ${failed} failed out of ${leads.length} leads`);
    res.json({ success: true, sent, failed, total: leads.length, results });

  } catch (err) {
    console.error("employeeBulkSend error:", err.message);
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
  deleteConversation,
  saveConfig,
  getConfig,
  startConversation,
  bulkSendToLeads,
  bulkSendCSV,
  getLeadsForWhatsApp,
  employeeBulkSend,
  getConversationByLead,
};