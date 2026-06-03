// models/Admin.js — UPDATED (role enum: "superadmin" → "super_admin", added avatar/department/isActive + unique index)
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const adminSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true },
    password: { type: String, required: true },
    company:  {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true, // Every admin belongs to a company
    },

    // ── UPDATED: "superadmin" renamed to "super_admin" ────────────────────────
    role: {
      type: String,
      enum: ["super_admin", "admin"],
      default: "admin",
    },

    // ── NEW: Profile fields ───────────────────────────────────────────────────
    avatar:     { type: String, default: "" },
    department: { type: String, default: "" },
    isActive:   { type: Boolean, default: true },

    // ── FCM push token — set by mobile/web app on login ──────────────────────
    // Used by notifySuperAdminReassignment and sendNoActionAlert to send FCM
    // push notifications to admin and super_admin devices.
    fcmToken:   { type: String, default: null },

    // ── Telegram personal chat ID ─────────────────────────────────────────────
    // Admin's personal Telegram chat ID for direct lead notifications.
    // How to get it: message @userinfobot on Telegram — it replies with your chat ID.
    telegramChatId: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

// Hashing the password before saving
adminSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Compare the hashed password from DB to verify
adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── Performance indexes ───────────────────────────────────────────────────────
adminSchema.index({ email: 1 }, { unique: true });
adminSchema.index({ company: 1 });

// ── NEW: Enforce ONE super_admin per company ──────────────────────────────────
adminSchema.index(
  { company: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: { role: "super_admin" },
    name: "one_super_admin_per_company",
  }
);

const Admin = mongoose.model("Admin", adminSchema);
module.exports = Admin;
