// utils/emailTemplates.js
// ─────────────────────────────────────────────────────────────────────────────
// HTML email templates used by:
//   • developerController.js  → companyWelcomeEmail()  (on company creation)
//   • jobs/subscriptionExpiryJob.js → subscriptionExpiryEmail() (cron warnings to company)
//   • jobs/subscriptionExpiryJob.js → superAdminExpiryDigestEmail() (digest to SuperAdmin)
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

// ── 3. SuperAdmin Expiry Digest Email ─────────────────────────────────────────
// Sent to the SuperAdmin once daily listing ALL companies whose subscriptions
// are expiring soon (1, 3, or 7 days) or have just expired.
//
// @param {object} opts
//   superAdminName  {string}         — e.g. "Platform Admin"
//   expiringGroups  {object}         — { critical: [], warning: [], notice: [] }
//     Each entry: { name, plan, email, daysLeft, expiryDate }
//   totalExpiring   {number}         — total count across all groups
//   dashboardUrl    {string}         — link to superadmin subscription dashboard
const superAdminExpiryDigestEmail = ({
  superAdminName = "Super Admin",
  expiringGroups = { critical: [], warning: [], notice: [] },
  totalExpiring  = 0,
  dashboardUrl   = process.env.FRONTEND_URL
    ? `${process.env.FRONTEND_URL}/developer/subscriptions`
    : "https://app.skyupcrm.com/developer/subscriptions",
}) => {
  const runDate = new Date().toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  // ── Helper: render a single company row ──────────────────────────────────
  const companyRow = ({ name, plan, email, daysLeft, expiryDate }) => {
    const urgencyColor = daysLeft <= 1 ? RED : daysLeft <= 3 ? ORANGE : ACCENT;
    const planLabel    = (plan || "basic").charAt(0).toUpperCase() + (plan || "basic").slice(1);
    const expiryStr    = new Date(expiryDate).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    });
    const dayLabel = daysLeft <= 0
      ? "Expired"
      : daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;

    return `
    <table cellpadding="0" cellspacing="0" width="100%"
           style="margin-bottom:8px;background:${BG};border:1px solid ${BORDER};
                  border-radius:10px;overflow:hidden;">
      <tr>
        <td style="padding:12px 16px;">
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td>
                <p style="margin:0;font-size:13px;font-weight:700;color:${TEXT};">${name}</p>
                <p style="margin:2px 0 0;font-size:11px;color:${MUTED};">${email}</p>
              </td>
              <td style="text-align:right;white-space:nowrap;padding-left:12px;">
                <span style="display:inline-block;background:${urgencyColor}20;color:${urgencyColor};
                             font-size:10px;font-weight:700;letter-spacing:0.8px;
                             text-transform:uppercase;padding:3px 8px;border-radius:5px;">
                  ${dayLabel}
                </span>
                <br/>
                <span style="font-size:10px;color:${DIM};margin-top:2px;display:inline-block;">
                  ${planLabel} · ${expiryStr}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
  };

  // ── Helper: render a section (Critical / Warning / Notice) ───────────────
  const section = (label, color, emoji, companies) => {
    if (!companies || companies.length === 0) return "";
    return `
    <tr>
      <td style="padding:0 40px 20px;">
        <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;
                  text-transform:uppercase;color:${color};">
          ${emoji} ${label} (${companies.length})
        </p>
        ${companies.map(companyRow).join("")}
      </td>
    </tr>`;
  };

  const hasCritical = expiringGroups.critical?.length > 0;
  const hasWarning  = expiringGroups.warning?.length  > 0;
  const hasNotice   = expiringGroups.notice?.length   > 0;

  const summaryBg    = hasCritical ? `${RED}10`    : hasWarning ? `${ORANGE}10` : `${ACCENT}10`;
  const summaryBorder= hasCritical ? `${RED}30`    : hasWarning ? `${ORANGE}30` : `${ACCENT}30`;
  const summaryColor = hasCritical ? RED            : hasWarning ? ORANGE        : ACCENT;
  const summaryIcon  = hasCritical ? "🚨"           : hasWarning ? "⚠️"           : "📋";

  const body = `
  <!-- ── Admin banner ── -->
  <tr>
    <td style="padding:0;">
      <div style="background:${ORANGE}15;border-bottom:2px solid ${ORANGE}40;padding:14px 40px;">
        <p style="margin:0;font-size:11px;font-weight:700;color:${ORANGE};
                  letter-spacing:1.5px;text-transform:uppercase;">
          🛡️ Super Admin · Daily Subscription Report
        </p>
      </div>
    </td>
  </tr>

  <!-- ── Hero ── -->
  <tr>
    <td style="padding:28px 40px 0;">
      <p style="margin:0 0 6px;font-size:24px;font-weight:800;color:${TEXT};line-height:1.25;">
        Subscription Expiry Digest
      </p>
      <p style="margin:0 0 20px;font-size:13px;color:${MUTED};line-height:1.6;">
        Hi <strong style="color:${TEXT};">${superAdminName}</strong>,
        here's your daily summary of companies with subscriptions expiring soon.
        Run at <strong style="color:${TEXT};">${runDate}</strong>.
      </p>
    </td>
  </tr>

  <!-- ── Summary card ── -->
  <tr>
    <td style="padding:0 40px 24px;">
      <div style="background:${summaryBg};border:1px solid ${summaryBorder};
                  border-radius:14px;padding:20px 24px;">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td>
              <p style="margin:0;font-size:28px;font-weight:800;color:${summaryColor};
                        line-height:1;">${summaryIcon} ${totalExpiring}</p>
              <p style="margin:4px 0 0;font-size:12px;color:${MUTED};">
                compan${totalExpiring === 1 ? "y" : "ies"} require${totalExpiring === 1 ? "s" : ""} attention
              </p>
            </td>
            <td style="text-align:right;vertical-align:top;">
              <table cellpadding="0" cellspacing="0">
                ${hasCritical ? `<tr><td style="padding:2px 0;"><span style="font-size:11px;color:${RED};">🔴 ${expiringGroups.critical.length} critical (≤1 day)</span></td></tr>` : ""}
                ${hasWarning  ? `<tr><td style="padding:2px 0;"><span style="font-size:11px;color:${ORANGE};">🟡 ${expiringGroups.warning.length} warning (2–3 days)</span></td></tr>` : ""}
                ${hasNotice   ? `<tr><td style="padding:2px 0;"><span style="font-size:11px;color:${ACCENT};">🔵 ${expiringGroups.notice.length} upcoming (4–7 days)</span></td></tr>` : ""}
              </table>
            </td>
          </tr>
        </table>
      </div>
    </td>
  </tr>

  ${section("Critical — Expires Today or Tomorrow", RED,    "🔴", expiringGroups.critical)}
  ${section("Warning — Expires in 2–3 Days",        ORANGE, "🟡", expiringGroups.warning)}
  ${section("Upcoming — Expires in 4–7 Days",       ACCENT, "🔵", expiringGroups.notice)}

  <!-- ── CTA ── -->
  <tr>
    <td style="padding:0 40px 28px;text-align:center;">
      <a href="${dashboardUrl}"
         style="display:inline-block;background:${ACCENT};color:#fff;font-size:14px;
                font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;
                letter-spacing:0.3px;">
        Open Subscription Dashboard →
      </a>
    </td>
  </tr>

  <!-- ── Footer note ── -->
  <tr>
    <td style="padding:0 40px 28px;">
      <div style="background:${ACCENT}0D;border:1px solid ${ACCENT}25;border-radius:10px;padding:14px 16px;">
        <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">
          This digest is sent automatically every day at 08:00 AM IST.
          Individual reminder emails have already been sent to each affected company.
        </p>
      </div>
    </td>
  </tr>`;

  // Plain-text fallback
  const lines = [`SkyUp CRM — SuperAdmin Subscription Expiry Digest`, ``, `Hi ${superAdminName},`, `Run at: ${runDate}`, ``, `${totalExpiring} company/companies require attention.`, ``];
  if (hasCritical) {
    lines.push("🔴 CRITICAL (≤1 day):");
    expiringGroups.critical.forEach(c => lines.push(`  • ${c.name} (${c.plan}) — expires ${new Date(c.expiryDate).toLocaleDateString("en-IN")}`));
    lines.push("");
  }
  if (hasWarning) {
    lines.push("🟡 WARNING (2–3 days):");
    expiringGroups.warning.forEach(c => lines.push(`  • ${c.name} (${c.plan}) — expires ${new Date(c.expiryDate).toLocaleDateString("en-IN")}`));
    lines.push("");
  }
  if (hasNotice) {
    lines.push("🔵 UPCOMING (4–7 days):");
    expiringGroups.notice.forEach(c => lines.push(`  • ${c.name} (${c.plan}) — expires ${new Date(c.expiryDate).toLocaleDateString("en-IN")}`));
    lines.push("");
  }
  lines.push(`Manage subscriptions: ${dashboardUrl}`);

  return {
    subject: totalExpiring === 0
      ? `✅ No Expiring Subscriptions Today — SkyUp CRM`
      : hasCritical
        ? `🚨 ${expiringGroups.critical.length} Subscription(s) Expiring TODAY — SkyUp CRM`
        : `⚠️ ${totalExpiring} Subscription(s) Expiring Soon — SkyUp CRM`,
    html: shell(body),
    text: lines.join("\n"),
  };
};

// ── 4. Plan Invoice / Activation Email ───────────────────────────────────────
// Sent to SuperAdmin AND Developer after a plan is renewed or upgraded.
// Works for both Razorpay-paid invoices and manual developer activations.
//
// @param {object} opts
//   recipientName   {string}    — e.g. "Platform Admin" or "Dev Team"
//   recipientRole   {string}    — "superadmin" | "developer"
//   companyName     {string}    — the company whose plan changed
//   companyEmail    {string}    — company's registered email
//   planName        {string}    — "Starter" | "Growth" | "Enterprise"
//   billing         {string}    — "monthly" | "yearly"
//   newExpiry       {Date|string}
//   actionType      {string}    — "renewal" | "upgrade" | "activation"
//   invoiceId       {string|null}
//   amount          {number|null}  — in INR (not paise)
//   transactionId   {string|null}
//   paymentDate     {Date|string|null}
//   dashboardUrl    {string}
const planInvoiceEmail = ({
  recipientName  = "Admin",
  recipientRole  = "superadmin",
  companyName,
  companyEmail   = "",
  planName       = "Pro",
  billing        = "monthly",
  newExpiry,
  actionType     = "renewal",
  invoiceId      = null,
  amount         = null,
  transactionId  = null,
  paymentDate    = null,
  dashboardUrl   = process.env.FRONTEND_URL
    ? `${process.env.FRONTEND_URL}/developer/subscriptions`
    : "https://app.skyupcrm.com/developer/subscriptions",
}) => {
  const isPaid     = amount !== null && invoiceId !== null;
  const actionWord = actionType === "renewal"  ? "Renewed"
                   : actionType === "upgrade"  ? "Upgraded"
                   :                             "Activated";
  const actionIcon = actionType === "renewal"  ? "🔄"
                   : actionType === "upgrade"  ? "🚀"
                   :                             "✅";

  const planLabel  = (planName || "").charAt(0).toUpperCase() + (planName || "").slice(1);
  const planColor  = planName?.toLowerCase() === "enterprise" ? ORANGE
                   : ["growth","pro"].includes(planName?.toLowerCase()) ? ACCENT
                   : GREEN;

  const billingLabel = billing === "yearly" ? "Annual" : "Monthly";
  const expiryStr    = new Date(newExpiry).toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });
  const paymentStr   = paymentDate
    ? new Date(paymentDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const amountStr    = amount != null ? `\u20B9${Number(amount).toLocaleString("en-IN")}` : "\u2014";

  const roleBadgeColor = recipientRole === "developer" ? ORANGE : ACCENT;
  const roleBadgeLabel = recipientRole === "developer" ? "Developer" : "Super Admin";

  const detailRows = [
    ["Company",        companyName],
    ["Company Email",  companyEmail || "\u2014"],
    ["Plan",           planLabel],
    ["Billing Cycle",  billingLabel],
    ["New Expiry",     expiryStr],
    ...(isPaid ? [
      ["Invoice ID",    invoiceId],
      ["Amount Paid",   amountStr],
      ["Transaction ID", transactionId || "\u2014"],
      ["Payment Date",  paymentStr],
    ] : [
      ["Activated On",  paymentStr],
      ["Activated By",  "Developer Panel"],
    ]),
  ].map(([label, value], i, arr) => {
    const isLast = i === arr.length - 1;
    return `
    <tr>
      <td style="padding:10px 0;${!isLast ? `border-bottom:1px solid ${BORDER};` : ""}width:42%;">
        <span style="font-size:12px;color:${MUTED};">${label}</span>
      </td>
      <td style="padding:10px 0;${!isLast ? `border-bottom:1px solid ${BORDER};` : ""}">
        <span style="font-size:13px;font-weight:600;color:${TEXT};">${value}</span>
      </td>
    </tr>`;
  }).join("");

  const body = `
  <!-- Role badge banner -->
  <tr>
    <td style="padding:0;">
      <div style="background:${roleBadgeColor}15;border-bottom:2px solid ${roleBadgeColor}40;padding:14px 40px;">
        <p style="margin:0;font-size:11px;font-weight:700;color:${roleBadgeColor};
                  letter-spacing:1.5px;text-transform:uppercase;">
          \uD83D\uDEE1\uFE0F ${roleBadgeLabel} &nbsp;·&nbsp; Plan ${actionWord} Notification
        </p>
      </div>
    </td>
  </tr>
  <!-- Hero -->
  <tr>
    <td style="padding:28px 40px 0;">
      <p style="margin:0 0 6px;font-size:24px;font-weight:800;color:${TEXT};line-height:1.25;">
        ${actionIcon} Plan ${actionWord}
      </p>
      <p style="margin:0 0 24px;font-size:13px;color:${MUTED};line-height:1.6;">
        Hi <strong style="color:${TEXT};">${recipientName}</strong>,
        the subscription for <strong style="color:${TEXT};">${companyName}</strong>
        has been successfully <strong style="color:${GREEN};">${actionWord.toLowerCase()}</strong>
        to the <strong style="color:${planColor};">${planLabel}</strong> plan.
        ${isPaid
          ? "The payment has been processed and the invoice details are below."
          : "The subscription was activated manually via the Developer Panel."}
      </p>
    </td>
  </tr>
  <!-- Details card -->
  <tr>
    <td style="padding:0 40px 24px;">
      <div style="background:${BG};border:1px solid ${BORDER};border-radius:14px;padding:24px 28px;">
        <p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:${DIM};">${isPaid ? "Invoice Details" : "Activation Details"}</p>
        <table cellpadding="0" cellspacing="0" width="100%">${detailRows}</table>
      </div>
    </td>
  </tr>
  ${isPaid ? `
  <!-- Amount highlight -->
  <tr>
    <td style="padding:0 40px 24px;">
      <div style="background:${GREEN}10;border:1px solid ${GREEN}30;border-radius:14px;padding:20px 28px;text-align:center;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${GREEN}80;">Amount Paid</p>
        <p style="margin:0;font-size:32px;font-weight:800;color:${GREEN};">${amountStr}</p>
        <p style="margin:4px 0 0;font-size:11px;color:${MUTED};">${billingLabel} &nbsp;·&nbsp; ${planLabel} Plan</p>
      </div>
    </td>
  </tr>` : ""}
  <!-- CTA -->
  <tr>
    <td style="padding:0 40px 28px;text-align:center;">
      <a href="${dashboardUrl}"
         style="display:inline-block;background:${ACCENT};color:#fff;font-size:14px;
                font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;">
        View Subscription Dashboard \u2192
      </a>
    </td>
  </tr>`;

  const subject = isPaid
    ? `${actionIcon} Invoice: ${companyName} \u2014 ${planLabel} Plan ${actionWord} (${invoiceId})`
    : `${actionIcon} Plan ${actionWord}: ${companyName} \u2192 ${planLabel}`;

  const text = [
    `SkyUp CRM \u2014 Plan ${actionWord} ${isPaid ? "Invoice" : "Notification"}`,
    ``,
    `Hi ${recipientName},`,
    `The subscription for ${companyName} has been ${actionWord.toLowerCase()} to the ${planLabel} plan.`,
    ``,
    `Company:      ${companyName}`,
    `Plan:         ${planLabel} (${billingLabel})`,
    `New Expiry:   ${expiryStr}`,
    ...(isPaid ? [
      `Invoice ID:   ${invoiceId}`,
      `Amount Paid:  ${amountStr}`,
      `Transaction:  ${transactionId || "\u2014"}`,
      `Date:         ${paymentStr}`,
    ] : [`Activated On: ${paymentStr}`, `Source:       Developer Panel`]),
    ``,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");

  return { subject, html: shell(body), text };
};

module.exports = {
  companyWelcomeEmail,
  subscriptionExpiryEmail,
  superAdminExpiryDigestEmail,
  planInvoiceEmail,
};