// jobs/subscriptionExpiryJob.js — UPDATED
// Changes from original:
//  1. Added: expire addons past their expiryDate (status → "expired")
//  2. Added: expire benefits past their validUntil (active → false)
//  3. Added: data retention cleanup (delete recordings/transcriptions older than plan limit)
//  4. All existing warning-email + auto-expire logic is UNCHANGED.
//  5. FIX: emit `subscription_expiry_alert` socket event to each super_admin after
//          the daily cron runs, so the bell updates without a page reload.
//          Previously this event was only listened for on the frontend but never
//          emitted from the backend — the listener was dead code.

const cron           = require("node-cron");
const Company        = require("../models/Company");
const CompanyAddon   = require("../models/CompanyAddon");
const CompanyBenefit = require("../models/CompanyBenefit");
const Admin          = require("../models/Admin");
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
  const expiredAddons = await CompanyAddon.updateMany(
    { status: "active", expiryDate: { $ne: null, $lt: now } },
    { $set: { status: "expired" } }
  );
  if (expiredAddons.modifiedCount > 0) {
    console.log(`[SubscriptionExpiryJob] 📦 Expired ${expiredAddons.modifiedCount} addon(s)`);
  }

  // ── 4. Expire benefits past their validUntil ──────────────────────────────
  const expiredBenefits = await CompanyBenefit.updateMany(
    { active: true, validUntil: { $ne: null, $lt: now } },
    { $set: { active: false } }
  );
  if (expiredBenefits.modifiedCount > 0) {
    console.log(`[SubscriptionExpiryJob] 🎁 Expired ${expiredBenefits.modifiedCount} benefit(s)`);
  }

  // ── 5. Data retention cleanup ──────────────────────────────────────────────
  try {
    const companies = await Company.find({ isActive: true })
      .select("_id plan subscriptionStatus")
      .lean();

    const PlanConfig = require("../models/PlanConfig");
    const Lead       = require("../models/Leads");
    const { DEFAULT_PLAN_LIMITS } = require("../services/entitlementService");

    for (const company of companies) {
      if (!["active", "trial"].includes(company.subscriptionStatus)) continue;

      let retentionDays = DEFAULT_PLAN_LIMITS[company.plan]?.dataRetentionDays ?? 15;

      try {
        const dbPlan = await PlanConfig.findOne({ planKey: company.plan }).select("dataRetentionDays").lean();
        if (dbPlan?.dataRetentionDays) retentionDays = dbPlan.dataRetentionDays;
      } catch (_) {}

      if (!retentionDays || retentionDays <= 0) continue;

      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - retentionDays);

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
    console.error("[SubscriptionExpiryJob] Retention cleanup error:", retentionErr.message);
  }

  // ── 6. FIX: Emit subscription_expiry_alert socket event to each super_admin ─
  // Previously this event was never emitted — the frontend listener was dead code.
  // Now each super_admin's bell updates in real-time when the cron fires.
  try {
    const _io = global._io;
    if (_io) {
      // Find companies expiring in next 30 days for the socket payload
      const cutoff30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
      const soonCompanies = await Company.find({
        subscriptionStatus: "active",
        subscriptionExpiry: { $gte: today, $lte: cutoff30 },
        isActive: true,
      }).select("_id name plan subscriptionExpiry company").lean();

      if (soonCompanies.length > 0) {
        // Find all super_admins and notify each one scoped to their own company
        const superAdmins = await Admin.find({ role: "super_admin" })
          .select("_id company")
          .lean();

        for (const sa of superAdmins) {
          const saCompanyId = String(sa.company);

          // Only include companies that belong to this super_admin's company
          // (For multi-tenant: each super_admin only sees their own company's data)
          const myCompanies = soonCompanies.filter(
            c => String(c.company || c._id) === saCompanyId
          );

          // Fallback: if company field isn't populated on the Company doc itself,
          // send all expiring companies (single-tenant deployments)
          const payload = myCompanies.length > 0 ? myCompanies : soonCompanies;

          const nowMs = Date.now();
          const critical = payload.filter(c => {
            const days = Math.round((new Date(c.subscriptionExpiry) - nowMs) / 86_400_000);
            return days <= 1;
          }).length;
          const warning = payload.filter(c => {
            const days = Math.round((new Date(c.subscriptionExpiry) - nowMs) / 86_400_000);
            return days > 1 && days <= 3;
          }).length;
          const notice = payload.length - critical - warning;

          _io.to(`superadmin:${sa._id}`).emit("subscription_expiry_alert", {
            totalExpiring: payload.length,
            critical,
            warning,
            notice,
            companies: payload.map(c => ({
              _id:          c._id,
              name:         c.name,
              plan:         c.plan,
              daysRemaining: Math.max(0, Math.round(
                (new Date(c.subscriptionExpiry) - nowMs) / 86_400_000
              )),
            })),
            timestamp: new Date().toISOString(),
          });

          console.log(
            `[SubscriptionExpiryJob] 🔔 Emitted subscription_expiry_alert to superadmin:${sa._id} — ${payload.length} company(ies)`
          );
        }
      }
    }
  } catch (socketErr) {
    // Never crash the whole job on socket errors
    console.error("[SubscriptionExpiryJob] Socket notify error:", socketErr.message);
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
