// controllers/msg91WebhookController.js
// Handles ALL incoming WhatsApp events from MSG91
// Set this URL in MSG91 Dashboard → WhatsApp → Webhook:
//   https://your-backend-domain.com/msg91-webhook/msg91

const WhatsAppConfig       = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const Lead                 = require("../models/Leads");
const User                 = require("../models/Users");

// ─────────────────────────────────────────────────────────────────────────────
// POST /msg91-webhook/msg91
// MSG91 sends all WhatsApp events here
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  // Always respond 200 immediately — MSG91 retries if no quick response
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("📲 MSG91 Webhook received:", JSON.stringify(body, null, 2));

    // ── MSG91 actual payload fields ───────────────────────────────────────────
    // customerNumber = sender's phone (who messaged you)
    // integratedNumber = your business number
    // text = message text
    // messageType = type of message (text, image, etc.)
    // customerName = sender's name
    // requestId / uuid = unique message id
    // ts = timestamp
    // webhookType = "inbound" for incoming messages

    const webhookType = body.webhookType || body.type || "";

    // Only process inbound messages
    if (
      webhookType !== "inbound" &&
      webhookType !== "incoming" &&
      webhookType !== "message" &&
      !body.customerNumber
    ) {
      console.log(`⚠️  MSG91 webhook: skipping webhookType "${webhookType}"`);
      return;
    }

    // ── Extract fields from MSG91 payload ─────────────────────────────────────
    const waPhone     = (body.customerNumber || "").replace(/\D/g, "");
    const toNumber    = (body.integratedNumber || "").replace(/\D/g, "");
    const contactName = body.customerName || "";
    const msgText     = body.text || "";
    const msgType     = (body.messageType || body.contentType || "text").toLowerCase();
    const waMessageId = body.requestId || body.uuid || `msg91_${Date.now()}_${waPhone}`;
    const timestamp   = body.ts ? new Date(parseInt(body.ts) * 1000) : new Date();

    if (!waPhone) {
      console.warn("⚠️  MSG91 webhook: missing 'customerNumber', skipping");
      return;
    }

    // ── Dedup: skip if already processed ─────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭ Dedup: MSG91 message already saved ${waMessageId}`);
      return;
    }

    // ── Identify which company this number belongs to ─────────────────────────
    let config = await WhatsAppConfig.findOne({
      provider:              "msg91",
      msg91IntegratedNumber: toNumber,
      isActive:              true,
    });

    // Fallback: if only one MSG91 config exists use it
    if (!config) {
      config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true });
    }

    // Fallback: match env number
    if (!config && toNumber === (process.env.MSG91_INTEGRATED_NUMBER || "").replace(/\D/g, "")) {
      config = await WhatsAppConfig.findOne({ isActive: true });
    }

    if (!config) {
      console.error(`❌ MSG91 webhook: No active WhatsApp config found for number "${toNumber}"`);
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

    if (msgType === "text") {
      msgBody     = msgText || "";
      messageType = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(msgType)) {
      messageType  = msgType;
      mediaCaption = body.caption || null;
      msgBody      = body.caption || body.filename || body.url || `[${msgType}]`;
      mediaId      = body.url || null;
    } else if (msgType === "location") {
      messageType = "location";
      msgBody     = `📍 Location: ${body.latitude}, ${body.longitude}`;
    } else if (msgType === "button") {
      messageType = "text";
      msgBody     = body.button || msgText || "[button reply]";
    } else if (msgType === "interactive") {
      messageType = "text";
      msgBody     = body.interactive || msgText || "[interactive reply]";
    } else {
      messageType = "unknown";
      msgBody     = msgText || `[${msgType} message]`;
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

    console.log(`📩 MSG91 WA inbound: ${waPhone} → "${msgBody.substring(0, 60)}"`);

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