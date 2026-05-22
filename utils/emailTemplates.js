// utils/emailTemplates.js
// ─────────────────────────────────────────────────────────────────────────────
// HTML email templates used by:
//   • developerController.js  → companyWelcomeEmail()  (on company creation)
//   • jobs/subscriptionExpiryJob.js → subscriptionExpiryEmail() (cron warnings)
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared design tokens ──────────────────────────────────────────────────────
const BG       = "#0D0F14";
const CARD     = "#13161E";
const BORDER   = "#1E2130";
const TEXT     = "#F0F2FA";
const MUTED    = "#7C8299";
const DIM      = "#565C75";
const ACCENT   = "#6366F1"; // indigo — platform brand
const ORANGE   = "#F59E0B"; // warning amber
const GREEN    = "#22C55E";
const RED      = "#EF4444";
const YEAR     = new Date().getFullYear();

// ── Helper: wrapper shell ─────────────────────────────────────────────────────
const shell = (innerRows) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>SkyUp CRM</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0"
             style="background:${CARD};border:1px solid ${BORDER};border-radius:20px;
                    overflow:hidden;max-width:520px;width:100%;">

        <!-- ── Logo strip ── -->
        <tr>
          <td style="padding:28px 40px 22px;border-bottom:1px solid ${BORDER};
                     background:linear-gradient(135deg,#13161E 0%,#1A1D28 100%);">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:12px;">
                  <div style="width:36px;height:36px;background:${ACCENT};border-radius:10px;
                              display:flex;align-items:center;justify-content:center;
                              font-size:18px;font-weight:900;color:#fff;text-align:center;
                              line-height:36px;">S</div>
                </td>
                <td>
                  <span style="font-size:20px;font-weight:800;color:${TEXT};letter-spacing:-0.5px;">
                    SkyUp <span style="color:${ACCENT};">CRM</span>
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${innerRows}

        <!-- ── Footer ── -->
        <tr>
          <td style="padding:18px 40px;border-top:1px solid ${BORDER};">
            <p style="margin:0;font-size:11px;color:${DIM};text-align:center;">
              © ${YEAR} SkyUp CRM &nbsp;·&nbsp; Automated system email — please do not reply
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ── 1. Company Welcome Email ──────────────────────────────────────────────────
// Sent to the company's registered email address right after account creation.
//
// @param {object} opts
//   companyName  {string}  — "Acme Pvt Ltd"
//   plan         {string}  — "Pro"
//   loginUrl     {string}  — front-end login URL (from env or default)
//   supportEmail {string}  — support address shown in email
const companyWelcomeEmail = ({
  companyName,
  plan = "Basic",
  loginUrl     = process.env.FRONTEND_URL   || "https://app.skyupcrm.com",
  supportEmail = process.env.SUPPORT_EMAIL  || "support@skyupcrm.com",
}) => {
  const planLabel  = plan.charAt(0).toUpperCase() + plan.slice(1);
  const planColor  = plan.toLowerCase() === "enterprise" ? ORANGE
                   : plan.toLowerCase() === "pro"        ? ACCENT
                   :                                       GREEN;

  const body = `
  <!-- ── Hero ── -->
  <tr>
    <td style="padding:36px 40px 0;">
      <p style="margin:0 0 6px;font-size:26px;font-weight:800;color:${TEXT};line-height:1.25;">
        Welcome to SkyUp CRM! 🎉
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:${MUTED};line-height:1.6;">
        Your company account has been successfully created and is ready to use.
      </p>
    </td>
  </tr>

  <!-- ── Account details card ── -->
  <tr>
    <td style="padding:0 40px;">
      <div style="background:${BG};border:1px solid ${BORDER};border-radius:14px;
                  padding:24px 28px;margin-bottom:24px;">
        <p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:${DIM};">Account Details</p>
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid ${BORDER};width:40%;">
              <span style="font-size:12px;color:${MUTED};">Company Name</span>
            </td>
            <td style="padding:8px 0;border-bottom:1px solid ${BORDER};">
              <span style="font-size:13px;font-weight:600;color:${TEXT};">${companyName}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;">
              <span style="font-size:12px;color:${MUTED};">Active Plan</span>
            </td>
            <td style="padding:8px 0;">
              <span style="display:inline-block;background:${planColor}20;color:${planColor};
                           font-size:11px;font-weight:700;letter-spacing:1px;
                           text-transform:uppercase;padding:4px 10px;border-radius:6px;">
                ${planLabel}
              </span>
            </td>
          </tr>
        </table>
      </div>
    </td>
  </tr>

  <!-- ── Steps ── -->
  <tr>
    <td style="padding:0 40px 28px;">
      <p style="margin:0 0 14px;font-size:13px;font-weight:700;color:${TEXT};">
        Get started in 3 steps
      </p>
      ${["Set your password via the login page", "Invite your team members", "Import or add your first leads"].map((step, i) => `
      <table cellpadding="0" cellspacing="0" style="margin-bottom:10px;width:100%;">
        <tr>
          <td style="width:28px;vertical-align:top;padding-top:1px;">
            <div style="width:22px;height:22px;background:${ACCENT}22;border:1px solid ${ACCENT}55;
                        border-radius:50%;text-align:center;line-height:22px;
                        font-size:11px;font-weight:700;color:${ACCENT};">${i + 1}</div>
          </td>
          <td style="padding-left:10px;">
            <span style="font-size:13px;color:${MUTED};">${step}</span>
          </td>
        </tr>
      </table>`).join("")}
    </td>
  </tr>

  <!-- ── CTA ── -->
  <tr>
    <td style="padding:0 40px 32px;text-align:center;">
      <a href="${loginUrl}"
         style="display:inline-block;background:${ACCENT};color:#fff;font-size:14px;
                font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;
                letter-spacing:0.3px;">
        Go to Dashboard →
      </a>
    </td>
  </tr>

  <!-- ── Support note ── -->
  <tr>
    <td style="padding:0 40px 28px;">
      <div style="background:${ACCENT}0D;border:1px solid ${ACCENT}30;border-radius:10px;
                  padding:14px 16px;">
        <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">
          Need help? Reply to this email or reach us at
          <a href="mailto:${supportEmail}" style="color:${ACCENT};text-decoration:none;">${supportEmail}</a>.
          We typically respond within a few hours.
        </p>
      </div>
    </td>
  </tr>`;

  return {
    subject: `Your SkyUp CRM Account is Ready — ${companyName}`,
    html:    shell(body),
    text:    `Welcome to SkyUp CRM!\n\nYour company account "${companyName}" has been created with the ${planLabel} plan.\n\nLog in at: ${loginUrl}\n\nNeed help? Email us at ${supportEmail}.`,
  };
};

// ── 2. Subscription Expiry Warning Email ──────────────────────────────────────
// Sent N days before the subscription expires (7, 3, 1).
//
// @param {object} opts
//   companyName  {string}
//   plan         {string}
//   daysLeft     {number}  — 7 | 3 | 1
//   expiryDate   {Date|string}
//   renewUrl     {string}  — deep-link to billing / upgrade page
//   supportEmail {string}
const subscriptionExpiryEmail = ({
  companyName,
  plan = "Pro",
  daysLeft,
  expiryDate,
  renewUrl     = process.env.FRONTEND_URL   ? `${process.env.FRONTEND_URL}/billing` : "https://app.skyupcrm.com/billing",
  supportEmail = process.env.SUPPORT_EMAIL  || "support@skyupcrm.com",
}) => {
  const planLabel   = plan.charAt(0).toUpperCase() + plan.slice(1);
  const urgency     = daysLeft === 1 ? RED : daysLeft <= 3 ? ORANGE : ACCENT;
  const urgencyWord = daysLeft === 1 ? "Last chance!" : daysLeft <= 3 ? "Expiring soon" : "Heads up";
  const expiryStr   = new Date(expiryDate).toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });
  const dayLabel = daysLeft === 1 ? "1 day" : `${daysLeft} days`;

  const body = `
  <!-- ── Urgency banner ── -->
  <tr>
    <td style="padding:0;">
      <div style="background:${urgency}18;border-bottom:2px solid ${urgency}44;
                  padding:14px 40px;">
        <p style="margin:0;font-size:12px;font-weight:700;color:${urgency};
                  letter-spacing:1.5px;text-transform:uppercase;">
          ⚠&nbsp; ${urgencyWord} — ${dayLabel} remaining
        </p>
      </div>
    </td>
  </tr>

  <!-- ── Hero ── -->
  <tr>
    <td style="padding:32px 40px 0;">
      <p style="margin:0 0 6px;font-size:24px;font-weight:800;color:${TEXT};line-height:1.25;">
        Your subscription is expiring
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:${MUTED};line-height:1.6;">
        Hi <strong style="color:${TEXT};">${companyName}</strong>, your
        <strong style="color:${TEXT};">${planLabel}</strong> plan expires on
        <strong style="color:${urgency};">${expiryStr}</strong> — that's in
        <strong style="color:${urgency};">${dayLabel}</strong>.
        Renew now to avoid any service interruption.
      </p>
    </td>
  </tr>

  <!-- ── What happens if expired ── -->
  <tr>
    <td style="padding:0 40px 24px;">
      <div style="background:${RED}0C;border:1px solid ${RED}25;border-radius:14px;padding:20px 24px;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:1.5px;
                  text-transform:uppercase;color:${RED}80;">After Expiry</p>
        ${[
          "Access to your leads and contacts will be read-only",
          "New lead imports and campaigns will be paused",
          "Your data is safely retained for 30 days",
        ].map(item => `
        <table cellpadding="0" cellspacing="0" style="margin-bottom:8px;width:100%;">
          <tr>
            <td style="width:16px;vertical-align:top;">
              <span style="color:${RED};font-size:13px;">•</span>
            </td>
            <td style="padding-left:8px;">
              <span style="font-size:13px;color:${MUTED};">${item}</span>
            </td>
          </tr>
        </table>`).join("")}
      </div>
    </td>
  </tr>

  <!-- ── CTA ── -->
  <tr>
    <td style="padding:0 40px 28px;text-align:center;">
      <a href="${renewUrl}"
         style="display:inline-block;background:${urgency};color:#fff;font-size:15px;
                font-weight:700;text-decoration:none;padding:15px 40px;border-radius:10px;
                letter-spacing:0.3px;">
        Renew Subscription Now →
      </a>
      <p style="margin:14px 0 0;font-size:12px;color:${DIM};">
        Or contact us at
        <a href="mailto:${supportEmail}" style="color:${ACCENT};text-decoration:none;">${supportEmail}</a>
        if you need assistance.
      </p>
    </td>
  </tr>`;

  const subject = daysLeft === 1
    ? `URGENT: Your SkyUp CRM plan expires TODAY — ${companyName}`
    : `Your SkyUp CRM subscription expires in ${dayLabel} — ${companyName}`;

  return {
    subject,
    html: shell(body),
    text: `SkyUp CRM Subscription Expiry Notice\n\nHi ${companyName},\n\nYour ${planLabel} plan expires on ${expiryStr} (${dayLabel} left).\n\nRenew at: ${renewUrl}\n\nAfter expiry your account will switch to read-only mode.\n\nNeed help? Email ${supportEmail}.`,
  };
};

module.exports = { companyWelcomeEmail, subscriptionExpiryEmail };