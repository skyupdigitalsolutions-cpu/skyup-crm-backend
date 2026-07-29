// models/Admin.js — UPDATED (role enum: "superadmin" → "super_admin", added avatar/department/isActive + unique index)
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
// SECURITY (A.8.24): work factor raised from 10 to 12.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

const adminSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true },
    password: {
      type: String,
      required: true,
      // SECURITY (A.5.17): enforced at the schema layer so no controller can
      // bypass it. Mongoose validates BEFORE the pre('save') hash hook, so this
      // applies to the plaintext.
      // PRODUCTION NOTE: defaults to 8 to avoid rejecting existing flows on
      // deploy. Raise to 12 via PASSWORD_MIN_LENGTH once all user-creation
      // paths issue longer passwords. utils/passwordPolicy.js enforces the
      // full policy (length + complexity + common/reuse checks) at set time.
      minlength: [
        Number(process.env.PASSWORD_MIN_LENGTH) || 8,
        `Password must be at least ${Number(process.env.PASSWORD_MIN_LENGTH) || 8} characters`,
      ],
    },
    company:  {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true, // Every admin belongs to a company
    },

    // ── UPDATED: "superadmin" renamed to "super_admin" ────────────────────────
    role: {
      type: String,
      enum: ["super_admin", "admin", "marketing_user"],
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

    // ── Plain-text password (for super admin credential view) ─────────────────
    // Updated on creation and on password reset via forgot-password flow.
    plainPassword: { type: String, default: null },

    // ── Telegram personal notification ────────────────────────────────────────
    // Admin/SuperAdmin stores their own Telegram chat ID here.
    // When a campaign lead arrives and is assigned under their scope,
    // a notification is sent to this individual chat.
    // Get your chat ID: message @userinfobot on Telegram.
    telegramChatId:             { type: String, default: null, trim: true },
    telegramNotificationsEnabled: { type: Boolean, default: true },

    // ── Marketing Panel access ────────────────────────────────────────────────
    // When true, this admin can log into the standalone Performance Marketing
    // Panel (/marketing/login). Set by super admin in Company Details.
    marketingAccess: { type: Boolean, default: false },

    // ── Forgot-password OTP fields ────────────────────────────────────────────
    resetOtp:         { type: String, default: null },   // bcrypt-hashed OTP
    resetOtpExpiry:   { type: Date,   default: null },
    resetOtpAttempts: { type: Number, default: 0 },

  },
  { timestamps: true }
);

// Hashing the password before saving
adminSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_COST);
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