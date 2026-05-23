// controllers/msg91WebhookController.js
// Handles ALL incoming WhatsApp events from MSG91
// Set this URL in MSG91 Dashboard → WhatsApp → Webhook:
//   https://your-backend-domain.com/msg91-webhook/msg91

const WhatsAppConfig       = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const Lead                 = require("../models/Leads");
const User                 = require("../models/Users");

function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

function parseTimestamp(ts, messagesStr) {
  try {
    if (messagesStr) {
      const msgs = typeof messagesStr === "string" ? JSON.parse(messagesStr) : messagesStr;
      if (msgs?.[0]?.timestamp) {
        const unix = parseInt(msgs[0].timestamp);
        if (!isNaN(unix) && unix > 1000000000) return new Date(unix * 1000);
      }
    }
  } catch (_) {}
  if (ts) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /msg91-webhook/msg91
// MSG91 sends ALL WhatsApp events here — inbound messages AND delivery reports
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  // Always respond 200 immediately — MSG91 retries if no quick ack
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("📲 MSG91 Webhook received:", JSON.stringify(body, null, 2));

    // ── Detect event type ─────────────────────────────────────────────────────
    // MSG91 sends different shapes for inbound messages vs delivery reports.
    // webhookType / type / event can be:
    //   inbound / incoming / message   → client sent us a message
    //   outbound / sent / delivered / read / failed → delivery status update for our outbound message
    const webhookType = (
      body.webhookType || body.type || body.event || ""
    ).toLowerCase();

    const isDeliveryReport = (
      webhookType === "outbound"  ||
      webhookType === "sent"      ||
      webhookType === "delivered" ||
      webhookType === "read"      ||
      webhookType === "failed"    ||
      // MSG91 sometimes sends delivery reports with a requestId but no customerNumber
      (!body.customerNumber && (body.requestId || body.uuid) && !body.text)
    );

    // ── Handle delivery status update (outbound report) ───────────────────────
    if (isDeliveryReport) {
      const msgId = body.requestId || body.uuid || body.messageId;
      console.log(`📬 MSG91 delivery report: type="${webhookType}" msgId="${msgId}"`);

      if (msgId) {
        // Map MSG91 status to our status
        const statusMap = {
          sent:      "sent",
          delivered: "delivered",
          read:      "read",
          failed:    "failed",
          outbound:  "sent",
        };
        const newStatus = statusMap[webhookType] || "sent";

        // Update message status in DB if we have a record
        const updated = await WhatsAppMessage.findOneAndUpdate(
          { waMessageId: msgId },
          { status: newStatus },
          { new: true }
        );

        if (updated) {
          console.log(`✅ Updated message ${msgId} status → ${newStatus}`);
          // Emit real-time status update to admin
          const io = global._io;
          if (io) {
            io.to("wa_admin").emit("wa_message_status", {
              waMessageId: msgId,
              status: newStatus,
              conversationId: updated.conversation?.toString(),
            });
          }
        } else {
          console.log(`ℹ️  Delivery report for unknown message ${msgId} — ignoring`);
        }
      }
      return;
    }

    // ── Handle inbound message ────────────────────────────────────────────────
    // MSG91 payload fields for inbound:
    //   customerNumber  — sender's phone (the client)
    //   integratedNumber — your WhatsApp business number
    //   text            — message text
    //   messageType / contentType — type of message
    //   uuid / requestId — unique message id

    // Some MSG91 payload shapes use different field names — handle all variants
    const rawPhone =
      body.customerNumber ||
      body.from           ||
      body.sender         ||
      body.mobile         ||
      "";

    if (!rawPhone) {
      console.warn("⚠️  MSG91 webhook: no sender phone found in payload, skipping");
      console.warn("Payload keys:", Object.keys(body).join(", "));
      return;
    }

    const waPhone     = normalizePhone(rawPhone);
    const toNumber    = normalizePhone(
      body.integratedNumber || body.to || body.recipient || ""
    );
    const contactName = body.customerName || body.name || body.senderName || "";
    const msgText     = body.text || body.message || body.body || "";
    const msgType     = (
      body.messageType || body.contentType || body.type || "text"
    ).toLowerCase();
    const waMessageId =
      body.uuid       ||
      body.requestId  ||
      body.messageId  ||
      `msg91_${Date.now()}_${waPhone}`;

    const timestamp = parseTimestamp(body.ts || body.timestamp, body.messages);

    if (!waPhone || waPhone.length < 10) {
      console.warn("⚠️  MSG91 webhook: invalid phone number, skipping");
      return;
    }

    // ── Dedup: skip if already processed ─────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭ Dedup: MSG91 message already saved ${waMessageId}`);
      return;
    }

    // ── Identify which company this number belongs to ─────────────────────────
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

    // Fallback: first active MSG91 config regardless of number match
    if (!config) {
      config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true });
    }

    // Last resort: any active config
    if (!config) {
      config = await WhatsAppConfig.findOne({ isActive: true });
    }

    if (!config) {
      console.error(`❌ MSG91 webhook: No active WhatsApp config found`);
      return;
    }

    // ── Find or create conversation ───────────────────────────────────────────
    let conversation = await WhatsAppConversation.findOne({
      waPhone,
      company: config.company,
    });

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

      console.log(`🆕 New WA conversation (MSG91): ${waPhone} → ${conversation._id}`);
    }

    // ── Extract message content ───────────────────────────────────────────────
    let msgBody      = "";
    let messageType  = "text";
    let mediaId      = null;
    let mediaCaption = null;

    // Remove "inbound" / "incoming" from type for content parsing
    const contentType = msgType.replace(/^(inbound|incoming|outbound)\s*/, "").trim() || "text";

    if (contentType === "text" || contentType === "inbound" || contentType === "incoming") {
      msgBody     = msgText || "";
      messageType = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(contentType)) {
      messageType  = contentType;
      mediaCaption = body.caption || null;
      msgBody      = body.caption || body.filename || body.url || `[${contentType}]`;
      mediaId      = body.url || null;
    } else if (contentType === "location") {
      messageType = "location";
      msgBody     = `📍 Location: ${body.latitude}, ${body.longitude}`;
    } else if (contentType === "button") {
      messageType = "text";
      msgBody     = body.button || msgText || "[button reply]";
    } else if (contentType === "interactive") {
      messageType = "text";
      msgBody     = body.interactive || msgText || "[interactive reply]";
    } else {
      // Unknown type — still save with raw text if available
      messageType = "text";
      msgBody     = msgText || `[${contentType} message]`;
    }

    if (!msgBody) {
      console.warn(`⚠️  MSG91 webhook: empty message body for type "${msgType}" — saving anyway`);
      msgBody = `[${msgType}]`;
    }

    // ── Save the inbound message ──────────────────────────────────────────────
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

    // ── Update conversation ───────────────────────────────────────────────────
    const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      msgBody,
      lastMessageAt:    timestamp,
      status:           "waiting",
      contactName:      contactName || conversation.contactName,
      sessionExpiresAt: sessionExpiry,
      $inc:             { unreadCount: 1 },
    });

    // ── Emit real-time event via Socket.io ────────────────────────────────────
    const io = global._io;
    if (io) {
      const payload = {
        type:           "wa_new_message",
        conversationId: conversation._id.toString(),
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
    }

    console.log(`📩 MSG91 WA inbound: ${waPhone} → "${msgBody.substring(0, 60)}" @ ${timestamp}`);

  } catch (err) {
    console.error("❌ MSG91 webhook processing error:", err.message);
    console.error(err.stack);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Find a Lead by WhatsApp phone number
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Assign to least-busy agent (round-robin)
// ─────────────────────────────────────────────────────────────────────────────
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