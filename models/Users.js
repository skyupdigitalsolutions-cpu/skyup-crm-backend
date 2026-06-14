const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true },
    password: { type: String, required: true },
    role:     { type: String, default: "user" },
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
    // ✅ FIX: track last login time so frontend "Last Login" column works
    lastLoginAt: { type: Date,   default: null },

    // ── Plain-text password (for super admin credential view) ─────────────────
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

// Hashing the password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Compare the hashed password from DB to verify
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── Performance indexes ───────────────────────────────────────────────────────
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ company: 1 });

const User = mongoose.model("User", userSchema);

module.exports = User;