// controllers/forgotPasswordController.js
// Handles OTP-based password reset for Admin, super_admin, and Employee (User) roles.
// Flow: requestOtp → verifyOtpAndReset
// (No longer stores a plaintext password copy — see models/Admin.js / models/Users.js
// for why that field was removed.)

const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");
const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const { sendPasswordResetOtp } = require("../utils/brevoMailer");
const { validatePassword } = require("../utils/passwordPolicy");
const { logAuditEvent } = require("../utils/auditLogger");

const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS       = 5;

// ── Helper: generate a 6-digit OTP string ─────────────────────────────────────
function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

// ── POST /api/auth/forgot-password/request ─────────────────────────────────────
// Body: { email }
// Looks up the email across Admin (covers super_admin + admin) and User (employee).
// Generates OTP, bcrypt-hashes it into the DB, sends plain OTP via Brevo.
const requestOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required." });

    // Find the account — Admin model covers both admin and super_admin roles
    let doc  = await Admin.findOne({ email });
    let kind = doc ? "admin" : null;

    if (!doc) {
      doc  = await User.findOne({ email });
      kind = doc ? "user" : null;
    }

    // Always respond with the same success message to prevent email enumeration
    if (!doc) {
      logAuditEvent({
        action: "password_reset_requested", resourceType: "Auth", req,
        actorEmail: email, statusCode: 200,
        metadata: { reason: "email_not_found" },
      });
      return res.status(200).json({
        message: "If an account with that email exists, an OTP has been sent.",
      });
    }

    const otp       = generateOtp();
    const otpHash   = await bcrypt.hash(otp, 10);
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    doc.resetOtp         = otpHash;
    doc.resetOtpExpiry   = otpExpiry;
    doc.resetOtpAttempts = 0;
    await doc.save();

    // Send email — fire and forget; don't reveal delivery failures to caller
    let emailDelivered = true;
    try {
      await sendPasswordResetOtp({
        toEmail: doc.email,
        toName:  doc.name,
        otp,
        role: doc.role || "user",
      });
    } catch (mailErr) {
      emailDelivered = false;
      console.error("[ForgotPassword] Email delivery failed:", mailErr.message);
    }

    // The OTP value itself is NEVER included here — only whether delivery
    // succeeded, which is operationally relevant without being a secret.
    logAuditEvent({
      action: "password_reset_requested", resourceType: "Auth", req,
      actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
      actorEmail: doc.email, actorRole: doc.role || kind,
      company: doc.company || null, resourceId: doc._id, statusCode: 200,
      metadata: { reason: "otp_sent", emailDelivered },
    });

    return res.status(200).json({
      message: "If an account with that email exists, an OTP has been sent.",
    });
  } catch (err) {
    console.error("[ForgotPassword] requestOtp error:", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

// ── POST /api/auth/forgot-password/reset ──────────────────────────────────────
// Body: { email, otp, newPassword }
// Verifies OTP (not expired, not too many attempts), then updates the password.
const verifyOtpAndReset = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: "Email, OTP, and new password are required." });
    }
    // A.5.17 — enforce the full password policy on reset (length + complexity +
    // common-password + identity-echo checks), not just a bare length floor.
    // The model's pre('validate') hook enforces this too; validating here first
    // returns a clean, specific 400 before the OTP/DB work runs.
    {
      const { valid, errors } = validatePassword(newPassword, { email });
      if (!valid) return res.status(400).json({ message: errors[0], errors });
    }

    // Find across both models
    let doc  = await Admin.findOne({ email });
    let kind = doc ? "admin" : null;

    if (!doc) {
      doc  = await User.findOne({ email });
      kind = doc ? "user" : null;
    }

    if (!doc) {
      logAuditEvent({
        action: "password_reset_failed", resourceType: "Auth", req,
        actorEmail: email, statusCode: 400,
        metadata: { reason: "account_not_found" },
      });
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    // Check for missing/expired OTP
    if (!doc.resetOtp || !doc.resetOtpExpiry) {
      logAuditEvent({
        action: "password_reset_failed", resourceType: "Auth", req,
        actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
        actorEmail: doc.email, actorRole: doc.role || kind,
        company: doc.company || null, resourceId: doc._id, statusCode: 400,
        metadata: { reason: "no_otp_requested" },
      });
      return res.status(400).json({ message: "No OTP request found. Please request a new OTP." });
    }

    if (new Date() > doc.resetOtpExpiry) {
      // Clear stale OTP
      doc.resetOtp         = null;
      doc.resetOtpExpiry   = null;
      doc.resetOtpAttempts = 0;
      await doc.save();
      logAuditEvent({
        action: "password_reset_failed", resourceType: "Auth", req,
        actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
        actorEmail: doc.email, actorRole: doc.role || kind,
        company: doc.company || null, resourceId: doc._id, statusCode: 400,
        metadata: { reason: "otp_expired" },
      });
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    // Throttle brute-force attempts
    if (doc.resetOtpAttempts >= MAX_ATTEMPTS) {
      logAuditEvent({
        action: "password_reset_failed", resourceType: "Auth", req,
        actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
        actorEmail: doc.email, actorRole: doc.role || kind,
        company: doc.company || null, resourceId: doc._id, statusCode: 429,
        metadata: { reason: "too_many_attempts" },
      });
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new OTP.",
      });
    }

    const isMatch = await bcrypt.compare(otp, doc.resetOtp);
    if (!isMatch) {
      doc.resetOtpAttempts = (doc.resetOtpAttempts || 0) + 1;
      await doc.save();
      const remaining = MAX_ATTEMPTS - doc.resetOtpAttempts;
      // The OTP VALUE is never included — only that an attempt was wrong and
      // how many attempts remain. Never log secrets, even in metadata.
      logAuditEvent({
        action: "password_reset_failed", resourceType: "Auth", req,
        actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
        actorEmail: doc.email, actorRole: doc.role || kind,
        company: doc.company || null, resourceId: doc._id, statusCode: 400,
        metadata: { reason: "wrong_otp", attemptsRemaining: Math.max(0, remaining) },
      });
      return res.status(400).json({
        message: `Incorrect OTP. ${remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` : "No attempts remaining. Please request a new OTP."}`,
      });
    }

    // OTP is valid — update password and clear OTP fields
    // Set password (the pre-save hook will hash it)
    doc.password      = newPassword;
    // SECURITY FIX: no longer storing a plaintext copy (see models/Admin.js /
    // models/Users.js) — the person resetting their own password already has
    // it, so there's nothing to "view" here anyway.
    // Clear OTP state
    doc.resetOtp         = null;
    doc.resetOtpExpiry   = null;
    doc.resetOtpAttempts = 0;
    await doc.save();

    // Success event — the new password itself is NEVER included here.
    logAuditEvent({
      action: "password_reset", resourceType: "Auth", req,
      actorId: doc._id, actorModel: kind === "admin" ? "Admin" : "User",
      actorEmail: doc.email, actorRole: doc.role || kind,
      company: doc.company || null, resourceId: doc._id, statusCode: 200,
    });

    return res.status(200).json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("[ForgotPassword] verifyOtpAndReset error:", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = { requestOtp, verifyOtpAndReset };