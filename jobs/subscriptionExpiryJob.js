// jobs/subscriptionExpiryJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily cron that:
//  1. Finds companies whose subscriptions expire in exactly 7, 3, or 1 days
//     and sends a warning email to EACH COMPANY.
//  2. Sends a DIGEST email to every SuperAdmin listing all expiring companies.
//  3. Emits a real-time socket event to connected SuperAdmin clients so the
//     in-app notification bell lights up immediately after the cron runs.
//  4. Auto-expires subscriptions that are already past their expiry date.
//
// Requires:
//   npm install node-cron
//
// Env vars used (same as brevoMailer):
//   BREVO_API_KEY, BREVO_FROM_EMAIL, BREVO_FROM_NAME,
//   FRONTEND_URL (optional — for the renewal / dashboard deep-links),
//   SUPPORT_EMAIL (optional)
// ─────────────────────────────────────────────────────────────────────────────

const cron       = require("node-cron");
const Company    = require("../models/Company");
const SuperAdmin = require("../models/SuperAdmin");
const Admin      = require("../models/Admin");

const { sendEmail }                     = require("../utils/brevoMailer");
const { subscriptionExpiryEmail,
        superAdminExpiryDigestEmail }   = require("../utils/emailTemplates");

// Days before expiry at which we warn the company
const WARNING_DAYS = [7, 3, 1];

// ── Core scan function (exported so it can be called manually / in tests) ─────
const runExpiryCheck = async () => {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight UTC

  // ── Buckets for the SuperAdmin digest ──────────────────────────────────────
  // critical = ≤ 1 day, warning = 2–3 days, notice = 4–7 days
  const digestGroups = { critical: [], warning: [], notice: [] };
  let   totalCompanySent = 0;

  // ── Step 1: Company-facing warning emails ──────────────────────────────────
  for (const daysLeft of WARNING_DAYS) {
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() + daysLeft);

    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 1);

    const expiring = await Company.find({
      subscriptionStatus: "active",
      subscriptionExpiry: { $gte: windowStart, $lt: windowEnd },
      isActive:           true,
    }).select("name email plan subscriptionExpiry").lean();

    for (const company of expiring) {
      // ── Send warning email to the company ─────────────────────────────────
      try {
        const template = subscriptionExpiryEmail({
          companyName: company.name,
          plan:        company.plan,
          daysLeft,
          expiryDate:  company.subscriptionExpiry,
        });

        await sendEmail({
          to:      company.email,
          toName:  company.name,
          subject: template.subject,
          html:    template.html,
          text:    template.text,
        });

        totalCompanySent++;
        console.log(
          `[SubscriptionExpiryJob] ✉  Sent ${daysLeft}-day warning to ${company.email} (${company.name})`
        );
      } catch (err) {
        console.error(
          `[SubscriptionExpiryJob] ✗  Failed company email for ${company.email}:`,
          err.message
        );
      }

      // ── Add to digest bucket ───────────────────────────────────────────────
      const entry = {
        name:       company.name,
        email:      company.email,
        plan:       company.plan,
        daysLeft,
        expiryDate: company.subscriptionExpiry,
      };

      if (daysLeft <= 1)       digestGroups.critical.push(entry);
      else if (daysLeft <= 3)  digestGroups.warning.push(entry);
      else                     digestGroups.notice.push(entry);
    }
  }

  const totalExpiring = (
    digestGroups.critical.length +
    digestGroups.warning.length  +
    digestGroups.notice.length
  );

  // ── Step 2: SuperAdmin digest email ───────────────────────────────────────
  // Only send if there's at least one expiring company (avoids noisy daily
  // "nothing to report" emails; remove the guard if you prefer daily pings).
  if (totalExpiring > 0) {
    const superAdminEmails = await _collectSuperAdminEmails();

    for (const { email, name } of superAdminEmails) {
      try {
        const digest = superAdminExpiryDigestEmail({
          superAdminName: name,
          expiringGroups: digestGroups,
          totalExpiring,
        });

        await sendEmail({
          to:      email,
          toName:  name,
          subject: digest.subject,
          html:    digest.html,
          text:    digest.text,
        });

        console.log(
          `[SubscriptionExpiryJob] 📧 Sent digest to SuperAdmin ${email} (${totalExpiring} expiring)`
        );
      } catch (err) {
        console.error(
          `[SubscriptionExpiryJob] ✗  Failed digest for SuperAdmin ${email}:`,
          err.message
        );
      }
    }
  }

  // ── Step 3: Real-time socket notification to connected SuperAdmins ─────────
  // Uses global._io set in server.js. Emits `subscription_expiry_alert` to
  // every connected super_admin room so the NotificationBell lights up.
  if (totalExpiring > 0) {
    _emitToSuperAdmins(digestGroups, totalExpiring);
  }

  // ── Step 4: Auto-expire overdue subscriptions ─────────────────────────────
  const expired = await Company.updateMany(
    {
      subscriptionStatus: "active",
      subscriptionExpiry: { $lt: today },
    },
    { $set: { subscriptionStatus: "expired" } }
  );

  if (expired.modifiedCount > 0) {
    console.log(
      `[SubscriptionExpiryJob] ⚡ Auto-expired ${expired.modifiedCount} subscription(s)`
    );
  }

  console.log(
    `[SubscriptionExpiryJob] ✅ Done — ${totalCompanySent} company warning(s) sent, ` +
    `${totalExpiring} in SuperAdmin digest, at ${new Date().toISOString()}`
  );
};

