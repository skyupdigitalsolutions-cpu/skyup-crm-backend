// controllers/whatsappChatController.js
// API endpoints used by the CRM frontend (agents + admin)

const axios = require("axios");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const crypto = require("crypto");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Lead = require("../models/Leads");
const { normalizePhone: _sharedNormalizePhone } = require("../utils/normalizePhone");

// ─────────────────────────────────────────────────────────────────────────────
// normalizePhone — WA-safe wrapper around the shared normaliser.
// The shared normaliser returns a 10-digit string or null.
// WA API calls require a full E.164 number (12 digits for India: 91 + 10).
// This wrapper appends the country prefix so WA delivery works correctly.
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  const ten = _sharedNormalizePhone(raw);
  if (ten) return "91" + ten;         // shared util strips country code → prepend 91
  // Fallback: strip non-digits and return as-is (e.g. non-Indian numbers already in E.164)
  const digits = String(raw).replace(/\D/g, "");
  return digits;
}

function safeWaPhone(stored) {
  return normalizePhone(stored);
}

// Fallback value for the template's {{1}} body parameter (the recipient's name)
// when we don't have a contact/lead name. Templates like `crm_followup_leads`
// REQUIRE this parameter — sending zero params makes WhatsApp reject the message
// with "number of localizable_params (0) does not match the expected number of
// params (1)". Change this default if your template's {{1}} isn't a name.
const DEFAULT_TEMPLATE_BODY_PARAM = "there";

// ─────────────────────────────────────────────────────────────────────────────
// describeWaApiError — turn an axios error from the WA provider into a useful,
// user-facing message AND log the full upstream context so 404s stop being a
// mystery. The old code returned axios's generic "Request failed with status
// code 404" whenever the provider's 404 body was non-JSON (e.g. a gateway/HTML
// 404), which hid the real cause. This surfaces status, URL and body instead.
// ─────────────────────────────────────────────────────────────────────────────
function describeWaApiError(apiErr, context = "WA send") {
  const status = apiErr?.response?.status;
  const url = apiErr?.config?.url;
  const body = apiErr?.response?.data;

  // Log everything for the server operator.
  console.error(`[${context}] WhatsApp API error`, {
    status,
    url,
    method: apiErr?.config?.method,
    body: typeof body === "string" ? body.slice(0, 800) : body,
    message: apiErr?.message,
  });

  // Pick the most specific human-readable message available.
  const apiMsg =
    body?.message ||
    body?.error?.message ||
    body?.errors?.[0]?.message ||
    (typeof body === "string" && body.trim()
      ? body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
      : null) ||
    apiErr?.message;

  // A 404 with no JSON body almost always means the endpoint URL/path was
  // rejected by the provider gateway (deprecated route, wrong path, or the
  // template/language combination does not exist for this account).
  let hint = "";
  if (status === 404 && !body?.message && !body?.error?.message) {
    hint =
      " (404 from provider — the endpoint or the template/language combination was not found. " +
      "Verify the template name and that its approved language code matches exactly.)";
  }

  return {
    status: status || 502,
    message: `WhatsApp API error${status ? ` (${status})` : ""}: ${apiMsg}${hint}`,
  };
}

