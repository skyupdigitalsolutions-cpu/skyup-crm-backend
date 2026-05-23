// controllers/msg91WebhookController.js
// Handles ALL incoming WhatsApp events from MSG91
//
// ACTUAL MSG91 flat payload (confirmed from production logs 2026-05-23):
// {
//   "customerNumber":  "919538281101",   ← sender (lead's phone)
//   "integratedNumber":"919591327778",   ← your WA number
//   "customerName":    "SJSJASSS",
//   "contentType":     "text",
//   "text":            "Hello",          ← message text (flat, NOT nested)
//   "uuid":            "wamid.xxx",      ← message ID
//   "ts":              "2026-05-23T...", ← timestamp
//   "messageType":     "text"
// }
//
// Delivery/status updates have a "status" field: "delivered", "read", etc.

const WhatsAppConfig       = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const Lead                 = require("../models/Leads");
const User                 = require("../models/Users");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

function parseTimestamp(ts) {
  if (!ts) return new Date();
  // ISO string (e.g. "2026-05-23T14:43:32+05:30")
  const d = new Date(ts);
  if (!isNaN(d.getTime())) return d;
  // Unix epoch seconds
  const unix = parseInt(ts);
  if (!isNaN(unix) && unix > 1_000_000_000) return new Date(unix * 1000);
  return new Date();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract the core item — handles both flat payloads and data[] wrapped ones
// ─────────────────────────────────────────────────────────────────────────────
function extractItem(rawBody) {
  if (!rawBody.data) return rawBody;
  if (Array.isArray(rawBody.data) && rawBody.data.length > 0) return rawBody.data[0];
  if (typeof rawBody.data === "object") return rawBody.data;
  return rawBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract sender phone — covers all known MSG91 field names
// ─────────────────────────────────────────────────────────────────────────────
function extractSenderPhone(item) {
  return (
    item.customerNumber ||   // ← confirmed field in production payload
    item.from           ||
    item.mobile         ||
    item.sender         ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract recipient (your integrated number)
// ─────────────────────────────────────────────────────────────────────────────
function extractRecipientNumber(item, rawBody) {
  return (
    item.integratedNumber ||  // ← confirmed field in production payload
    item.to               ||
    item.recipient        ||
    rawBody.integratedNumber ||
    rawBody.to            ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract message text — flat "text" field confirmed in production
// ─────────────────────────────────────────────────────────────────────────────
function extractText(item) {
  // Flat text field (confirmed production format)
  if (item.text && typeof item.text === "string" && item.text.trim()) return item.text.trim();
  // Nested payload object (older/alternate format)
  if (item.payload && typeof item.payload === "object") {
    if (item.payload.text)    return item.payload.text;
    if (item.payload.caption) return item.payload.caption;
    if (item.payload.url)     return item.payload.url;
  }
  return item.message || item.body || item.caption || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract content type — "contentType" confirmed in production payload
// ─────────────────────────────────────────────────────────────────────────────
function extractContentType(item) {
  const raw = (
    item.contentType ||   // ← confirmed field in production payload
    item.type        ||
    item.messageType ||
    "text"
  ).toLowerCase();
  return raw.replace(/^(inbound|incoming|outbound)\s*/, "").trim() || "text";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract message ID — "uuid" confirmed in production payload
// ─────────────────────────────────────────────────────────────────────────────
function extractMessageId(item, rawBody, waPhone) {
  return (
    item.uuid       ||   // ← confirmed field in production payload
    item.id         ||
    item.messageId  ||
    item.requestId  ||
    rawBody.uuid    ||
    rawBody.requestId ||
    `msg91_${Date.now()}_${waPhone}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract contact name — "customerName" confirmed in production payload
// ─────────────────────────────────────────────────────────────────────────────
function extractContactName(item) {
  return item.customerName || item.name || item.senderName || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract timestamp — "ts" confirmed in production payload
// ─────────────────────────────────────────────────────────────────────────────
function extractTimestamp(item, rawBody) {
  return parseTimestamp(
    item.ts        ||   // ← confirmed field in production payload
    item.timestamp ||
    rawBody.ts     ||
    rawBody.timestamp ||
    rawBody.requestedAt ||
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Is this a delivery/status report?
// ONLY treat as delivery report if there is an explicit delivery status value.
// Never use the absence of a sender phone as a signal — real inbound messages
// may have phone in customerNumber which was historically not checked first.
// ─────────────────────────────────────────────────────────────────────────────
const DELIVERY_STATUSES = new Set(["sent", "delivered", "read", "failed", "outbound"]);

function isDeliveryReport(rawBody, item) {
  const topStatus  = (rawBody.status || "").toLowerCase();
  const itemStatus = (item.status   || "").toLowerCase();
  return DELIVERY_STATUSES.has(topStatus) || DELIVERY_STATUSES.has(itemStatus);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /msg91-webhook/   or   POST /msg91-webhook/msg91
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  res.sendStatus(200); // ACK immediately

  try {
    const rawBody = req.body;
    console.log("📲 MSG91 Webhook RAW body:", JSON.stringify(rawBody, null, 2));

    if (!rawBody || typeof rawBody !== "object") {
      console.warn("⚠️  MSG91 webhook: empty or non-JSON body");
      return;
    }

    const item = extractItem(rawBody);
    console.log("📲 MSG91 Webhook extracted item:", JSON.stringify(item, null, 2));

    // ── Delivery status update ────────────────────────────────────────────────
    if (isDeliveryReport(rawBody, item)) {
      const msgId     = item.uuid || item.id || item.requestId || rawBody.uuid || rawBody.requestId;
      const rawStatus = (item.status || rawBody.status || "").toLowerCase();
      const statusMap = { sent: "sent", delivered: "delivered", read: "read", failed: "failed", outbound: "sent" };
      const newStatus = statusMap[rawStatus] || "sent";

      console.log(`📬 MSG91 delivery report: status="${rawStatus}" msgId="${msgId}"`);

      if (msgId) {
        const updated = await WhatsAppMessage.findOneAndUpdate(
          { waMessageId: msgId },
          { status: newStatus },
          { new: true }
        );
        if (updated) {
          const io = global._io;
          if (io) {
            io.to("wa_admin").emit("wa_message_status", {
              waMessageId:    msgId,
              status:         newStatus,
              conversationId: updated.conversation?.toString(),
            });
          }
          console.log(`✅ Updated message ${msgId} → ${newStatus}`);
        }
      }
      return;
    }

    // ── Inbound message ───────────────────────────────────────────────────────
    const rawPhone = extractSenderPhone(item);
    if (!rawPhone) {
      console.warn("⚠️  MSG91 inbound: no sender phone — rawBody keys:", Object.keys(rawBody).join(", "));
      return;
    }

    const waPhone     = normalizePhone(rawPhone);
    const toRaw       = extractRecipientNumber(item, rawBody);
    const toNumber    = normalizePhone(toRaw);
    const contactName = extractContactName(item);
    const msgText     = extractText(item);
    const contentType = extractContentType(item);
    const waMessageId = extractMessageId(item, rawBody, waPhone);
    const timestamp   = extractTimestamp(item, rawBody);

    console.log(`📩 MSG91 inbound: from=${waPhone} to=${toNumber} type=${contentType} text="${msgText}" id=${waMessageId}`);

    if (waPhone.length < 10) {
      console.warn("⚠️  MSG91 inbound: invalid phone after normalise:", waPhone);
      return;
    }

    // ── Dedup ─────────────────────────────────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭  Dedup: already saved ${waMessageId}`);
      return;
    }

    // ── Find company config ───────────────────────────────────────────────────
    let config = null;
    if (toNumber) {
      config = await WhatsAppConfig.findOne({
        provider: "msg91",
        $or: [
          { msg91IntegratedNumber: toNumber },
          { msg91IntegratedNumber: "+" + toNumber },
          { msg91IntegratedNumber: toNumber.replace(/^\+/, "") },
        ],
        isActive: true,
      });
    }
    if (!config) config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true });
    if (!config) config = await WhatsAppConfig.findOne({ isActive: true });

    if (!config) {
      console.error("❌ MSG91 inbound: no active WhatsApp config found");
      return;
    }

    // ── Find conversation — deduplicate if multiple exist for same phone ───────
    // FIX: When there are duplicate conversations for the same waPhone (which
    // can happen if the admin started one via startConversation and the webhook
    // created another), always pick the MOST RECENTLY ACTIVE one so both the
    // admin's sent messages and the lead's reply live in the same conversation.
    const allConversations = await WhatsAppConversation.find({
      waPhone,
      company: config.company,
    }).sort({ lastMessageAt: -1, createdAt: -1 });

    let conversation = allConversations[0] || null;

    // If multiple conversations exist for this phone, merge duplicates:
    // keep the most recent one, delete the rest (they were empty/stale)
    if (allConversations.length > 1) {
      console.warn(`⚠️  Found ${allConversations.length} conversations for ${waPhone} — using most recent: ${conversation._id}`);
      const staleIds = allConversations.slice(1).map(c => c._id);
      // Only delete truly empty ones (no messages) to avoid data loss
      for (const staleId of staleIds) {
        const msgCount = await WhatsAppMessage.countDocuments({ conversation: staleId });
        if (msgCount === 0) {
          await WhatsAppConversation.findByIdAndDelete(staleId);
          console.log(`🗑  Deleted empty duplicate conversation ${staleId}`);
        }
      }
    }

    if (!conversation) {
      const lead          = await findLeadByPhone(waPhone, config.company);
      const assignedAgent = await getAvailableAgent(config.company);

      conversation = await WhatsAppConversation.create({
        waPhone,
        contactName,
        lead:          lead?._id || null,
        assignedAgent: assignedAgent?._id || null,
        company:       config.company,
        status:        "open",
      });
      console.log(`🆕 New WA conversation: ${waPhone} → ${conversation._id}`);
    }

    // ── Build message body ────────────────────────────────────────────────────
    let msgBody     = "";
    let messageType = "text";
    let mediaId     = null;
    let mediaCaption = null;

    if (["text", "inbound", "incoming"].includes(contentType)) {
      msgBody     = msgText || "";
      messageType = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(contentType)) {
      messageType  = contentType;
      mediaCaption = item.caption || item.payload?.caption || null;
      mediaId      = item.url || item.payload?.url || item.payload?.id || null;
      msgBody      = mediaCaption || mediaId || `[${contentType}]`;
    } else if (contentType === "location") {
      messageType = "location";
      const lat = item.latitude  || item.payload?.latitude  || "?";
      const lng = item.longitude || item.payload?.longitude || "?";
      msgBody = `📍 Location: ${lat}, ${lng}`;
    } else if (["button", "interactive", "list_reply", "button_reply"].includes(contentType)) {
      messageType = "text";
      msgBody = item.button || item.payload?.title || item.payload?.text || msgText || `[${contentType} reply]`;
    } else {
      messageType = "text";
      msgBody = msgText || `[${contentType}]`;
    }

    if (!msgBody) {
      msgBody = `[${contentType}]`;
      console.warn(`⚠️  Empty message body for type "${contentType}" — saved as placeholder`);
    }

    // ── Save message ──────────────────────────────────────────────────────────
    const savedMsg = await WhatsAppMessage.create({
      conversation: conversation._id,
      direction:    "inbound",
      body:         msgBody,
      messageType,
      waMessageId,
      mediaId,
      mediaCaption,
      sentBy:       null,
      status:       "delivered",
      waTimestamp:  timestamp,
    });

    // ── Update conversation — reset 24h session window ────────────────────────
    const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      msgBody,
      lastMessageAt:    timestamp,
      status:           "waiting",
      contactName:      contactName || conversation.contactName,
      sessionExpiresAt: sessionExpiry,
      $inc:             { unreadCount: 1 },
    });

    // ── Socket push ───────────────────────────────────────────────────────────
    const io = global._io;
    if (io) {
      const socketPayload = {
        type:             "wa_new_message",
        conversationId:   conversation._id.toString(),
        sessionExpiresAt: sessionExpiry.toISOString(),
        message: {
          _id:         savedMsg._id.toString(),
          direction:   "inbound",
          body:        msgBody,
          messageType,
          waTimestamp: timestamp,
          status:      "delivered",
        },
        waPhone,
        contactName:   contactName || conversation.contactName,
        companyId:     config.company.toString(),
        assignedAgent: conversation.assignedAgent?.toString(),
      };

      if (conversation.assignedAgent) {
        io.to(`wa_agent_${conversation.assignedAgent.toString()}`).emit("wa_message", socketPayload);
      }
      io.to("wa_admin").emit("wa_message", socketPayload);
      console.log(`✅ Socket emitted wa_message to wa_admin for conv ${conversation._id}`);
      console.log(`   sessionExpiresAt reset to: ${sessionExpiry.toISOString()}`);
    } else {
      console.warn("⚠️  global._io not set — socket not emitted");
    }

    console.log(`✅ Inbound saved: ${waPhone} → "${msgBody.substring(0, 80)}" [${messageType}]`);

  } catch (err) {
    console.error("❌ MSG91 webhook error:", err.message);
    console.error(err.stack);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
async function findLeadByPhone(waPhone, companyId) {
  const lastTen = waPhone.slice(-10);
  return Lead.findOne({
    company: companyId,
    $or: [
      { mobile: waPhone },
      { mobile: lastTen },
      { mobile: `+${waPhone}` },
    ],
  });
}

async function getAvailableAgent(companyId) {
  const agents = await User.find({ company: companyId, role: "user" }).lean();
  if (!agents.length) return null;

  const counts = await WhatsAppConversation.aggregate([
    { $match: { company: companyId, status: { $in: ["open", "waiting"] } } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  counts.forEach(c => { countMap[c._id?.toString()] = c.count; });
  agents.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));
  return agents[0];
}

module.exports = { receiveMSG91Webhook };