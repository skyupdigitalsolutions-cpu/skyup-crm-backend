// jobs/subscriptionExpiryJob.js — UPDATED
// Changes from original:
//  1. Added: expire addons past their expiryDate (status → "expired")
//  2. Added: expire benefits past their validUntil (active → false)
//  3. Added: data retention cleanup (delete recordings/transcriptions older than plan limit)
//  4. All existing warning-email + auto-expire logic is UNCHANGED.

const cron           = require("node-cron");
const Company        = require("../models/Company");
const CompanyAddon   = require("../models/CompanyAddon");
const CompanyBenefit = require("../models/CompanyBenefit");
const { sendEmail }               = require("../utils/brevoMailer");
const { subscriptionExpiryEmail } = require("../utils/emailTemplates");

const WARNING_DAYS = [7, 3, 1];

// ── Core scan (exported so it can be triggered manually / in tests) ────────────
const runExpiryCheck = async () => {
  const now   = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  let totalSent = 0;

  // ── 1. Subscription expiry warning emails ─────────────────────────────────
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
      try {
        const template = subscriptionExpiryEmail({
          companyName: company.name,
          plan:        company.plan,
          daysLeft,
          expiryDate:  company.subscriptionExpiry,
        });
        await sendEmail({ to: company.email, toName: company.name, subject: template.subject, html: template.html, text: template.text });
        totalSent++;
        console.log(`[SubscriptionExpiryJob] ✉  Sent ${daysLeft}-day warning to ${company.email}`);
      } catch (err) {
        console.error(`[SubscriptionExpiryJob] ✗  Failed for ${company.email}:`, err.message);
      }
    }
  }

  // ── 2. Auto-expire subscriptions that passed their expiry date ─────────────
  const expired = await Company.updateMany(
    { subscriptionStatus: "active", subscriptionExpiry: { $lt: today } },
    { $set: { subscriptionStatus: "expired", isActive: false } }
  );
  if (expired.modifiedCount > 0) {
    console.log(`[SubscriptionExpiryJob] ⚡ Auto-expired ${expired.modifiedCount} subscription(s)`);
  }

  // ── 3. Expire addons past their expiryDate ────────────────────────────────
  // NEW: any active addon whose expiryDate has passed → status "expired"
  const expiredAddons = await CompanyAddon.updateMany(
    { status: "active", expiryDate: { $ne: null, $lt: now } },
    { $set: { status: "expired" } }
  );
  if (expiredAddons.modifiedCount > 0) {
    console.log(`[SubscriptionExpiryJob] 📦 Expired ${expiredAddons.modifiedCount} addon(s)`);
  }

  // ── 4. Expire benefits past their validUntil ──────────────────────────────
  // NEW: any active benefit whose validUntil has passed → active: false
  const expiredBenefits = await CompanyBenefit.updateMany(
    { active: true, validUntil: { $ne: null, $lt: now } },
    { $set: { active: false } }
  );
  if (expiredBenefits.modifiedCount > 0) {
    console.log(`[SubscriptionExpiryJob] 🎁 Expired ${expiredBenefits.modifiedCount} benefit(s)`);
  }

  // ── 5. Data retention cleanup ──────────────────────────────────────────────
  // NEW: delete call recordings/transcriptions older than the company's plan limit.
  // We do this lazily — find active companies with a retention limit and remove
  // old callHistory entries from Leads (recordingUrl/transcriptionText).
  //
  // This avoids loading all leads by doing a targeted $pull on callHistory
  // entries whose calledAt is older than the retention window.
  try {
    const companies = await Company.find({ isActive: true })
      .select("_id plan subscriptionStatus")
      .lean();

    // Import inline to avoid circular dependency issues at module load time
    const PlanConfig = require("../models/PlanConfig");
    const Lead       = require("../models/Leads");
    const { DEFAULT_PLAN_LIMITS } = require("../services/entitlementService");

    for (const company of companies) {
      // Only clean active or trial companies
      if (!["active", "trial"].includes(company.subscriptionStatus)) continue;

      let retentionDays = DEFAULT_PLAN_LIMITS[company.plan]?.dataRetentionDays ?? 15;

      // Try to get from DB plan first
      try {
        const dbPlan = await PlanConfig.findOne({ planKey: company.plan }).select("dataRetentionDays").lean();
        if (dbPlan?.dataRetentionDays) retentionDays = dbPlan.dataRetentionDays;
      } catch (_) {}

      if (!retentionDays || retentionDays <= 0) continue;

      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - retentionDays);

      // Remove callHistory entries older than the retention cutoff that have a recording
      const result = await Lead.updateMany(
        { company: company._id },
        {
          $pull: {
            callHistory: {
              calledAt:     { $lt: cutoff },
              recordingUrl: { $ne: null },
            },
          },
        }
      );

      if (result.modifiedCount > 0) {
        console.log(
          `[SubscriptionExpiryJob] 🗑  Cleaned recordings older than ${retentionDays}d for company ${company._id} (${result.modifiedCount} lead(s) updated)`
        );
      }
    }
  } catch (retentionErr) {
    // Never crash the whole job on retention errors
    console.error("[SubscriptionExpiryJob] Retention cleanup error:", retentionErr.message);
  }

  console.log(
    `[SubscriptionExpiryJob] ✅ Done — ${totalSent} warning email(s) sent at ${new Date().toISOString()}`
  );
};

// ── Register daily cron ────────────────────────────────────────────────────────
// Fires at 08:00 AM IST (02:30 UTC) every day.
const startSubscriptionExpiryJob = () => {
  cron.schedule("30 2 * * *", async () => {
    console.log("[SubscriptionExpiryJob] 🔄 Running daily expiry check…");
    try {
      await runExpiryCheck();
    } catch (err) {
      console.error("[SubscriptionExpiryJob] Unhandled error:", err.message);
    }
  }, { timezone: "UTC" });

  console.log("[SubscriptionExpiryJob] 🕗 Scheduled — fires daily at 08:00 IST (02:30 UTC)");
};

module.exports = { startSubscriptionExpiryJob, runExpiryCheck };