// ── Helper: collect all unique SuperAdmin email/name pairs ────────────────────
// Sources:
//   1. Legacy SuperAdmin model (global platform admin)
//   2. Admin model with role === "super_admin" (company-level super admins)
async function _collectSuperAdminEmails() {
  const seen  = new Set();
  const result = [];

  const addEntry = ({ email, name }) => {
    const key = email.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ email: email.trim(), name: name || "Super Admin" });
    }
  };

  // Legacy global SuperAdmin(s)
  try {
    const legacyAdmins = await SuperAdmin.find({}).select("email name").lean();
    legacyAdmins.forEach(addEntry);
  } catch (err) {
    console.error("[SubscriptionExpiryJob] Could not fetch legacy SuperAdmins:", err.message);
  }

  // Company-level super_admins from Admin model
  try {
    const companyAdmins = await Admin.find({ role: "super_admin" }).select("email name").lean();
    companyAdmins.forEach(addEntry);
  } catch (err) {
    console.error("[SubscriptionExpiryJob] Could not fetch Admin super_admins:", err.message);
  }

  return result;
}

// ── Helper: emit socket notifications to all connected SuperAdmin clients ──────
// Finds all super_admin sockets in global._io and emits `subscription_expiry_alert`.
async function _emitToSuperAdmins(digestGroups, totalExpiring) {
  try {
    const io = global._io;
    if (!io) return;

    // Find all Admin-model super_admin IDs so we can emit to their named rooms
    const superAdmins = await Admin.find({ role: "super_admin" }).select("_id").lean();

    for (const sa of superAdmins) {
      io.to(`superadmin:${sa._id}`).emit("subscription_expiry_alert", {
        totalExpiring,
        critical: digestGroups.critical.length,
        warning:  digestGroups.warning.length,
        notice:   digestGroups.notice.length,
        companies: [
          ...digestGroups.critical,
          ...digestGroups.warning,
          ...digestGroups.notice,
        ],
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[SubscriptionExpiryJob] 🔔 Socket alert emitted to ${superAdmins.length} super_admin room(s)`
    );
  } catch (err) {
    // Non-fatal — email already delivered
    console.error("[SubscriptionExpiryJob] Socket emit error:", err.message);
  }
}

// ── Register the cron schedule ────────────────────────────────────────────────
// Fires at 08:00 AM IST every day (UTC 02:30).
// IST = UTC+5:30  →  08:00 IST = 02:30 UTC
// Cron format: second(opt) minute hour day month weekday
const startSubscriptionExpiryJob = () => {
  cron.schedule("30 2 * * *", async () => {
    console.log("[SubscriptionExpiryJob] 🔄 Running daily expiry check…");
    try {
      await runExpiryCheck();
    } catch (err) {
      console.error("[SubscriptionExpiryJob] Unhandled error:", err.message);
    }
  }, {
    timezone: "UTC",
  });

  console.log("[SubscriptionExpiryJob] 🕗 Scheduled — fires daily at 08:00 IST (02:30 UTC)");
};

module.exports = { startSubscriptionExpiryJob, runExpiryCheck };