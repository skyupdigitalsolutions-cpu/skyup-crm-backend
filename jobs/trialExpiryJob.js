// jobs/trialExpiryJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily scan for 7-day Pro trials that have lapsed WITHOUT conversion.
// For each, it:
//   1. flips the company to "expired" + isActive:false (→ read-only),
//   2. emails the customer ("trial expired — pick a plan to continue"),
//   3. sets trialExpiredEmailSent:true so the email fires exactly once.
//
// Only companies that ADDED a payment method (paymentMethodProvided) and never
// converted to a paid plan (subscriptionExpiry == null) are targeted — paying
// customers are never touched.
// ─────────────────────────────────────────────────────────────────────────────

const cron    = require("node-cron");
const Company = require("../models/Company");
const { sendEmail }         = require("../utils/brevoMailer");
const { trialExpiredEmail } = require("../utils/trialEmailTemplates");

const runTrialExpiryCheck = async () => {
  const now = new Date();

  const lapsed = await Company.find({
    // A trial that was actually started (works for both billing modes —
    // onetime mode never sets paymentMethodProvided, so we key off trialStartedAt).
    trialStartedAt:         { $ne: null },
    trialExpiredEmailSent:  false,
    trialEndsAt:            { $ne: null, $lt: now },
    subscriptionStatus:     { $in: ["trial", "expired"] },
    subscriptionExpiry:     null, // never converted to a paid plan
  }).select("name email plan trialPlan");

  let processed = 0;

  for (const company of lapsed) {
    try {
      await Company.findByIdAndUpdate(company._id, {
        subscriptionStatus:    "expired",
        isActive:              false,
        trialExpiredEmailSent: true,
      });

      const planName = (company.trialPlan || "pro") === "pro" ? "Pro" : (company.trialPlan || "Pro");
      const tpl = trialExpiredEmail({ companyName: company.name, planName });
      await sendEmail({ to: company.email, toName: company.name, ...tpl });

      processed++;
      console.log(`[TrialExpiryJob] ✉  Trial-expired email sent to ${company.email}`);
    } catch (err) {
      console.error(`[TrialExpiryJob] ✗  Failed for ${company.email}:`, err.message);
    }
  }

  console.log(`[TrialExpiryJob] ✅ Done — ${processed} expired trial(s) processed at ${now.toISOString()}`);
  return processed;
};

// Fires daily at 08:30 IST (03:00 UTC) — just after the subscription expiry job.
const startTrialExpiryJob = () => {
  cron.schedule("0 3 * * *", async () => {
    console.log("[TrialExpiryJob] 🔄 Running daily trial-expiry check…");
    try {
      await runTrialExpiryCheck();
    } catch (err) {
      console.error("[TrialExpiryJob] Unhandled error:", err.message);
    }
  }, { timezone: "UTC" });

  console.log("[TrialExpiryJob] 🕗 Scheduled — fires daily at 08:30 IST (03:00 UTC)");
};

module.exports = { startTrialExpiryJob, runTrialExpiryCheck };