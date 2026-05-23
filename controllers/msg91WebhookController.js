// controllers/msg91WebhookController.js
// Handles ALL incoming WhatsApp events from MSG91
//
// MSG91 WhatsApp inbound webhook — ACTUAL payload structure:
// {
//   "data": [{
//     "from": "919591327778",        ← sender phone
//     "to":   "919538281XXX1",       ← your integrated number
//     "type": "TEXT",                ← message type (may be uppercase)
//     "payload": { "text": "hello" },← message body is NESTED here
//     "id":   "wamid.xxx",           ← WhatsApp message ID
//     "timestamp": "1748001234",
//     "name": "Contact Name"
//   }]
// }
//
// Delivery/status updates arrive as a SEPARATE payload shape:
// { "data": [{ "id": "...", "status": "delivered", "timestamp": "..." }] }

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
  const unix = parseInt(ts);
  if (!isNaN(unix) && unix > 1000000000) return new Date(unix * 1000);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract the core item from whatever shape MSG91 sends.
// Handles: flat body, body.data[] array, body.data object (non-array)
// ─────────────────────────────────────────────────────────────────────────────
function extractItem(rawBody) {
  // Already flat (no data wrapper)
  if (!rawBody.data) return rawBody;

  // data is an array → take first element
  if (Array.isArray(rawBody.data) && rawBody.data.length > 0) {
    return rawBody.data[0];
  }

  // data is a plain object
  if (typeof rawBody.data === "object") {
    return rawBody.data;
  }

  return rawBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract the text of the message from all known MSG91 payload shapes:
//
//   item.payload.text          — MSG91 WhatsApp inbound (confirmed format)
//   item.text                  — some older shapes
//   item.message               — SMS / some WA shapes
//   item.body                  — rare fallback
// ─────────────────────────────────────────────────────────────────────────────
function extractText(item) {
  if (item.payload && typeof item.payload === "object") {
    if (item.payload.text)    return item.payload.text;
    if (item.payload.caption) return item.payload.caption;
    if (item.payload.url)     return item.payload.url;
  }
  return item.text || item.message || item.body || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine the sender phone from all known field names
// ─────────────────────────────────────────────────────────────────────────────
function extractSenderPhone(item) {
  return (
    item.from           ||  // ← MSG91 primary field
    item.mobile         ||
    item.customerNumber ||
    item.sender         ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine the content type from all known field names
// Normalise to lowercase — MSG91 often sends "TEXT" in uppercase
// ─────────────────────────────────────────────────────────────────────────────
function extractContentType(item) {
  const raw = (
    item.type        ||
    item.messageType ||
    item.contentType ||
    "text"
  ).toLowerCase();

  // Strip any leading direction prefix
  return raw.replace(/^(inbound|incoming|outbound)\s*/, "").trim() || "text";
}

// ─────────────────────────────────────────────────────────────────────────────
// Is this a delivery/status report rather than an inbound customer message?
//
// Delivery reports have a "status" field ("sent", "delivered", "read", "failed")
// and NO sender phone (the customer didn't send this — it's an ACK from WA).
// ─────────────────────────────────────────────────────────────────────────────
const DELIVERY_STATUSES = new Set(["sent", "delivered", "read", "failed", "outbound"]);

function isDeliveryReport(rawBody, item) {
  const topStatus = (rawBody.status || "").toLowerCase();
  const itemStatus = (item.status || "").toLowerCase();

  if (DELIVERY_STATUSES.has(topStatus)) return true;
  if (DELIVERY_STATUSES.has(itemStatus)) return true;

  const senderPhone = extractSenderPhone(item);
  if (!senderPhone && (item.id || item.requestId || item.uuid)) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /msg91-webhook/   or   POST /msg91-webhook/msg91
// MSG91 sends ALL WhatsApp events here
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  // Always ACK immediately — MSG91 retries if we don't respond fast
  res.sendStatus(200);

  try {
    const rawBody = req.body;

    // ── FULL RAW LOG — tells us exactly what MSG91 is sending ─────────────────
    console.log("📲 MSG91 Webhook RAW body:", JSON.stringify(rawBody, null, 2));

    if (!rawBody || typeof rawBody !== "object") {
      console.warn("⚠️  MSG91 webhook: empty or non-JSON body received");
      return;
    }

    const item = extractItem(rawBody);
    console.log("📲 MSG91 Webhook extracted item:", JSON.stringify(item, null, 2));

    // ── Delivery status update ─────────────────────────────────────────────────
    if (isDeliveryReport(rawBody, item)) {
      const msgId = item.id || item.requestId || item.uuid || rawBody.requestId || rawBody.uuid;
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
          console.log(`✅ Updated message ${msgId} → ${newStatus}`);
          const io = global._io;
          if (io) {
            io.to("wa_admin").emit("wa_message_status", {
              waMessageId: msgId,
              status: newStatus,
              conversationId: updated.conversation?.toString(),
            });
          }
        } else {
          console.log(`ℹ️  Delivery report for unknown message ${msgId} — skipping`);
        }
      }
      return;
    }

    // ── Inbound message ────────────────────────────────────────────────────────
    const rawPhone = extractSenderPhone(item);
    if (!rawPhone) {
      console.warn("⚠️  MSG91 inbound: no sender phone in payload");
      console.warn("   rawBody keys:", Object.keys(rawBody).join(", "));
      console.warn("   item keys:", Object.keys(item).join(", "));
      return;
    }

    const waPhone     = normalizePhone(rawPhone);
    const toNumber    = normalizePhone(item.to || item.integratedNumber || item.recipient || rawBody.to || "");
    const contactName = item.name || item.customerName || item.senderName || "";
    const msgText     = extractText(item);
    const contentType = extractContentType(item);
    const waMessageId =
      item.id         ||
      item.messageId  ||
      item.requestId  ||
      item.uuid       ||
      rawBody.requestId ||
      `msg91_${Date.now()}_${waPhone}`;

    const timestamp = parseTimestamp(item.timestamp || rawBody.timestamp);

    console.log(`📩 MSG91 inbound: from=${waPhone} to=${toNumber} type=${contentType} text="${msgText}" id=${waMessageId}`);

    if (waPhone.length < 10) {
      console.warn("⚠️  MSG91 inbound: invalid phone after normalise:", waPhone);
      return;
    }

    // ── Dedup ──────────────────────────────────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭  Dedup: already saved ${waMessageId}`);
      return;
    }

    // ── Find company config ────────────────────────────────────────────────────
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

    // ── Find or create conversation ────────────────────────────────────────────
    let conversation = await WhatsAppConversation.findOne({ waPhone, company: config.company });

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

    // ── Build message body from content type ───────────────────────────────────
    let msgBody      = "";
    let messageType  = "text";
    let mediaId      = null;
    let mediaCaption = null;

    if (["text", "inbound", "incoming"].includes(contentType)) {
      msgBody     = msgText || "";
      messageType = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(contentType)) {
      messageType  = contentType;
      mediaCaption = item.payload?.caption || item.caption || null;
      mediaId      = item.payload?.url || item.payload?.id || item.url || null;
      msgBody      = mediaCaption || mediaId || `[${contentType}]`;
    } else if (contentType === "location") {
      messageType = "location";
      const lat = item.payload?.latitude  || item.latitude  || "?";
      const lng = item.payload?.longitude || item.longitude || "?";
      msgBody = `📍 Location: ${lat}, ${lng}`;
    } else if (["button", "interactive", "list_reply", "button_reply"].includes(contentType)) {
      messageType = "text";
      msgBody =
        item.payload?.title       ||
        item.payload?.text        ||
        item.payload?.button_text ||
        msgText ||
        `[${contentType} reply]`;
    } else {
      messageType = "text";
      msgBody = msgText || `[${contentType}]`;
    }

    if (!msgBody) {
      msgBody = `[${contentType}]`;
      console.warn(`⚠️  Empty message body for type "${contentType}" — saved as placeholder`);
    }

    // ── Save message ───────────────────────────────────────────────────────────
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

    // ── Update conversation ────────────────────────────────────────────────────
    const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      msgBody,
      lastMessageAt:    timestamp,
      status:           "waiting",
      contactName:      contactName || conversation.contactName,
      sessionExpiresAt: sessionExpiry,
      $inc:             { unreadCount: 1 },
    });

    // ── Real-time push via socket ──────────────────────────────────────────────
    const io = global._io;
    if (io) {
      const payload = {
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
        io.to(`wa_agent_${conversation.assignedAgent.toString()}`).emit("wa_message", payload);
      }
      io.to("wa_admin").emit("wa_message", payload);
      console.log(`✅ Socket emitted wa_message to wa_admin for conv ${conversation._id}`);
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
// Helpers
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