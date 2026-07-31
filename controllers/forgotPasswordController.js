// controllers/forgotPasswordController.js
// Handles OTP-based password reset for Admin, super_admin, and Employee (User) roles.
// Flow: requestOtp → verifyOtpAndReset
// On success the new plainPassword is also saved so the super_admin credential view stays current.

const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");
const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const { sendPasswordResetOtp } = require("../utils/brevoMailer");
const { validatePassword } = require("../utils/passwordPolicy");

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
    try {
      await sendPasswordResetOtp({
        toEmail: doc.email,
        toName:  doc.name,
        otp,
        role: doc.role || "user",
      });
    } catch (mailErr) {
      console.error("[ForgotPassword] Email delivery failed:", mailErr.message);
    }

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
// Also updates plainPassword so super_admin credential view stays accurate.
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
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    // Check for missing/expired OTP
    if (!doc.resetOtp || !doc.resetOtpExpiry) {
      return res.status(400).json({ message: "No OTP request found. Please request a new OTP." });
    }

    if (new Date() > doc.resetOtpExpiry) {
      // Clear stale OTP
      doc.resetOtp         = null;
      doc.resetOtpExpiry   = null;
      doc.resetOtpAttempts = 0;
      await doc.save();
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    // Throttle brute-force attempts
    if (doc.resetOtpAttempts >= MAX_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new OTP.",
      });
    }

    const isMatch = await bcrypt.compare(otp, doc.resetOtp);
    if (!isMatch) {
      doc.resetOtpAttempts = (doc.resetOtpAttempts || 0) + 1;
      await doc.save();
      const remaining = MAX_ATTEMPTS - doc.resetOtpAttempts;
      return res.status(400).json({
        message: `Incorrect OTP. ${remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` : "No attempts remaining. Please request a new OTP."}`,
      });
    }

    // OTP is valid — update password and clear OTP fields
    // Set password (the pre-save hook will hash it)
    doc.password      = newPassword;
    // Store plain-text for super_admin credential view
    doc.plainPassword = newPassword;
    // Clear OTP state
    doc.resetOtp         = null;
    doc.resetOtpExpiry   = null;
    doc.resetOtpAttempts = 0;
    await doc.save();

    return res.status(200).json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("[ForgotPassword] verifyOtpAndReset error:", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

module.exports = { requestOtp, verifyOtpAndReset };