// controllers/whatsappWebhookController.js
// Handles ALL incoming events from Meta WhatsApp Cloud API

const axios                  = require("axios");
const WhatsAppConfig         = require("../models/WhatsAppConfig");
const WhatsAppConversation   = require("../models/WhatsAppConversation");
const WhatsAppMessage        = require("../models/WhatsAppMessage");
const Lead                   = require("../models/Leads");
const User                   = require("../models/Users");

// ─────────────────────────────────────────────────────────────────────────────
// GET /wa-webhook  — Meta's one-time verification handshake
// ─────────────────────────────────────────────────────────────────────────────
const verifyWebhook = async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`📲 WA Webhook verify — mode: "${mode}", token: "${token}"`);

  if (mode !== "subscribe") return res.sendStatus(403);

  try {
    // Check if this verify token matches any company's WA config
    const config = await WhatsAppConfig.findOne({
      verifyToken: token,
      isActive: true,
    });

    if (config) {
      console.log(`✅ WA Webhook verified for company: ${config.company}`);
      return res.status(200).send(challenge);
    }
  } catch (err) {
    console.error("❌ WA webhook verify DB error:", err.message);
  }

  console.warn(`❌ WA Webhook token mismatch: "${token}"`);
  return res.sendStatus(403);
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /wa-webhook  — Receive all WA events (messages, status updates, etc.)
// ─────────────────────────────────────────────────────────────────────────────
const receiveWebhook = async (req, res) => {
  // CRITICAL: Always respond 200 first — Meta marks as failed if > 5s
  res.sendStatus(200);

  try {
    const body = req.body;

    // Only process WhatsApp Business Account events
    if (body.object !== "whatsapp_business_account") {
      console.log(`⚠️  WA Webhook: unexpected object type "${body.object}"`);
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value;

        // Find which company owns this phone number ID
        const config = await WhatsAppConfig.findOne({
          phoneNumberId: value.metadata?.phone_number_id,
          isActive: true,
        });

        if (!config) {
          console.error(`❌ No WA config for phone_number_id: ${value.metadata?.phone_number_id}`);
          continue;
        }

        // ── Handle inbound messages ─────────────────────────────────────────
        if (value.messages?.length) {
          for (const msg of value.messages) {
            await handleInboundMessage(msg, value, config);
          }
        }

        // ── Handle status updates (sent/delivered/read/failed) ──────────────
        if (value.statuses?.length) {
          for (const status of value.statuses) {
            await handleStatusUpdate(status);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ WA Webhook processing error:", err.message);
    console.error(err.stack);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Process one inbound WhatsApp message
// ─────────────────────────────────────────────────────────────────────────────
async function handleInboundMessage(msg, value, config) {
  const waPhone     = msg.from;   // e.g., "919876543210"
  const waMessageId = msg.id;
  const timestamp   = new Date(parseInt(msg.timestamp) * 1000);

  // Prevent duplicate processing (Meta can send same message twice)
  const exists = await WhatsAppMessage.findOne({ waMessageId });
  if (exists) {
    console.log(`⏭ Duplicate WA message: ${waMessageId}`);
    return;
  }

  // Extract contact name from profile if available
  const contactName = value.contacts?.[0]?.profile?.name || "";

  // ── Find or create conversation ───────────────────────────────────────────
  let conversation = await WhatsAppConversation.findOne({
    waPhone,
    company: config.company,
  });

  if (!conversation) {
    // Try to link to an existing lead by mobile number
    // Leads store mobile as plain digits; WA sends with country code
    const lead = await findLeadByPhone(waPhone, config.company);

    // Auto-assign to least-busy agent using round-robin
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

  // ── Extract message content ───────────────────────────────────────────────
  let body        = "";
  let messageType = "unknown";
  let mediaId     = null;
  let mediaCaption = null;

  if (msg.type === "text") {
    body        = msg.text?.body || "";
    messageType = "text";
  } else if (["image", "document", "audio", "video", "sticker"].includes(msg.type)) {
    messageType  = msg.type;
    mediaId      = msg[msg.type]?.id || null;
    mediaCaption = msg[msg.type]?.caption || null;
    body         = mediaCaption || `[${msg.type}]`;
  } else if (msg.type === "location") {
    messageType = "location";
    body        = `📍 Location: ${msg.location?.name || `${msg.location?.latitude}, ${msg.location?.longitude}`}`;
  } else if (msg.type === "reaction") {
    messageType = "reaction";
    body        = msg.reaction?.emoji || "👍";
  } else {
    messageType = "unknown";
    body        = `[${msg.type} message]`;
  }

  // ── Save the message ──────────────────────────────────────────────────────
  const savedMsg = await WhatsAppMessage.create({
    conversation: conversation._id,
    direction:    "inbound",
    body,
    messageType,
    waMessageId,
    mediaId,
    mediaCaption,
    sentBy:      null,
    status:      "delivered",
    waTimestamp: timestamp,
  });

  // ── Update conversation metadata ──────────────────────────────────────────
  const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
  await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
    lastMessage:      body,
    lastMessageAt:    timestamp,
    status:           "waiting",  // agent needs to reply
    contactName:      contactName || conversation.contactName,
    sessionExpiresAt: sessionExpiry,
    $inc: { unreadCount: 1 },
  });

  // ── Emit to agent and admin via Socket.io ─────────────────────────────────
  const io = global._io;
  if (io) {
    const payload = {
      type:           "wa_new_message",
      conversationId: conversation._id.toString(),
      message: {
        _id:         savedMsg._id.toString(),
        direction:   "inbound",
        body,
        messageType,
        waTimestamp: timestamp,
        status:      "delivered",
      },
      waPhone,
      contactName:    contactName || conversation.contactName,
      companyId:      config.company.toString(),
      assignedAgent:  conversation.assignedAgent?.toString(),
    };

    // Notify the assigned agent's room
    if (conversation.assignedAgent) {
      io.to(`wa_agent_${conversation.assignedAgent.toString()}`).emit("wa_message", payload);
    }

    // Always notify admin room
    io.to("wa_admin").emit("wa_message", payload);
  }

  console.log(`📩 WA inbound: ${waPhone} → "${body.substring(0, 60)}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Update message delivery status
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatusUpdate(status) {
  const { id: waMessageId, status: newStatus, recipient_id } = status;

  await WhatsAppMessage.findOneAndUpdate(
    { waMessageId },
    { status: newStatus }
  );

  // Emit status update to frontend in real-time
  const io = global._io;
  if (io) {
    io.to("wa_admin").emit("wa_status_update", {
      waMessageId,
      status: newStatus,
      recipientPhone: recipient_id,
    });
  }

  console.log(`📊 WA status update: ${waMessageId} → ${newStatus}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Find an existing Lead by their WhatsApp phone number
// ─────────────────────────────────────────────────────────────────────────────
async function findLeadByPhone(waPhone, companyId) {
  // WA phone: "919876543210" (with country code, no +)
  // Lead mobile: could be "9876543210" (10 digits) or "919876543210"
  // Try both formats
  const lastTen = waPhone.slice(-10);

  const lead = await Lead.findOne({
    company: companyId,
    $or: [
      { mobile: waPhone },
      { mobile: lastTen },
      { mobile: `+${waPhone}` },
    ],
  });

  return lead;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get least-busy available agent in a company (round-robin)
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableAgent(companyId) {
  const agents = await User.find({ company: companyId, role: "user" }).lean();
  if (!agents.length) return null;

  // Count open WA conversations per agent
  const counts = await WhatsAppConversation.aggregate([
    { $match: { company: companyId, status: { $in: ["open", "waiting"] } } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  counts.forEach(c => { countMap[c._id?.toString()] = c.count; });

  // Sort by fewest open conversations
  agents.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));

  return agents[0];
}

module.exports = { verifyWebhook, receiveWebhook };