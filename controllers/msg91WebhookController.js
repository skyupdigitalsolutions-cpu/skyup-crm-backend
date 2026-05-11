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

    // MSG91 payload structure:
    // { data: { from, to, type, text: { body }, id, timestamp }, event }
    const event = body.event || body.type;

    // Only process inbound messages
    if (event !== "message" && event !== "incoming" && !body.data?.from) {
      console.log(`⚠️  MSG91 webhook: skipping event "${event}"`);
      return;
    }

    const data = body.data || body;

    const waPhone     = (data.from || "").replace(/\D/g, "");  // strip non-digits
    const waMessageId = data.id || data.message_id || `msg91_${Date.now()}_${waPhone}`;
    const timestamp   = data.timestamp ? new Date(parseInt(data.timestamp) * 1000) : new Date();
    const contactName = data.contact_name || data.profile?.name || "";

    if (!waPhone) {
      console.warn("⚠️  MSG91 webhook: missing 'from' phone number, skipping");
      return;
    }

    // ── Dedup: skip if already processed ─────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭ Dedup: MSG91 message already saved ${waMessageId}`);
      return;
    }

    // ── Identify which company this number belongs to ─────────────────────────
    // MSG91 sends to: data.to  (your integrated number)
    const toNumber = (data.to || "").replace(/\D/g, "");

    // Find config by integrated number (DB) or env
    let config = await WhatsAppConfig.findOne({
      provider:              "msg91",
      msg91IntegratedNumber: toNumber,
      isActive:              true,
    });

    // Fallback: if only one MSG91 config exists in the system use it
    if (!config) {
      config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true });
    }

    // Fallback: use .env number match
    if (!config && toNumber === (process.env.MSG91_INTEGRATED_NUMBER || "").replace(/\D/g, "")) {
      // Try to find any active config — first company wins (single-tenant)
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
    let msgBody     = "";
    let messageType = "text";
    let mediaId     = null;
    let mediaCaption = null;

    const msgType = data.type || "text";

    if (msgType === "text") {
      msgBody      = data.text?.body || data.message || data.body || "";
      messageType  = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(msgType)) {
      messageType  = msgType;
      mediaId      = data[msgType]?.id || data.media_id || null;
      mediaCaption = data[msgType]?.caption || null;
      msgBody      = mediaCaption || `[${msgType}]`;
    } else if (msgType === "location") {
      messageType = "location";
      msgBody     = `📍 Location: ${data.location?.name || `${data.location?.latitude}, ${data.location?.longitude}`}`;
    } else {
      messageType = "unknown";
      msgBody     = `[${msgType} message]`;
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