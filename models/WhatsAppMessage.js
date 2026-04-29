const mongoose = require("mongoose");

// One document = one WhatsApp message (inbound or outbound)
const whatsAppMessageSchema = new mongoose.Schema(
  {
    // Parent conversation thread
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppConversation",
      required: true,
    },

    // "inbound"  = message received FROM the customer/lead
    // "outbound" = message sent BY agent to customer
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },

    // Message content
    body: {
      type: String,
      default: "",
    },

    // Message type — text is most common; others for media/interactive
    messageType: {
      type: String,
      enum: ["text", "image", "document", "audio", "video", "sticker", "location", "template", "interactive", "reaction", "unknown"],
      default: "text",
    },

    // Meta's own message ID — used to prevent duplicates and track delivery status
    waMessageId: {
      type: String,
      unique: true,
      sparse: true, // outbound messages get this after Meta confirms
      trim: true,
    },

    // For media messages — URL to download the media from Meta
    mediaId: {
      type: String,
      default: null,
    },

    mediaUrl: {
      type: String,
      default: null,
    },

    mediaMimeType: {
      type: String,
      default: null,
    },

    mediaCaption: {
      type: String,
      default: null,
    },

    // For outbound: which agent sent this (null = system/auto)
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Message delivery/read status (updated via Meta status webhooks)
    // sent → delivered → read (or failed)
    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
    },

    // Exact time Meta received/sent the message (from webhook timestamp)
    waTimestamp: {
      type: Date,
      default: Date.now,
    },

    // Is this a template message? (required for messages after 24h window)
    isTemplate: {
      type: Boolean,
      default: false,
    },

    templateName: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Index for fast conversation history retrieval
whatsAppMessageSchema.index({ conversation: 1, waTimestamp: 1 });

module.exports = mongoose.model("WhatsAppMessage", whatsAppMessageSchema);