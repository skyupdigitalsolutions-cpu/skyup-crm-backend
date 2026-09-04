const mongoose = require("mongoose");
const { encryptedFieldsPlugin, hmac } = require("../utils/fieldCrypto");

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

    // Deterministic HMAC of waPhone — used for every equality/$in lookup now
    // that waPhone itself is encrypted at rest with a random IV (the same
    // phone number never produces the same ciphertext twice, so it can no
    // longer be matched by plain equality). Computed automatically from the
    // plaintext value by the hooks below — never set this directly.
    waPhoneHash: {
      type: String,
      default: null,
      index: true,
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

// Index for fast lookups by phone + company. Uniqueness now lives on
// waPhoneHash instead of the plaintext waPhone — see the field comment above.
whatsAppConversationSchema.index({ waPhoneHash: 1, company: 1 }, { unique: true });

// FIX: getConversations (whatsappChatController.js) does
// .find({ company }).sort({ lastMessageAt: -1 }) on every single Inbox
// load — with no index supporting that exact filter+sort shape, MongoDB
// falls back to a full collection scan (across ALL companies, not just
// this one) plus an in-memory sort, on every request. This got slower as
// more conversations accumulated over time — exactly the "why is it
// taking longer and longer to load" symptom. This compound index lets
// Mongo satisfy both the filter and the sort order directly from the
// index itself.
whatsAppConversationSchema.index({ company: 1, lastMessageAt: -1 });

// ── Compute waPhoneHash BEFORE encryption runs ────────────────────────────────
// Registered before encryptedFieldsPlugin below so it always sees the
// PLAINTEXT waPhone — hook order follows registration order in Mongoose.
// NOTE: zero-arity (no `next` param) is deliberate — see models/AccessAuditLog.js
// for why: a callback-style `function (next) { ...; next(); }` pre-save hook can
// silently fail with "next is not a function" on this Mongoose 9 setup, which
// would mean waPhoneHash never gets computed on create() with no visible error.
// Zero-arity hooks are treated as promise-based and don't have that failure mode.
whatsAppConversationSchema.pre("save", function () {
  if (this.isModified("waPhone") && this.waPhone) {
    this.waPhoneHash = hmac(this.waPhone);
  }
});

function computeWaPhoneHashOnUpdate() {
  const update = this.getUpdate();
  if (!update) return;
  const val = (update.$set && update.$set.waPhone !== undefined)
    ? update.$set.waPhone
    : update.waPhone;
  if (val) {
    if (!update.$set) update.$set = {};
    update.$set.waPhoneHash = hmac(val);
  }
}
whatsAppConversationSchema.pre("findOneAndUpdate", computeWaPhoneHashOnUpdate);
whatsAppConversationSchema.pre("updateOne",        computeWaPhoneHashOnUpdate);
whatsAppConversationSchema.pre("updateMany",       computeWaPhoneHashOnUpdate);

// Encrypt waPhone at rest (random IV) — display-only, decrypted automatically
// on read. Registered AFTER the hash-computing hooks above so they see
// plaintext first.
whatsAppConversationSchema.plugin(encryptedFieldsPlugin, { fields: ["waPhone"] });

module.exports = mongoose.model("WhatsAppConversation", whatsAppConversationSchema);