// ── Find a lead by phone, searching BOTH primaryPhone and secondaryPhone ──────
async function findLeadByPhoneDual(cleanPhone, companyId) {
  const norm = _sharedNormalizePhone(cleanPhone);
  const lastTen = cleanPhone.slice(-10);

  if (norm) {
    const lead = await Lead.findOne({
      company: companyId,
      $or: [{ normalizedPhone: norm }, { normalizedSecondaryPhone: norm }],
    });
    if (lead) return lead;
  }

  // Legacy/un-migrated fallback
  return Lead.findOne({
    company: companyId,
    $or: [
      { mobile: cleanPhone },
      { mobile: lastTen },
      { mobile: `+${cleanPhone}` },
      { primaryPhone: lastTen },
      { secondaryPhone: lastTen },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations
// ─────────────────────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
  try {
    const { companyId, userId, role } = req.user;
    const filter = { company: companyId };
    if (role !== "admin") filter.assignedAgent = userId;

    const conversations = await WhatsAppConversation.find(filter)
      .populate("lead", "name mobile email status")
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
    if (!conversation)
      return res.status(404).json({ error: "Conversation not found" });

    if (role !== "admin" && role !== "super_admin") {
      const isAssigned = conversation.assignedAgent?.toString() === userId;
      let ownsLead = false;
      if (!isAssigned && conversation.lead) {
        const lead = await Lead.findOne({
          _id: conversation.lead,
          user: userId,
          company: companyId,
        }).lean();
        ownsLead = !!lead;
      }
      if (!isAssigned && !ownsLead)
        return res.status(403).json({ error: "Not authorised" });
      if (!isAssigned && ownsLead) {
        await WhatsAppConversation.findByIdAndUpdate(conversationId, {
          assignedAgent: userId,
        });
      }
    }

    const messages = await WhatsAppMessage.find({
      conversation: conversationId,
    })
      .populate("sentBy", "name")
      .sort({ waTimestamp: 1 });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      unreadCount: 0,
    });

    res.json({ success: true, messages, conversation });
  } catch (err) {
    console.error("getMessages error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send
// ─────────────────────────────────────────────────────────────────────────────
const sendMessage = async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    const { companyId, userId, role } = req.user;

    if (!text?.trim())
      return res.status(400).json({ error: "Message text is required" });

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation)
      return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res
        .status(400)
        .json({ error: "WhatsApp is not configured for this company" });

    const now = new Date();
    const sessionOpen =
      conversation.sessionExpiresAt && conversation.sessionExpiresAt > now;
    if (!sessionOpen) {
      return res.status(400).json({
        error:
          "24-hour session window has expired. You must send a pre-approved template message to re-engage this customer.",
        code: "SESSION_EXPIRED",
      });
    }

    const provider = config.provider || "msg91";
    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res
        .status(500)
        .json({ error: "MSG91 credentials not configured." });
    }

    const recipientPhone = safeWaPhone(conversation.waPhone);

    let waMessageId;
    try {
      if (provider === "msg91") {
        const msg91Payload = {
          integrated_number: senderNumber,
          recipient_number: recipientPhone,
          content_type: "text",
          text: text.trim(),
        };
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/",
          msg91Payload,
          {
            headers: {
              authkey: authKey,
              "Content-Type": "application/json",
              accept: "application/json",
            },
          },
        );
        waMessageId =
          msg91Response.data?.data?.message_uuid ||
          msg91Response.data?.data?.id ||
          msg91Response.data?.requestId ||
          `out_${Date.now()}_${crypto.randomUUID()}`;
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipientPhone,
            type: "text",
            text: { preview_url: false, body: text.trim() },
          },
          {
            headers: {
              Authorization: `Bearer ${config.accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        waMessageId =
          metaResponse.data?.messages?.[0]?.id ||
          `out_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      const { status, message } = describeWaApiError(apiErr, "sendMessage");
      return res.status(502).json({ error: message, providerStatus: status });
    }

    const savedMsg = await WhatsAppMessage.create({
      conversation: conversationId,
      direction: "outbound",
      body: text.trim(),
      messageType: "text",
      waMessageId,
      sentBy: userId,
      status: "sent",
      waTimestamp: new Date(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage: text.trim(),
      lastMessageAt: new Date(),
      status: "open",
      sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const io = global._io;
    if (io) {
      const payload = {
        type: "wa_new_message",
        conversationId: conversationId.toString(),
        message: {
          _id: savedMsg._id.toString(),
          direction: "outbound",
          body: text.trim(),
          messageType: "text",
          waTimestamp: new Date(),
          status: "sent",
          sentBy: {
            _id: userId,
            name: req.admin?.name || req.user?.name || "Admin",
          },
        },
        waPhone: conversation.waPhone,
        companyId: companyId.toString(),
      };
      io.to("wa_admin").emit("wa_message", payload);
      io.to(`wa_agent_${conversation.assignedAgent?.toString()}`).emit(
        "wa_message",
        payload,
      );
      io.to(`wa_company_${companyId.toString()}`).emit("wa_message", payload);
    }

    res.json({ success: true, message: savedMsg });
  } catch (err) {
    console.error("sendMessage error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send-template
// ─────────────────────────────────────────────────────────────────────────────
const sendTemplate = async (req, res) => {
  try {
    const {
      conversationId,
      templateName,
      languageCode = "en_US",
      components: reqComponents = [],
    } = req.body;
    const { companyId, userId } = req.user;

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation)
      return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res.status(400).json({ error: "WhatsApp not configured" });

    const provider = config.provider || "msg91";
    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;
    const recipientPhone = safeWaPhone(conversation.waPhone);

    let waMessageId;
    try {
      if (provider === "msg91") {
        if (!authKey || !senderNumber)
          return res
            .status(500)
            .json({ error: "MSG91 credentials not configured." });
        const resolvedLangCode = languageCode || "en";
        const namespace = config.msg91Namespace || "";
        const brochureUrl = config.msg91BrochureUrl || "";
        let msg91Components = {
          ...(brochureUrl
            ? {
                header_1: {
                  type: "document",
                  value: brochureUrl,
                  filename: "Brochure.pdf",
                },
              }
            : {}),
          // Always include the {{1}} body param — the template requires it.
          body_1: {
            type: "text",
            value: conversation.contactName?.trim() || DEFAULT_TEMPLATE_BODY_PARAM,
          },
        };
        if (
          reqComponents &&
          Array.isArray(reqComponents) &&
          reqComponents.length > 0
        )
          msg91Components = reqComponents;

        const requestPayload = {
          integrated_number: senderNumber,
          content_type: "template",
          payload: {
            messaging_product: "whatsapp",
            type: "template",
            template: {
              name: templateName,
              language: { code: resolvedLangCode, policy: "deterministic" },
              ...(namespace ? { namespace } : {}),
              to_and_components: [
                { to: [recipientPhone], components: msg91Components },
              ],
            },
          },
        };
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          requestPayload,
          { headers: { authkey: authKey, "Content-Type": "application/json" } },
        );
        waMessageId =
          msg91Response.data?.data?.[0]?.id ||
          msg91Response.data?.requestId ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaTmpl = {
          name: templateName,
          language: { code: languageCode },
        };
        if (reqComponents && reqComponents.length > 0)
          metaTmpl.components = reqComponents;
        const metaResponse = await axios.post(
          apiUrl,
          {
            messaging_product: "whatsapp",
            to: recipientPhone,
            type: "template",
            template: metaTmpl,
          },
          {
            headers: {
              Authorization: `Bearer ${config.accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        waMessageId = metaResponse.data?.messages?.[0]?.id;
      }
    } catch (apiErr) {
      const { status, message } = describeWaApiError(apiErr, "sendTemplate");
      return res.status(502).json({ error: message, providerStatus: status });
    }

    const templatePreview = `[Template: ${templateName}]`;
    const savedMsg = await WhatsAppMessage.create({
      conversation: conversationId,
      direction: "outbound",
      body: templatePreview,
      messageType: "template",
      waMessageId,
      sentBy: userId,
      status: "sent",
      waTimestamp: new Date(),
      isTemplate: true,
      templateName,
    });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage: templatePreview,
      lastMessageAt: new Date(),
      // A template send does NOT open WhatsApp's 24h window — only an inbound
      // reply from the customer does (handled in the webhook). Marking the
      // session "open" here previously tricked the UI into showing a text box
      // and let agents send free-form messages that WhatsApp silently rejects.
      status: "waiting", // waiting on the customer to reply
      // sessionExpiresAt intentionally NOT changed.
    });

    res.json({ success: true, message: savedMsg });
  } catch (err) {
    console.error("sendTemplate error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

const assignConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;
    const updated = await WhatsAppConversation.findByIdAndUpdate(
      id,
      { assignedAgent: agentId },
      { new: true },
    ).populate("assignedAgent", "name email");
    const io = global._io;
    if (io)
      io.to(`wa_agent_${agentId}`).emit("wa_assigned", {
        conversationId: id,
        message: "A new WhatsApp conversation has been assigned to you",
      });
    res.json({ success: true, conversation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const closeConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await WhatsAppConversation.findByIdAndUpdate(
      id,
      { status: "closed" },
      { new: true },
    );
    res.json({ success: true, conversation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.user;
    if (role !== "admin")
      return res
        .status(403)
        .json({ error: "Only admins can delete conversations" });
    await WhatsAppMessage.deleteMany({ conversation: id });
    await WhatsAppConversation.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const saveConfig = async (req, res) => {
  try {
    const {
      provider = "msg91",
      msg91AuthKey,
      msg91IntegratedNumber,
      msg91Namespace,
      msg91BrochureUrl,
      phoneNumberId,
      accessToken,
      verifyToken,
      businessAccountId,
      graphApiVersion,
      phoneNumber,
    } = req.body;
    const { companyId } = req.user;

    if (
      provider !== "msg91" &&
      (!phoneNumberId || !accessToken || !verifyToken)
    ) {
      return res
        .status(400)
        .json({
          error:
            "phoneNumberId, accessToken and verifyToken are required for Meta provider",
        });
    }

    const updateData = {
      provider,
      phoneNumber: phoneNumber || "",
      isActive: true,
      company: companyId,
    };
    if (provider === "msg91") {
      updateData.msg91AuthKey = msg91AuthKey || "";
      updateData.msg91IntegratedNumber = msg91IntegratedNumber || "";
      // Bug fix: these were collected by the config UI ("required for templates")
      // but never persisted, so the template payload always omitted the namespace.
      // Only overwrite when the field is actually sent, so partial saves don't wipe it.
      if (msg91Namespace !== undefined)
        updateData.msg91Namespace = (msg91Namespace || "").trim();
      if (msg91BrochureUrl !== undefined)
        updateData.msg91BrochureUrl = (msg91BrochureUrl || "").trim();
    } else {
      updateData.phoneNumberId = phoneNumberId || "";
      updateData.accessToken = accessToken || "";
      updateData.verifyToken = verifyToken || "";
      updateData.businessAccountId = businessAccountId || "";
      updateData.graphApiVersion = graphApiVersion || "v21.0";
    }

    const config = await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      updateData,
      { upsert: true, new: true },
    );
    const safeConfig = { ...config.toObject() };
    if (safeConfig.msg91AuthKey) safeConfig.msg91AuthKey = "***hidden***";
    if (safeConfig.accessToken) safeConfig.accessToken = "***hidden***";
    res.json({ success: true, config: safeConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getConfig = async (req, res) => {
  try {
    const { companyId } = req.user;
    const config = await WhatsAppConfig.findOne({ company: companyId });
    if (!config) return res.json({ configured: false });

    const provider = config.provider || "msg91";
    res.json({
      configured: true,
      provider,
      phoneNumber: config.phoneNumber,
      isActive: config.isActive,
      msg91Configured: !!(config.msg91AuthKey && config.msg91IntegratedNumber),
      msg91IntegratedNumber: config.msg91IntegratedNumber || "",
      msg91Namespace: config.msg91Namespace || "",
      msg91BrochureUrl: config.msg91BrochureUrl || "",
      ...(provider === "meta" && {
        phoneNumberId: config.phoneNumberId,
        businessAccountId: config.businessAccountId,
        graphApiVersion: config.graphApiVersion,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/start-conversation
// Uses dual-phone lookup to find existing lead
// ─────────────────────────────────────────────────────────────────────────────
const startConversation = async (req, res) => {
  try {
    const {
      phone,
      contactName = "",
      templateName,
      languageCode = "en_US",
      components = [],
    } = req.body;

    const isAdmin = !!req.admin;
    const companyId = isAdmin
      ? req.admin.company?._id || req.admin.company
      : req.user.company;
    const userId = isAdmin ? null : req.user._id;

    if (!phone?.trim())
      return res.status(400).json({ error: "Phone number is required" });
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return res.status(400).json({ error: "Invalid phone number." });
    }
    if (!templateName?.trim()) {
      return res
        .status(400)
        .json({
          error: "A pre-approved template name is required.",
          code: "TEMPLATE_REQUIRED",
        });
    }

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res
        .status(400)
        .json({ error: "WhatsApp is not configured for this company" });

    const provider = config.provider || "msg91";
    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;
    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({ error: "MSG91 credentials missing" });
    }

    // ── Dual-phone lead lookup ────────────────────────────────────────────────
    const lead = await findLeadByPhoneDual(cleanPhone, companyId);

    let waMessageId;
    try {
      if (provider === "msg91") {
        const resolvedLangCode = languageCode || "en";
        const namespace = config.msg91Namespace || "";
        const brochureUrl = config.msg91BrochureUrl || "";
        let msg91Components = {
          ...(brochureUrl
            ? {
                header_1: {
                  type: "document",
                  value: brochureUrl,
                  filename: "Brochure.pdf",
                },
              }
            : {}),
          // Always include the {{1}} body param — the template requires it.
          body_1: {
            type: "text",
            value: contactName?.trim() || lead?.name?.trim() || DEFAULT_TEMPLATE_BODY_PARAM,
          },
        };
        if (components && Array.isArray(components) && components.length > 0)
          msg91Components = components;

        const requestPayload = {
          integrated_number: senderNumber,
          content_type: "template",
          payload: {
            messaging_product: "whatsapp",
            type: "template",
            template: {
              name: templateName.trim(),
              language: { code: resolvedLangCode, policy: "deterministic" },
              ...(namespace ? { namespace } : {}),
              to_and_components: [
                { to: [cleanPhone], components: msg91Components },
              ],
            },
          },
        };
        const msg91Response = await axios.post(
          "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
          requestPayload,
          { headers: { authkey: authKey, "Content-Type": "application/json" } },
        );
        waMessageId =
          msg91Response.data?.data?.[0]?.id ||
          msg91Response.data?.requestId ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
      } else {
        const apiUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
        const metaPayload = {
          messaging_product: "whatsapp",
          to: cleanPhone,
          type: "template",
          template: {
            name: templateName.trim(),
            language: { code: languageCode },
          },
        };
        if (components && components.length > 0)
          metaPayload.template.components = components;
        const metaResponse = await axios.post(apiUrl, metaPayload, {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        });
        waMessageId =
          metaResponse.data?.messages?.[0]?.id ||
          `tmpl_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      const { status, message } = describeWaApiError(apiErr, "startConversation");
      return res.status(502).json({ error: message, providerStatus: status });
    }

    let conversation = await WhatsAppConversation.findOne({
      waPhone: cleanPhone,
      company: companyId,
    });

    if (!conversation) {
      conversation = await WhatsAppConversation.create({
        waPhone: cleanPhone,
        contactName: contactName.trim() || lead?.name || "",
        company: companyId,
        assignedAgent: userId,
        lead: lead?._id || null,
        // Starting a conversation with a template does NOT open WhatsApp's 24h
        // window — only the customer's reply does. Leave the session closed so
        // the UI keeps the template/Re-engage flow until they respond.
        status: "waiting",
        lastMessage: "",
        lastMessageAt: new Date(),
        // sessionExpiresAt intentionally left unset (session not open yet).
      });
    } else {
      const patch = {};
      if (!conversation.lead && lead?._id) patch.lead = lead._id;
      if (!conversation.assignedAgent && userId) patch.assignedAgent = userId;
      if (Object.keys(patch).length) {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
        const convPlain =
          typeof conversation.toObject === "function"
            ? conversation.toObject()
            : conversation;
        conversation = Object.assign({}, convPlain, patch);
      }
    }

    const templatePreview = `[Template: ${templateName}]`;
    const savedMsg = await WhatsAppMessage.create({
      conversation: conversation._id,
      direction: "outbound",
      body: templatePreview,
      messageType: "template",
      waMessageId,
      sentBy: userId,
      status: "sent",
      waTimestamp: new Date(),
      isTemplate: true,
      templateName: templateName.trim(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage: templatePreview,
      lastMessageAt: new Date(),
      // Template send does not open the 24h window — wait for the customer reply.
      status: "waiting",
      // sessionExpiresAt intentionally NOT changed.
    });

    const io = global._io;
    if (io) {
      const populatedConv = await WhatsAppConversation.findById(
        conversation._id,
      )
        .populate("lead", "name mobile email status")
        .populate("assignedAgent", "name email");
      const convPayload = { conversation: populatedConv };
      io.to("wa_admin").emit("wa_new_conversation", convPayload);
      if (userId)
        io.to(`wa_agent_${userId}`).emit("wa_new_conversation", convPayload);
      io.to(`wa_company_${companyId.toString()}`).emit(
        "wa_new_conversation",
        convPayload,
      );

      const msgPayload = {
        type: "wa_new_message",
        conversationId: conversation._id.toString(),
        message: {
          _id: savedMsg._id.toString(),
          direction: "outbound",
          body: templatePreview,
          messageType: "template",
          waTimestamp: new Date(),
          status: "sent",
          sentBy: {
            _id: userId,
            name: req.admin?.name || req.user?.name || "Agent",
          },
        },
        waPhone: cleanPhone,
        companyId: companyId.toString(),
        assignedAgent: userId?.toString(),
      };
      io.to("wa_admin").emit("wa_message", msgPayload);
      if (userId) io.to(`wa_agent_${userId}`).emit("wa_message", msgPayload);
      io.to(`wa_company_${companyId.toString()}`).emit(
        "wa_message",
        msgPayload,
      );
    }

    res.json({ success: true, conversation, message: savedMsg });
  } catch (err) {
    console.error("startConversation error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

const _sendTemplateToPhone = async ({
  cleanPhone,
  templateName,
  languageCode,
  config,
  authKey,
  senderNumber,
  contactName = "",
}) => {
  const provider = config.provider || "msg91";
  if (provider === "msg91") {
    const namespace = config.msg91Namespace || "";
    const brochureUrl = config.msg91BrochureUrl || "";
    const msg91Components = {
      ...(brochureUrl
        ? {
            header_1: {
              type: "document",
              value: brochureUrl,
              filename: "Brochure.pdf",
            },
          }
        : {}),
      // Always include the {{1}} body param — the template requires it.
      body_1: {
        type: "text",
        value: contactName?.trim() || DEFAULT_TEMPLATE_BODY_PARAM,
      },
    };
    const resp = await axios.post(
      "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      {
        integrated_number: senderNumber,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: templateName.trim(),
            language: { code: languageCode || "en", policy: "deterministic" },
            ...(namespace ? { namespace } : {}),
            to_and_components: [
              { to: [cleanPhone], components: msg91Components },
            ],
          },
        },
      },
      { headers: { authkey: authKey, "Content-Type": "application/json" } },
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
        to: cleanPhone,
        type: "template",
        template: {
          name: templateName.trim(),
          language: { code: languageCode },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return (
      resp.data?.messages?.[0]?.id ||
      `bulk_${Date.now()}_${crypto.randomUUID()}`
    );
  }
};

const _saveConversationAndMessage = async ({
  cleanPhone,
  contactName,
  companyId,
  userId,
  leadId,
  templateName,
  waMessageId,
}) => {
  const templatePreview = `[Template: ${templateName}]`;
  let conversation = await WhatsAppConversation.findOne({
    waPhone: cleanPhone,
    company: companyId,
  });
  if (!conversation) {
    conversation = await WhatsAppConversation.create({
      waPhone: cleanPhone,
      contactName: contactName || "",
      company: companyId,
      assignedAgent: userId,
      lead: leadId || null,
      // Template send does not open WhatsApp's 24h window — only the customer's
      // reply does. Keep the session closed so free-form text stays disabled.
      status: "waiting",
      lastMessage: templatePreview,
      lastMessageAt: new Date(),
      // sessionExpiresAt intentionally left unset.
    });
  } else {
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      // sessionExpiresAt intentionally NOT changed by a template send.
      status: "waiting",
      lastMessage: templatePreview,
      lastMessageAt: new Date(),
    });
  }
  await WhatsAppMessage.create({
    conversation: conversation._id,
    direction: "outbound",
    body: templatePreview,
    messageType: "template",
    waMessageId,
    sentBy: userId,
    status: "sent",
    waTimestamp: new Date(),
    isTemplate: true,
    templateName: templateName.trim(),
  });
  return conversation;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/bulk-send
// ─────────────────────────────────────────────────────────────────────────────
const bulkSendToLeads = async (req, res) => {
  try {
    const { templateName, languageCode = "en_US", campaign, filter: blastFilter } = req.body;
    const { companyId, userId } = req.user;

    if (!templateName?.trim())
      return res.status(400).json({ error: "templateName is required" });

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res
        .status(400)
        .json({ error: "WhatsApp is not configured for this company" });

    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;
    if (!authKey || !senderNumber)
      return res.status(500).json({ error: "MSG91 credentials missing" });

    const filter = { company: companyId, mobile: { $exists: true, $ne: "" } };
    if (campaign && campaign.trim()) filter.campaign = campaign.trim();

    // Apply optional blast filters (status, source, date range)
    if (blastFilter) {
      if (blastFilter.status) filter.status = blastFilter.status;
      if (blastFilter.source) filter.campaign = blastFilter.source; // source maps to campaign field for Meta/Google/Website
      if (blastFilter.dateFrom || blastFilter.dateTo) {
        filter.createdAt = {};
        if (blastFilter.dateFrom) filter.createdAt.$gte = new Date(blastFilter.dateFrom);
        if (blastFilter.dateTo) {
          const end = new Date(blastFilter.dateTo);
          end.setHours(23, 59, 59, 999);
          filter.createdAt.$lte = end;
        }
      }
    }

    const leads = await Lead.find(filter).lean();
    if (leads.length === 0)
      return res.json({
        success: true,
        sent: 0,
        failed: 0,
        total: 0,
        results: [],
      });

    const results = [];
    let sent = 0,
      failed = 0;

    for (const lead of leads) {
      const cleanPhone = normalizePhone(lead.mobile);
      if (cleanPhone.length < 10) {
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: lead.mobile,
          status: "skipped",
          reason: "Invalid phone number",
        });
        failed++;
        continue;
      }
      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone,
          templateName,
          languageCode,
          config,
          authKey,
          senderNumber,
          contactName: lead.name,
        });
        await _saveConversationAndMessage({
          cleanPhone,
          contactName: lead.name,
          companyId,
          userId,
          leadId: lead._id,
          templateName,
          waMessageId,
        });
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: cleanPhone,
          status: "sent",
        });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: cleanPhone,
          status: "failed",
          reason: errMsg,
        });
        failed++;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    res.json({ success: true, sent, failed, total: leads.length, results });
  } catch (err) {
    console.error("bulkSendToLeads error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/bulk-send-csv
// Uses dual-phone lookup to match recipients to existing leads
// ─────────────────────────────────────────────────────────────────────────────
const bulkSendCSV = async (req, res) => {
  try {
    const { recipients, templateName, languageCode = "en_US" } = req.body;
    const { companyId, userId } = req.user;

    if (!templateName?.trim())
      return res.status(400).json({ error: "templateName is required" });
    if (!Array.isArray(recipients) || recipients.length === 0)
      return res.status(400).json({ error: "recipients array is required" });

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res.status(400).json({ error: "WhatsApp is not configured" });

    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;
    if (!authKey || !senderNumber)
      return res.status(500).json({ error: "MSG91 credentials missing" });

    const results = [];
    let sent = 0,
      failed = 0;

    for (const recipient of recipients) {
      const cleanPhone = normalizePhone(recipient.phone);
      const contactName = recipient.name || "";
      if (cleanPhone.length < 10) {
        results.push({
          name: contactName,
          phone: recipient.phone,
          status: "skipped",
          reason: "Invalid phone number",
        });
        failed++;
        continue;
      }
      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone,
          templateName,
          languageCode,
          config,
          authKey,
          senderNumber,
          contactName,
        });
        // Dual-phone lead lookup for CSV sends
        const lead = await findLeadByPhoneDual(cleanPhone, companyId);
        await _saveConversationAndMessage({
          cleanPhone,
          contactName,
          companyId,
          userId,
          leadId: lead?._id || null,
          templateName,
          waMessageId,
        });
        results.push({ name: contactName, phone: cleanPhone, status: "sent" });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({
          name: contactName,
          phone: cleanPhone,
          status: "failed",
          reason: errMsg,
        });
        failed++;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    res.json({
      success: true,
      sent,
      failed,
      total: recipients.length,
      results,
    });
  } catch (err) {
    console.error("bulkSendCSV error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/leads
// Returns leads with both primary and secondary phone info
// ─────────────────────────────────────────────────────────────────────────────
const getLeadsForWhatsApp = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const companyId = isAdmin
      ? req.admin.company?._id || req.admin.company
      : req.user.company;

    const filter = { company: companyId, mobile: { $exists: true, $ne: "" } };
    if (!isAdmin) filter.user = req.user._id;

    const leads = await Lead.find(filter)
      .select(
        "name mobile primaryPhone secondaryPhone email status source campaign date createdAt user",
      )
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .lean();

    // Build phone list including secondaryPhone for conversation lookup
    const phones = leads.flatMap((l) => {
      const out = [];
      const p = (l.mobile || "").replace(/\D/g, "");
      if (p) out.push(p);
      const s = (l.secondaryPhone || "").replace(/\D/g, "");
      if (s) out.push(s);
      return out;
    });

    const existingConvs = await WhatsAppConversation.find({
      company: companyId,
      waPhone: { $in: phones },
    })
      .select("waPhone _id status")
      .lean();

    const convByPhone = {};
    for (const c of existingConvs) convByPhone[c.waPhone] = c;

    const result = leads.map((l) => {
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
// ─────────────────────────────────────────────────────────────────────────────
const getConversationByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { companyId, userId, role } = req.user;

    const lead = await Lead.findOne({ _id: leadId, company: companyId }).lean();
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    if (role !== "admin" && role !== "super_admin") {
      if (lead.user?.toString() !== userId) {
        return res
          .status(403)
          .json({ error: "This lead is not assigned to you" });
      }
    }

    // Build all phone variants to search — both primary and secondary
    const primaryDigits = normalizePhone(
      lead.mobile || lead.primaryPhone || "",
    );
    const secondaryDigits = lead.secondaryPhone
      ? normalizePhone(lead.secondaryPhone)
      : null;
    const lastTen = primaryDigits?.slice(-10) || "";

    const phoneVariants = [
      ...(primaryDigits ? [primaryDigits, `+${primaryDigits}`, lastTen] : []),
      ...(secondaryDigits
        ? [secondaryDigits, `+${secondaryDigits}`, secondaryDigits?.slice(-10)]
        : []),
    ].filter(Boolean);

    const candidatesByLead = await WhatsAppConversation.find({
      lead: leadId,
      company: companyId,
    })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .lean();

    const candidatesByPhone = phoneVariants.length
      ? await WhatsAppConversation.find({
          company: companyId,
          waPhone: { $in: phoneVariants },
        })
          .sort({ lastMessageAt: -1, createdAt: -1 })
          .lean()
      : [];

    const seen = new Set();
    const allCandidates = [...candidatesByLead, ...candidatesByPhone]
      .filter((c) => {
        const id = String(c._id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      });

    let conversation = allCandidates[0] || null;
    if (!conversation) return res.json({ success: true, conversation: null });

    const patch = {};
    if (!conversation.lead) patch.lead = leadId;
    const leadOwnerId = lead.user ? lead.user.toString() : null;
    const currentAgent = conversation.assignedAgent?.toString() || null;
    if (leadOwnerId && currentAgent !== leadOwnerId) {
      patch.assignedAgent = leadOwnerId;
    } else if (!conversation.assignedAgent && userId) {
      patch.assignedAgent = userId;
    }

    if (Object.keys(patch).length) {
      await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
      conversation = { ...conversation, ...patch };
    }

    res.json({ success: true, conversation });
  } catch (err) {
    console.error("getConversationByLead error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

const employeeBulkSend = async (req, res) => {
  try {
    const { templateName, languageCode = "en_US" } = req.body;
    const { _id: userId, company: companyId } = req.user;

    if (!templateName?.trim())
      return res.status(400).json({ error: "templateName is required" });

    const config = await WhatsAppConfig.findOne({
      company: companyId,
      isActive: true,
    });
    if (!config)
      return res
        .status(400)
        .json({
          error:
            "WhatsApp is not configured for this company. Ask your admin to set it up.",
        });

    const authKey = config.msg91AuthKey;
    const senderNumber = config.msg91IntegratedNumber;
    if (!authKey || !senderNumber)
      return res
        .status(500)
        .json({ error: "MSG91 credentials missing in company config" });

    const leads = await Lead.find({
      company: companyId,
      user: userId,
      mobile: { $exists: true, $ne: "" },
    }).lean();
    if (leads.length === 0)
      return res.json({
        success: true,
        sent: 0,
        failed: 0,
        total: 0,
        results: [],
      });

    const results = [];
    let sent = 0,
      failed = 0;

    for (const lead of leads) {
      const cleanPhone = normalizePhone(lead.mobile);
      if (cleanPhone.length < 10) {
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: lead.mobile,
          status: "skipped",
          reason: "Invalid phone number",
        });
        failed++;
        continue;
      }
      try {
        const waMessageId = await _sendTemplateToPhone({
          cleanPhone,
          templateName,
          languageCode,
          config,
          authKey,
          senderNumber,
          contactName: lead.name,
        });
        await _saveConversationAndMessage({
          cleanPhone,
          contactName: lead.name,
          companyId,
          userId,
          leadId: lead._id,
          templateName,
          waMessageId,
        });
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: cleanPhone,
          status: "sent",
        });
        sent++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({
          leadId: lead._id,
          name: lead.name,
          phone: cleanPhone,
          status: "failed",
          reason: errMsg,
        });
        failed++;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

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