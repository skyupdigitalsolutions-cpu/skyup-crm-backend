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

    // ── DEPRECATED — plaintext password storage (SECURITY FIX) ────────────────
    // This field used to store every admin's actual password in plaintext so
    // super_admin could "view credentials" later. That's a critical security
    // issue (ISO 27001 A.5.17/A.8.24 — authentication information must never
    // be stored in a retrievable form): anyone with DB/backup access got
    // every account's real password with zero cracking required, and since
    // people reuse passwords across services, a leak here could compromise
    // accounts outside this CRM too.
    //
    // No code writes to this field anymore (see controllers/adminController.js,
    // superAdminController.js, forgotPasswordController.js). It's kept here
    // ONLY so scripts/clearPlainPasswords.js can null out existing values in
    // one pass — run that once, then this field can be dropped entirely.
    // The replacement feature is a one-time "Reset Password" action: admins
    // generate a brand-new password on demand (shown once, never stored),
    // instead of ever being able to look up an existing one.
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

// ── Full password policy (A.5.17) ────────────────────────────────────────────
// Enforces utils/passwordPolicy.js centrally at the schema layer so no admin/
// super-admin creation path can bypass it. Runs before the hash hook (sees
// plaintext) and is guarded by isModified so unrelated saves are untouched.
const { validatePassword } = require("../utils/passwordPolicy");
adminSchema.pre("validate", function () {
  // Mongoose 9: pre hooks are called with NO arguments — declaring a `next`
  // parameter and calling it throws "next is not a function". This hook is
  // now promise-style: no `next` param, no `next()` call. Marking the path
  // invalid via this.invalidate() is enough; Mongoose surfaces it as a
  // normal ValidationError once this function returns.
  if (!this.isModified("password")) return;
  const { valid, errors } = validatePassword(this.password, { email: this.email, name: this.name });
  if (!valid) this.invalidate("password", errors[0]);
});

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