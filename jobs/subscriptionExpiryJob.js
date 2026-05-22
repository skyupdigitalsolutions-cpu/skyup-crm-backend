// jobs/subscriptionExpiryJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily cron that finds companies whose subscriptions expire in exactly
// 7 days, 3 days, or 1 day and sends a warning email to each one.
//
// Requires:
//   npm install node-cron
//
// Env vars used (same as brevoMailer):
//   BREVO_API_KEY, BREVO_FROM_EMAIL, BREVO_FROM_NAME,
//   FRONTEND_URL (optional — for the renewal deep-link),
//   SUPPORT_EMAIL (optional)
// ─────────────────────────────────────────────────────────────────────────────

const cron    = require("node-cron");
const Company = require("../models/Company");
const { sendEmail }                = require("../utils/brevoMailer");
const { subscriptionExpiryEmail }  = require("../utils/emailTemplates");

// Days before expiry at which we send a reminder
const WARNING_DAYS = [7, 3, 1];

// ── Core scan function (exported so it can be called manually / in tests) ─────
const runExpiryCheck = async () => {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight UTC

  let totalSent = 0;

  for (const daysLeft of WARNING_DAYS) {
    // Target window: subscriptions that expire between midnight of (today + daysLeft)
    // and midnight of (today + daysLeft + 1).  This ensures each company only
    // gets one email per warning tier, regardless of what time the cron fires.
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

        totalSent++;
        console.log(
          `[SubscriptionExpiryJob] ✉  Sent ${daysLeft}-day warning to ${company.email} (${company.name})`
        );
      } catch (err) {
        // Log but never crash the job — one bad address shouldn't stop others
        console.error(
          `[SubscriptionExpiryJob] ✗  Failed for ${company.email}:`,
          err.message
        );
      }
    }
  }

  // ── Also catch already-expired subscriptions and flip their status ──────────
  // This keeps the DB consistent even if Razorpay webhooks miss an event.
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
    `[SubscriptionExpiryJob] ✅ Done — ${totalSent} warning email(s) sent at ${new Date().toISOString()}`
  );
};

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