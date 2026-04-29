const mongoose = require("mongoose");

// One document = one WhatsApp thread with one lead/contact
// A conversation is created when a lead sends their first WA message
// OR when an agent initiates a conversation from the CRM
const whatsAppConversationSchema = new mongoose.Schema(
  {
    // The lead this conversation belongs to (linked by phone number)
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null, // null if lead not yet identified (unknown number)
    },

    // The WhatsApp phone number of the contact (always in international format, no +)
    // e.g., "919876543210" for +91 98765 43210
    waPhone: {
      type: String,
      required: true,
      trim: true,
    },

    // Display name from WhatsApp profile (if available)
    contactName: {
      type: String,
      default: "",
      trim: true,
    },

    // The agent assigned to this conversation
    assignedAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Company this conversation belongs to
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    // open = agent can chat | closed = resolved | waiting = customer replied, agent hasn't
    status: {
      type: String,
      enum: ["open", "closed", "waiting"],
      default: "open",
    },

    // Cache the last message for quick display in sidebar list
    lastMessage: {
      type: String,
      default: "",
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },

    // Number of unread messages for assigned agent
    unreadCount: {
      type: Number,
      default: 0,
    },

    // WhatsApp 24-hour session window: customers must message first OR
    // you must use template messages after 24h silence
    // Track when the customer last messaged to know if session is open
    sessionExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Index for fast lookups by phone + company
whatsAppConversationSchema.index({ waPhone: 1, company: 1 }, { unique: true });

module.exports = mongoose.model("WhatsAppConversation", whatsAppConversationSchema);