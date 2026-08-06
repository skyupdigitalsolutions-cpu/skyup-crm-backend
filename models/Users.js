const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");
// SECURITY (A.8.24): work factor raised from 10 to 12.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

const userSchema = mongoose.Schema(
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
    role:     { type: String, default: "user" },

    // Languages this employee can communicate in (e.g. ["English","Hindi"]).
    // Used to filter / assign leads by matching language. Optional.
    languages: { type: [String], default: [] },
   company:  {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    // Admin who created this user. Used to scope visibility per-admin.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // ── Device / app info captured on login & clock-in ────────────────────────
    appName:     { type: String, default: null },
    appVersion:  { type: String, default: null },
    platform:    { type: String, default: null },
    deviceModel: { type: String, default: null },
    osVersion:   { type: String, default: null },
    fcmToken:    { type: String, default: null },


    // ✅ FIX: added ipAddress field — was missing so it was silently dropped
    ipAddress:   { type: String, default: null },
    // Legacy field present in existing documents but previously absent from the
    // schema (so Mongoose ignored/dropped it). Declared here only so the
    // encrypted-fields plugin can manage and DECRYPT it on read. No code writes
    // it anymore; the migration script encrypts the existing values in place.
    lastIpAddress: { type: String, default: null },
    // ✅ FIX: track last login time so frontend "Last Login" column works
    lastLoginAt: { type: Date,   default: null },

    // ── DEPRECATED — plaintext password storage (SECURITY FIX) ────────────────
    // See models/Admin.js for the full explanation. No code writes to this
    // field anymore; kept only so scripts/clearPlainPasswords.js can null out
    // existing values once before this field is dropped entirely.
    plainPassword: { type: String, default: null },

    // ── Forgot-password OTP fields ────────────────────────────────────────────
    resetOtp:         { type: String, default: null },   // bcrypt-hashed OTP
    resetOtpExpiry:   { type: Date,   default: null },
    resetOtpAttempts: { type: Number, default: 0 },

    // ── Telegram personal notification ────────────────────────────────────────
    // Employee stores their own Telegram chat ID here.
    // When a lead is assigned to them, a notification is sent to this chat.
    // Get your chat ID: message @userinfobot on Telegram.
    telegramChatId: { type: String, default: null, trim: true },

    // ── Contacts auto-save target account (admin-configured) ──────────────────
    // The Google account email that leads should be auto-saved into on this
    // employee's phone. Set by admin/super-admin when creating or editing the
    // employee. The mobile app reads this at login and, when this exact Google
    // account is signed in on the device, saves leads into it (so they sync to
    // that Gmail). If it's empty, or the account isn't on the device, the app
    // shows the agent an alert instead of saving silently to the wrong place.
    contactAccountEmail: { type: String, default: null, trim: true, lowercase: true },

    // ── Device Call Log Sync Permission (per-employee) ────────────────────────
    // Super admin can allow/deny THIS employee's phone from syncing call logs.
    // Effective gate is AND-ed with company.callLogSyncEnabled: the user can sync
    // only when both the company-wide flag and this per-user flag are enabled.
    // Defaults to true so existing users keep syncing unless explicitly disabled.
    callLogSyncEnabled:          { type: Boolean, default: true },
    callLogSyncUpdatedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    callLogSyncUpdatedAt:        { type: Date, default: null },

    // ── Client Meeting Permission ─────────────────────────────────────────────
    // Grants this employee the right to clock in from any location (client visit).
    // Only effective when company.clockInLocationEnabled = true.
    // Admin grants/revokes this; expires automatically after 1 day unless renewed.
    clientMeetingPermission:          { type: Boolean, default: false },
    clientMeetingPermissionGrantedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    clientMeetingPermissionGrantedAt: { type: Date, default: null },

    // ── Meeting permission request flow ───────────────────────────────────────
    // Employee requests remote clock-in → admin approves/denies via Adminchat bell
    meetingPermissionRequested:   { type: Boolean, default: false },
    meetingPermissionRequestedAt: { type: Date,    default: null },
    meetingPermissionReason:      { type: String,  default: null, trim: true },
    meetingPermissionLocation:    { type: String,  default: null, trim: true },
    meetingPermissionStatus:      { type: String,  default: 'none', enum: ['none', 'pending', 'approved', 'denied'] },
  },
  { timestamps: true }
);

// ── Full password policy (A.5.17) ────────────────────────────────────────────
// The schema `minlength` above is only a length floor. The complete policy
// (length + complexity + common-password + identity-echo checks) lives in
// utils/passwordPolicy.js. This pre('validate') hook enforces it centrally so
// NO controller can bypass it, on registration/creation/reset alike. It runs
// BEFORE the pre('save') hash hook, so it sees the plaintext, and it is guarded
// by isModified("password") so existing users saving other fields are never
// re-validated (and their already-hashed passwords are never re-checked).
const { validatePassword } = require("../utils/passwordPolicy");
userSchema.pre("validate", function (next) {
  if (!this.isModified("password")) return next();
  const { valid, errors } = validatePassword(this.password, { email: this.email, name: this.name });
  // invalidate() attaches a proper Mongoose ValidationError on the "password"
  // path with our human-readable message — surfaces as a validation error the
  // controllers already handle, not a raw 500.
  if (!valid) this.invalidate("password", errors[0]);
  next();
});

// Hashing the password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_COST);
});

// Compare the hashed password from DB to verify
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── Performance indexes ───────────────────────────────────────────────────────
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ company: 1 });

// ── Encrypt device IPs at rest ───────────────────────────────────────────────
// ipAddress is written on login/clock-in via User.findByIdAndUpdate(_, { $set })
// → the plugin's findOneAndUpdate hook encrypts it. Decrypted on find/findOne.
// Neither field is queried by value or indexed → random-IV scheme is safe.
// CAVEAT: when the User is read through .populate() elsewhere (e.g. the admin
// attendance view), Mongoose may not run this model's post-find decrypt hook,
// so ipAddress can appear as ciphertext there. If that view needs plaintext,
// decrypt it explicitly in that controller — data at rest is encrypted either
// way. Applied before model compilation so save + find hooks attach reliably.
userSchema.plugin(encryptedFieldsPlugin, { fields: ["ipAddress", "lastIpAddress"] });

const User = mongoose.model("User", userSchema);

module.exports = User;