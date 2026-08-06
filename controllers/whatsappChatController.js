// controllers/whatsappChatController.js
// API endpoints used by the CRM frontend (agents + admin)

const axios = require("axios");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const crypto = require("crypto");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Lead = require("../models/Leads");
const { normalizePhone: _sharedNormalizePhone } = require("../utils/normalizePhone");
const { resolveCanonicalConversation } = require("../utils/conversationMerge");
const { hmac } = require("../utils/fieldCrypto");

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
// TEMPLATES_WITH_DOC_HEADER — templates that carry a MEDIA (document) header.
// Mirrors services/autoTemplateService.js. A document header must be attached
// ONLY for templates that were actually APPROVED on MSG91/Meta with a document
// header. Attaching one to a header-less template (or omitting it on a
// template that requires one) makes the provider reject the send — this is
// the root cause of the "404 — template/language combination not found"
// error seen from the manual "Send Template & Start Chat" flow. Keep this
// list in sync with services/autoTemplateService.js. Add a name here only if
// that MSG91 template was created WITH a document header.
const TEMPLATES_WITH_DOC_HEADER = new Set(["crm_followup_leads"]);

// Build the msg91Components object for a template send, attaching the
// document header ONLY when the template actually needs one.
function buildMsg91Components({ templateName, brochureUrl, bodyParam }) {
  const needsDocHdr = TEMPLATES_WITH_DOC_HEADER.has((templateName || "").trim());
  return {
    ...(needsDocHdr && brochureUrl
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
      value: bodyParam?.trim() || DEFAULT_TEMPLATE_BODY_PARAM,
    },
  };
}

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
      "Verify the template name, that its approved language code matches exactly, and that a " +
      "document header is only attached for templates in TEMPLATES_WITH_DOC_HEADER at the top " +
      "of this file — a mismatched header on a header-less template also causes this exact 404.)";
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
    const { companyId, userId, role } = callerCtx(req);
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
    const { companyId, userId, role } = callerCtx(req);

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
      // Oldest first, newest last — same as the WhatsApp app.
      // _id is the TIE-BREAKER: MSG91 timestamps are only second-accurate, so
      // several messages can share the exact same waTimestamp. Sorting on
      // timestamp alone leaves those in an arbitrary order that can even change
      // between page loads. ObjectIds increase monotonically, so adding _id
      // guarantees true insertion order.
      .sort({ waTimestamp: 1, _id: 1 });

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
    const { companyId, userId, role } = callerCtx(req);

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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);

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
    const { companyId, userId } = callerCtx(req);

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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);
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

        const needsDocHdr = TEMPLATES_WITH_DOC_HEADER.has((templateName || "").trim());
        if (needsDocHdr && !brochureUrl) {
          return res.status(400).json({
            error:
              `Template "${templateName}" requires a document header, but no Brochure URL is configured ` +
              `for this company. Go to Communications → Integrations → WhatsApp and set the Brochure URL ` +
              `(a public PDF link), or remove "${templateName}" from TEMPLATES_WITH_DOC_HEADER if the ` +
              `approved template doesn't actually have a document header.`,
          });
        }

        let msg91Components = buildMsg91Components({
          templateName,
          brochureUrl,
          bodyParam: conversation.contactName,
        });
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
    const { role } = callerCtx(req);
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
    const { companyId } = callerCtx(req);

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
    const { companyId } = callerCtx(req);
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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);
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

        const needsDocHdr = TEMPLATES_WITH_DOC_HEADER.has((templateName || "").trim());
        if (needsDocHdr && !brochureUrl) {
          return res.status(400).json({
            error:
              `Template "${templateName}" requires a document header, but no Brochure URL is configured ` +
              `for this company. Go to Communications → Integrations → WhatsApp and set the Brochure URL ` +
              `(a public PDF link), or remove "${templateName}" from TEMPLATES_WITH_DOC_HEADER if the ` +
              `approved template doesn't actually have a document header.`,
          });
        }

        let msg91Components = buildMsg91Components({
          templateName,
          brochureUrl,
          bodyParam: contactName?.trim() ? contactName : lead?.name,
        });
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

    // resolveCanonicalConversation() matches by lead ref AND phone, and merges
    // any duplicates it finds — so starting a template chat here always lands
    // on the same conversation record the inbound webhook uses, instead of
    // risking a second, near-empty record for this lead.
    let conversation = await resolveCanonicalConversation({
      leadId: lead?._id || null,
      phoneVariants: [cleanPhone],
      companyId,
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
    const msg91Components = buildMsg91Components({
      templateName,
      brochureUrl,
      bodyParam: contactName,
    });
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
  let conversation = await resolveCanonicalConversation({
    leadId: leadId || null,
    phoneVariants: [cleanPhone],
    companyId,
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
    const { companyId, userId } = callerCtx(req);

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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);
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
    const { companyId, userId } = callerCtx(req);

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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);
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

    // waPhone is now encrypted at rest with a random IV, so the $in lookup
    // must go through waPhoneHash (deterministic HMAC of the same plaintext)
    // instead of direct equality — see models/WhatsAppConversation.js. waPhone
    // is still selected below (decrypted automatically on read) since the
    // grouping-by-phone logic right after this needs the plaintext value.
    const existingConvs = await WhatsAppConversation.find({
      company: companyId,
      waPhoneHash: { $in: phones.map(hmac) },
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
    const { companyId, userId, role } = callerCtx(req);

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

    // ── Resolve to a SINGLE canonical conversation ────────────────────────────
    // Previously this endpoint just picked whichever matching record had the
    // most recent lastMessageAt, which meant a near-empty duplicate (created by
    // a manual template send) could "win" over the real conversation holding
    // the lead's actual WhatsApp history — showing the employee an empty chat
    // with a stale "session expired" banner even though the lead had just
    // replied on the OTHER record. resolveCanonicalConversation() finds every
    // matching record (by lead ref OR phone) and merges them into one, keeping
    // every message and the freshest sessionExpiresAt — so this self-heals any
    // duplicates that already exist instead of just papering over them.
    let conversation = await resolveCanonicalConversation({
      leadId,
      phoneVariants,
      companyId,
    });
    if (!conversation) return res.json({ success: true, conversation: null });

    const patch = {};
    const leadOwnerId = lead.user ? lead.user.toString() : null;
    const currentAgent = conversation.assignedAgent?.toString() || null;
    if (leadOwnerId && currentAgent !== leadOwnerId) {
      patch.assignedAgent = leadOwnerId;
    } else if (!conversation.assignedAgent && userId) {
      patch.assignedAgent = userId;
    }

    // Opening the chat marks it read → clear the persistent unread badge.
    // This is the ONLY thing that clears it; the notification bell's "Clear all"
    // is purely local to the bell and never touches these counts.
    if ((conversation.unreadCount || 0) > 0) {
      patch.unreadCount = 0;
    }

    if (Object.keys(patch).length) {
      await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
      conversation = { ...conversation.toObject(), ...patch };
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
    const { _id: userId, company: companyId } = callerCtx(req);

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
    const senderNumber = normalizePhone(config.msg91IntegratedNumber);
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

// ── Caller context (role-safe) ───────────────────────────────────────────────
// protectAny populates req.user for employees and admins, but for super_admin
// it returns early having set only req.admin / req.callerCompany. Destructuring
// req.user therefore threw "Cannot destructure property 'companyId' of
// 'req.user'" for super admins. Read the context defensively so every role
// works regardless of which property the middleware happened to set.
function callerCtx(req) {
  const u = req.user || {};
  const adminCompany = req.admin && (req.admin.company?._id || req.admin.company);
  return {
    companyId: u.companyId || req.callerCompany || adminCompany || null,
    userId:    u.userId || u.id || u._id || (req.admin && req.admin._id) || null,
    role:      u.role || (req.admin && req.admin.role) || "user",
  };
}

// ── Unread inbound-message counts for the lead list badges ───────────────────
// Returns the PERSISTENT per-conversation unreadCount (incremented by the MSG91
// inbound webhook, cleared only when the agent opens that lead's chat) so the
// red badge in Communications survives page reloads and is completely
// independent of the notification bell's local "Clear all".
//
// Returned as two maps so the UI can match either way:
//   byLead  → { "<leadId>": 3 }
//   byPhone → { "<last10digits>": 3 }   (covers convs not yet linked to a lead)
const getUnreadCounts = async (req, res) => {
  try {
    const { companyId, userId, role } = callerCtx(req);
    if (!companyId) return res.json({ success: true, byLead: {}, byPhone: {} });
    const isAdmin = role === "admin" || role === "super_admin";

    const query = { company: companyId, unreadCount: { $gt: 0 } };
    if (!isAdmin) {
      // Employees only see counts for their own leads / conversations.
      const myLeads = await Lead.find({ company: companyId, user: userId }).select("_id").lean();
      const leadIds = myLeads.map((l) => l._id);
      query.$or = [{ assignedAgent: userId }, { lead: { $in: leadIds } }];
    }

    const convs = await WhatsAppConversation.find(query)
      .select("lead waPhone unreadCount")
      .lean();

    const byLead = {};
    const byPhone = {};
    for (const c of convs) {
      const n = c.unreadCount || 0;
      if (n <= 0) continue;
      if (c.lead) {
        const k = String(c.lead);
        byLead[k] = (byLead[k] || 0) + n;
      }
      const last10 = String(c.waPhone || "").replace(/\D/g, "").slice(-10);
      if (last10) byPhone[last10] = (byPhone[last10] || 0) + n;
    }

    res.json({ success: true, byLead, byPhone });
  } catch (err) {
    console.error("getUnreadCounts error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send-media
// Sends an image / video / audio / document (incl. GIF) to the lead.
// The file is uploaded to Cloudinary first (by the route middleware), which
// gives WhatsApp the public HTTPS URL it requires — WhatsApp cannot read local
// files. Mirrors sendMessage(): same 24-hour session rule, same save + socket
// emit, so the message appears live in the chat for everyone.
// ─────────────────────────────────────────────────────────────────────────────

// Map an uploaded file's mimetype to the WhatsApp media type.
// NOTE: WhatsApp has no "gif" type — animated GIFs must be sent as video to
// animate. A .gif sent as an image shows only the first frame.
function waMediaTypeFor(mimetype = "", originalname = "") {
  const mt = String(mimetype).toLowerCase();
  const name = String(originalname).toLowerCase();
  if (mt === "image/gif" || name.endsWith(".gif")) return "video";
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  return "document";
}

const sendMedia = async (req, res) => {
  try {
    const { conversationId, caption } = req.body;
    const { companyId, userId } = callerCtx(req);

    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: "No file received. Attach a file and try again." });
    }
    const mediaUrl  = req.file.path;                       // public Cloudinary HTTPS URL
    const fileName  = req.file.originalname || "file";
    const mediaType = waMediaTypeFor(req.file.mimetype, fileName);
    const cap       = (caption || "").trim();

    const conversation = await WhatsAppConversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) return res.status(400).json({ error: "WhatsApp is not configured for this company" });

    // Same 24-hour rule as text: free-form media only inside the session window.
    const sessionOpen = conversation.sessionExpiresAt && conversation.sessionExpiresAt > new Date();
    if (!sessionOpen) {
      return res.status(400).json({
        error: "24-hour session window has expired. You must send a pre-approved template message to re-engage this customer.",
        code:  "SESSION_EXPIRED",
      });
    }

    const provider      = config.provider || "msg91";
    const authKey       = config.msg91AuthKey;
    const senderNumber  = normalizePhone(config.msg91IntegratedNumber);
    const recipientPhone = safeWaPhone(conversation.waPhone);

    if (provider === "msg91" && (!authKey || !senderNumber)) {
      return res.status(500).json({ error: "MSG91 credentials not configured." });
    }

    let waMessageId;
    try {
      if (provider === "msg91") {
        // MSG91 explicitly reports "attachment_url not found in request", so it
        // expects the media URL in an `attachment_url` field (not Meta's `link`
        // or a nested media.url). Variants are ordered with the attachment_url
        // shapes first; each rejection is logged with MSG91's exact reason.
        const metaMediaObj = { link: mediaUrl };
        if (mediaType === "document") metaMediaObj.filename = fileName;
        if (cap && mediaType !== "document") metaMediaObj.caption = cap;

        // Base flat payload using MSG91's attachment_url field.
        const flatAttachment = {
          integrated_number: senderNumber,
          recipient_number:  recipientPhone,
          content_type:      "media",
          attachment_url:    mediaUrl,
          attachment_type:   mediaType,
        };
        if (mediaType === "document") flatAttachment.filename = fileName;
        if (cap) flatAttachment.caption = cap;

        const variants = [
          {
            name: "flat attachment_url",
            body: flatAttachment,
          },
          {
            name: "attachment_url + type as content_type",
            body: (() => {
              const b = {
                integrated_number: senderNumber,
                recipient_number:  recipientPhone,
                content_type:      mediaType,
                attachment_url:    mediaUrl,
              };
              if (mediaType === "document") b.filename = fileName;
              if (cap) b.caption = cap;
              return b;
            })(),
          },
          {
            name: "media object with attachment_url",
            body: (() => {
              const media = { type: mediaType, attachment_url: mediaUrl, url: mediaUrl };
              if (mediaType === "document") media.filename = fileName;
              if (cap) media.caption = cap;
              return {
                integrated_number: senderNumber,
                recipient_number:  recipientPhone,
                content_type:      "media",
                media,
              };
            })(),
          },
          {
            name: "payload-wrapped (Meta style)",
            body: {
              integrated_number: senderNumber,
              content_type: "media",
              payload: {
                messaging_product: "whatsapp",
                to: recipientPhone,
                type: mediaType,
                [mediaType]: metaMediaObj,
              },
            },
          },
        ];

        let lastErr = null;
        for (const v of variants) {
          try {
            const resp = await axios.post(
              "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/",
              v.body,
              { headers: { authkey: authKey, "Content-Type": "application/json", accept: "application/json" } },
            );
            // MSG91 can return HTTP 200 with an error flag in the body.
            if (resp.data?.hasError === true || resp.data?.status === "error") {
              lastErr = new Error(JSON.stringify(resp.data));
              console.error(`[sendMedia] variant "${v.name}" rejected in body:`, JSON.stringify(resp.data));
              continue;
            }
            waMessageId =
              resp.data?.data?.message_uuid || resp.data?.data?.id ||
              resp.data?.requestId || `out_${Date.now()}_${crypto.randomUUID()}`;
            console.log(`[sendMedia] ✅ sent using variant "${v.name}" (${mediaType})`);
            break;
          } catch (e) {
            lastErr = e;
            console.error(
              `[sendMedia] variant "${v.name}" failed:`,
              JSON.stringify(e?.response?.data || e.message),
            );
          }
        }

        if (!waMessageId) {
          const body = lastErr?.response?.data;
          const detail =
            body?.message || body?.errors?.[0]?.message ||
            (typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body || {})) ||
            lastErr?.message || "unknown error";
          return res.status(502).json({
            error: `MSG91 rejected the ${mediaType}: ${detail}`,
          });
        }
      } else {
        // Meta Cloud API — { type: "image", image: { link, caption } }
        const mediaObj = { link: mediaUrl };
        if (mediaType === "document") mediaObj.filename = fileName;
        if (cap && mediaType !== "document") mediaObj.caption = cap;

        const resp = await axios.post(
          `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`,
          { messaging_product: "whatsapp", recipient_type: "individual", to: recipientPhone, type: mediaType, [mediaType]: mediaObj },
          { headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" } },
        );
        waMessageId = resp.data?.messages?.[0]?.id || `out_${Date.now()}_${crypto.randomUUID()}`;
      }
    } catch (apiErr) {
      // Log the provider's exact rejection — invaluable if a payload shape needs tweaking.
      console.error("[sendMedia] provider error:", JSON.stringify(apiErr?.response?.data || apiErr.message));
      const { status, message } = describeWaApiError(apiErr, "sendMedia");
      return res.status(502).json({ error: message, providerStatus: status });
    }

    const preview = cap || `${{ image: "📷 Photo", video: "🎥 Video", audio: "🎤 Voice message", document: "📄 " + fileName }[mediaType]}`;

    const savedMsg = await WhatsAppMessage.create({
      conversation: conversationId,
      direction:    "outbound",
      body:         cap || fileName,
      messageType:  mediaType,
      mediaUrl,
      waMessageId,
      sentBy:       userId,
      status:       "sent",
      waTimestamp:  new Date(),
    });

    await WhatsAppConversation.findByIdAndUpdate(conversationId, {
      lastMessage:      preview,
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
          body:        cap || fileName,
          messageType: mediaType,
          mediaUrl,
          waTimestamp: new Date(),
          status:      "sent",
          sentBy:      { _id: userId, name: req.admin?.name || req.user?.name || "Admin" },
        },
        waPhone:   conversation.waPhone,
        companyId: companyId.toString(),
      };
      io.to("wa_admin").emit("wa_message", payload);
      io.to(`wa_agent_${conversation.assignedAgent?.toString()}`).emit("wa_message", payload);
      io.to(`wa_company_${companyId.toString()}`).emit("wa_message", payload);
    }

    res.json({ success: true, message: savedMsg });
  } catch (err) {
    console.error("sendMedia error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/whatsapp/messages/:id
// Edits the CRM's stored copy of an OUTBOUND message.
//
// ⚠ WhatsApp's Business API provides no way to edit or revoke a message that has
// already been delivered — the lead still sees the ORIGINAL text on their phone.
// This edit only corrects the record inside the CRM. The delivered text is
// preserved in originalBody so the true history is never lost.
//
// Inbound (lead) messages are deliberately NOT editable: rewriting what a
// customer said would falsify the record.
// ─────────────────────────────────────────────────────────────────────────────
const editMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    const { companyId, userId } = callerCtx(req);

    const newText = (text || "").trim();
    if (!newText) return res.status(400).json({ error: "Message text is required" });
    if (newText.length > 4096) return res.status(400).json({ error: "Message is too long (max 4096 characters)" });

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    if (msg.direction !== "outbound") {
      return res.status(403).json({
        error: "Only your own sent messages can be edited. A message received from the lead cannot be altered.",
      });
    }

    // Scope check — the message must belong to a conversation in this company.
    const conv = await WhatsAppConversation.findById(msg.conversation).select("company").lean();
    if (!conv || String(conv.company) !== String(companyId)) {
      return res.status(403).json({ error: "This message does not belong to your company" });
    }

    // Preserve what was actually delivered the first time it's edited.
    if (!msg.originalBody) msg.originalBody = msg.body || "";
    msg.body     = newText;
    msg.editedAt = new Date();
    msg.editedBy = userId || null;
    await msg.save();

    // Keep the conversation preview in sync if this was the latest message.
    await WhatsAppConversation.updateOne(
      { _id: msg.conversation, lastMessageAt: msg.waTimestamp },
      { $set: { lastMessage: newText } },
    );

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error("editMessage error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/messages/:id/refresh-media
// Re-attempts fetching a lead-sent attachment and re-hosting it publicly.
// Inbound media arrives as a private Meta URL (lookaside.fbsbx.com) that 401s
// in a browser, so it must be downloaded server-side and mirrored. If the
// mirror failed when the message first arrived (transient error, missing
// Cloudinary config, or no usable credential), this lets the agent retry from
// the chat and reports the specific reason on failure.
// ─────────────────────────────────────────────────────────────────────────────
const refreshMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = callerCtx(req);

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const conv = await WhatsAppConversation.findById(msg.conversation).select("company").lean();
    if (!conv || String(conv.company) !== String(companyId)) {
      return res.status(403).json({ error: "This message does not belong to your company" });
    }

    // Already publicly viewable — nothing to do.
    if (msg.mediaUrl && !/lookaside\.fbsbx\.com|graph\.facebook\.com/i.test(msg.mediaUrl)) {
      return res.json({ success: true, mediaUrl: msg.mediaUrl });
    }

    const source = msg.mediaUrl || msg.mediaId;
    if (!source || !/^https?:\/\//i.test(String(source))) {
      return res.status(400).json({
        error: "No downloadable link was received for this attachment, so it can't be recovered.",
      });
    }

    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    const { mirrorInboundMedia } = require("./msg91WebhookController");
    const outcome = await mirrorInboundMedia({
      rawUrl:         source,
      companyId,
      config,
      messageId:      msg._id,
      conversationId: msg.conversation,
      contentType:    msg.messageType,
    });

    const updated = await WhatsAppMessage.findById(id).select("mediaUrl").lean();
    const ok = updated?.mediaUrl && !/lookaside\.fbsbx\.com/i.test(updated.mediaUrl);
    if (!ok) {
      // Surface the provider's exact rejection so the cause is visible in the
      // UI without digging through server logs.
      return res.status(502).json({
        error: `WhatsApp refused the download — ${outcome?.reason || "unknown reason"}`,
      });
    }
    res.json({ success: true, mediaUrl: updated.mediaUrl });
  } catch (err) {
    console.error("refreshMedia error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/conversations/:id/mark-read
// Clears the stored unread count for a conversation.
//
// getConversationByLead already clears it when a chat is OPENED, but that misses
// the common case: the agent already has the chat open when a new message
// arrives. The webhook increments unreadCount, the socket shows the message
// (so it has effectively been read), yet nothing resets the counter — leaving a
// red badge that only disappeared after a full page refresh. The chat window
// calls this whenever it displays a message for the open conversation.
// ─────────────────────────────────────────────────────────────────────────────
const markConversationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = callerCtx(req);
    if (!companyId) return res.status(401).json({ error: "No company context" });

    const conv = await WhatsAppConversation.findOne({ _id: id, company: companyId }).select("_id unreadCount");
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    if ((conv.unreadCount || 0) !== 0) {
      await WhatsAppConversation.updateOne({ _id: id }, { $set: { unreadCount: 0 } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("markConversationRead error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getConversations,
  getMessages,
  sendMessage,
  sendMedia,
  editMessage,
  refreshMedia,
  markConversationRead,
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
};