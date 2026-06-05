// utils/brevoMailer.js
// FIX: sendSuperAdminOtp now accepts EITHER a plain object { toEmail, toName, otp }
// OR the legacy positional signature (toEmail, toName, otp) so both call sites work.
// All email template HTML/text is UNCHANGED.

const axios = require("axios");

const sendEmail = async ({ to, toName, subject, html, text }) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY is not set in environment variables.");

  const fromEmail = process.env.BREVO_FROM_EMAIL || "noreply@skyupcrm.com";
  const fromName  = process.env.BREVO_FROM_NAME  || "SkyUp CRM";

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender:      { email: fromEmail, name: fromName },
      to:          [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
      ...(text ? { textContent: text } : {}),
    },
    {
      headers: {
        "api-key":      apiKey,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
    }
  );
};

// FIX: supports both call styles:
//   sendSuperAdminOtp({ toEmail, toName, otp })   ← new object style (superAdminController)
//   sendSuperAdminOtp(toEmail, toName, otp)        ← legacy positional style
const sendSuperAdminOtp = async (toEmailOrObj, toNameArg, otpArg) => {
  let toEmail, toName, otp;

  if (toEmailOrObj && typeof toEmailOrObj === "object") {
    // Object style: { toEmail, toName, otp }
    ({ toEmail, toName, otp } = toEmailOrObj);
  } else {
    // Positional style
    toEmail = toEmailOrObj;
    toName  = toNameArg;
    otp     = otpArg;
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#0D0F14;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0F14;padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
             style="background:#13161E;border:1px solid #1E2130;border-radius:20px;overflow:hidden;max-width:480px;width:100%;">
        <!-- Header -->
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #1E2130;">
            <span style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#F59E0B;">Super Admin · SkyUp CRM</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 40px;">
            <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#F0F2FA;">Login Verification</p>
            <p style="margin:0 0 24px;font-size:13px;color:#7C8299;">Hi ${toName || "Super Admin"}, use the OTP below to complete your login.</p>
            <!-- OTP Box -->
            <div style="background:#0D0F14;border:1.5px solid #F59E0B44;border-radius:14px;padding:28px;text-align:center;margin-bottom:24px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#7C8299;margin-bottom:14px;">Your One-Time Password</div>
              <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#F59E0B;font-family:monospace;">${otp}</div>
              <div style="margin-top:14px;font-size:12px;color:#565C75;">Expires in <strong style="color:#F0F2FA;">10 minutes</strong></div>
            </div>
            <!-- Warning -->
            <div style="background:#EF444410;border:1px solid #EF444430;border-radius:10px;padding:14px 16px;margin-bottom:24px;">
              <p style="margin:0;font-size:12px;color:#FCA5A5;">
                <strong>Security notice:</strong> Never share this OTP with anyone.
                If you did not attempt to log in, please secure your account immediately.
              </p>
            </div>
            <p style="margin:0;font-size:12px;color:#565C75;">Valid for single use only. After 3 failed attempts your session will be locked.</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #1E2130;">
            <p style="margin:0;font-size:11px;color:#3A3F52;text-align:center;">
              © ${new Date().getFullYear()} SkyUp CRM · Automated security email
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `SkyUp CRM — SuperAdmin OTP\n\nHi ${toName || "Super Admin"},\n\nYour one-time password: ${otp}\n\nExpires in 10 minutes. Single use only.\n\nIf you did not attempt to log in, secure your account immediately.`;

  return sendEmail({
    to:      toEmail,
    toName,
    subject: "Your SuperAdmin Login OTP — SkyUp CRM",
    html,
    text,
  });
};

module.exports = { sendEmail, sendSuperAdminOtp };
