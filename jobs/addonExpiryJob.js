// jobs/addonExpiryJob.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Cron job: runs hourly. Flips any CompanyAddon whose expiryDate has passed from
// status "active" → "expired".
//
// NOTE: Entitlements are ALREADY correct without this job — getCompanyEntitlements
// filters addons by { status: "active", expiryDate > now }, so an expired credit
// pack stops counting toward the monthly pool the instant it's read. This job is
// housekeeping: it keeps the stored status field accurate so admin / usage / audit
// views don't show an expired pack as "active". Purely cosmetic + reporting.
//
// Credit packs (AI minute packs) are created with a 30-day expiryDate (see
// CompanyAddon.computeAddonExpiry), so they are the main thing this sweep closes.
// ─────────────────────────────────────────────────────────────────────────────

const cron         = require("node-cron");
const CompanyAddon = require("../models/CompanyAddon");

let logAudit = async () => {};
try {
  ({ logAudit } = require("../services/entitlementService"));
} catch (_) { /* audit optional */ }

// ── Core function (exported for manual / test invocation) ─────────────────────
const runAddonExpiry = async () => {
  const now = new Date();

  // Find active addons whose expiry has passed.
  const expired = await CompanyAddon.find({
    status:     "active",
    expiryDate: { $ne: null, $lte: now },
  }).select("_id companyId addonType expiryDate").lean();

  if (expired.length === 0) return 0;

  const ids = expired.map((a) => a._id);
  await CompanyAddon.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "expired" } },
  );

  for (const a of expired) {
    await logAudit({
      companyId: a.companyId,
      actorRole: "system",
      action:    "addon_expired",
      field:     "addonType",
      oldValue:  a.addonType,
      newValue:  null,
      reason:    `Add-on "${a.addonType}" expired on ${new Date(a.expiryDate).toISOString()}.`,
    }).catch(() => {});
  }

  console.log(`[AddonExpiryJob] ✅ Marked ${expired.length} add-on(s) expired.`);
  return expired.length;
};

// ── Register hourly cron ──────────────────────────────────────────────────────
// "0 * * * *" = top of every hour
const startAddonExpiryJob = () => {
  cron.schedule("0 * * * *", async () => {
    try {
      await runAddonExpiry();
    } catch (err) {
      console.error("[AddonExpiryJob] Unhandled error:", err.message);
    }
  }, { timezone: "UTC" });

  console.log("[AddonExpiryJob] 🕐 Scheduled — fires hourly to expire elapsed add-ons");
};

module.exports = { startAddonExpiryJob, runAddonExpiry };
