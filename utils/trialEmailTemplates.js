// utils/trialEmailTemplates.js
// Email templates for the 7-day Pro free-trial + auto-billing flow.
// Kept in a separate module so the large utils/emailTemplates.js is untouched.

const APP_URL = process.env.FRONTEND_URL || "https://app.skyupcrm.com";
const SUPPORT = process.env.SUPPORT_EMAIL || "support@skyupcrm.com";
const BRAND   = "SkyUp CRM";

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

const _wrap = (innerHtml) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E4E7EF;border-radius:16px;overflow:hidden">
    <div style="background:#2563EB;padding:20px 24px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800">${BRAND}</h1>
    </div>
    <div style="padding:24px">${innerHtml}</div>
    <div style="padding:16px 24px;border-top:1px solid #F0F2FA;color:#8B92A9;font-size:12px">
      Need help? Reach us at <a href="mailto:${SUPPORT}" style="color:#2563EB">${SUPPORT}</a>.
    </div>
  </div>`;

// ── Sent when the customer adds a payment method and the 7-day trial begins ────
const trialStartedEmail = ({ companyName, planName = "Pro", trialEndsAt }) => {
  const subject = `Your 7-day ${planName} trial has started 🎉`;
  const html = _wrap(`
    <p style="font-size:15px;color:#0F1117">Hi ${companyName},</p>
    <p style="font-size:14px;color:#4B5168;line-height:1.6">
      Your <strong>7-day free trial</strong> of the <strong>${planName}</strong> plan is now active.
      You have full access to every ${planName} feature until <strong>${fmtDate(trialEndsAt)}</strong>.
    </p>
    <p style="font-size:14px;color:#4B5168;line-height:1.6">
      We've securely saved your payment method. When the trial ends you can pick a plan and
      keep working without re-entering any card details — the first payment is triggered automatically
      against your saved method only after you choose to continue.
    </p>
    <p style="margin-top:20px">
      <a href="${APP_URL}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px">Open ${BRAND}</a>
    </p>`);
  const text =
    `Hi ${companyName},\n\nYour 7-day free trial of the ${planName} plan is active until ${fmtDate(trialEndsAt)}. ` +
    `Your payment method is saved securely — when the trial ends you can pick a plan and continue without re-entering card details.\n\n${APP_URL}`;
  return { subject, html, text };
};

// ── Sent when the 7-day trial expires ─────────────────────────────────────────
const trialExpiredEmail = ({ companyName, planName = "Pro" }) => {
  const subject = `Your free ${planName} trial has expired — pick a plan to continue`;
  const html = _wrap(`
    <p style="font-size:15px;color:#0F1117">Hi ${companyName},</p>
    <p style="font-size:14px;color:#4B5168;line-height:1.6">
      Your <strong>7-day free trial</strong> of the <strong>${planName}</strong> plan has ended, and your
      workspace is now in read-only mode.
    </p>
    <p style="font-size:14px;color:#4B5168;line-height:1.6">
      Good news — your payment method is already on file. Just choose a plan and we'll resume your
      subscription instantly. <strong>No need to re-enter card details</strong>; the payment is charged
      automatically to your saved method the moment you select a plan.
    </p>
    <p style="margin-top:20px">
      <a href="${APP_URL}/billing" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px">Choose a plan &amp; continue</a>
    </p>`);
  const text =
    `Hi ${companyName},\n\nYour 7-day free ${planName} trial has ended and your workspace is read-only. ` +
    `Your payment method is already saved — choose a plan at ${APP_URL}/billing and your subscription resumes ` +
    `instantly, charged automatically to your saved method. No need to re-enter card details.`;
  return { subject, html, text };
};

module.exports = { trialStartedEmail, trialExpiredEmail };