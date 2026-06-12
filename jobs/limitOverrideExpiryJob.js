// jobs/limitOverrideExpiryJob.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Cron job: runs hourly. For every company that has priced/time-limited limit
// overrides (company.devOverrides.limitMeta), any field whose expiresAt has
// passed is reverted to "inherit" — i.e. the numeric override is set back to
// null and its meta entry is removed. This is the auto-revert behaviour for
// additional limits that were granted with a time limit.
// ─────────────────────────────────────────────────────────────────────────────

const cron    = require("node-cron");
const Company = require("../models/Company");

let logAudit = async () => {};
try {
  ({ logAudit } = require("../services/entitlementService"));
} catch (_) { /* audit optional */ }

// ── Core function (exported for manual / test invocation) ─────────────────────
const runLimitOverrideExpiry = async () => {
  const now = new Date();

  // Only scan companies that actually have limitMeta entries.
  const companies = await Company.find({ "devOverrides.limitMeta": { $exists: true, $ne: {} } })
    .select("_id name devOverrides")
    .lean();

  let reverted = 0;

  for (const company of companies) {
    try {
      const ov   = company.devOverrides || {};
      const meta = ov.limitMeta instanceof Map ? Object.fromEntries(ov.limitMeta) : (ov.limitMeta || {});
      if (!meta || Object.keys(meta).length === 0) continue;

      const setPayload   = {};
      const unsetFields  = [];
      const expiredKeys  = [];

      for (const [field, m] of Object.entries(meta)) {
        if (!m || !m.expiresAt) continue;            // no time limit → never expires
        if (new Date(m.expiresAt).getTime() > now.getTime()) continue; // not yet expired

        // Expired → revert the numeric override to inherit (null) and drop meta
        setPayload[`devOverrides.${field}`] = null;
        unsetFields.push(field);
        expiredKeys.push(field);
      }

      if (expiredKeys.length === 0) continue;

      // Rebuild limitMeta without the expired fields
      const nextMeta = { ...meta };
      for (const f of unsetFields) delete nextMeta[f];
      setPayload["devOverrides.limitMeta"] = nextMeta;

      await Company.findByIdAndUpdate(company._id, { $set: setPayload });

      for (const field of expiredKeys) {
        await logAudit({
          companyId: company._id,
          actorRole: "system",
          action:    "limit_override_expired",
          field:     `devOverrides.${field}`,
          oldValue:  meta[field]?.value ?? null,
          newValue:  null,
          reason:    "Additional limit time period elapsed — reverted to plan value.",
        }).catch(() => {});
      }

      reverted += expiredKeys.length;
      console.log(`[LimitOverrideExpiryJob] Reverted ${expiredKeys.length} expired limit(s) for ${company.name || company._id}: ${expiredKeys.join(", ")}`);
    } catch (err) {
      console.error(`[LimitOverrideExpiryJob] Error for company ${company._id}:`, err.message);
    }
  }

  if (reverted) console.log(`[LimitOverrideExpiryJob] ✅ Done — reverted ${reverted} expired override(s).`);
  return reverted;
};

// ── Register hourly cron ──────────────────────────────────────────────────────
// "0 * * * *" = top of every hour
const startLimitOverrideExpiryJob = () => {
  cron.schedule("0 * * * *", async () => {
    try {
      await runLimitOverrideExpiry();
    } catch (err) {
      console.error("[LimitOverrideExpiryJob] Unhandled error:", err.message);
    }
  }, { timezone: "UTC" });

  console.log("[LimitOverrideExpiryJob] 🕐 Scheduled — fires hourly to revert expired limit overrides");
};

module.exports = { startLimitOverrideExpiryJob, runLimitOverrideExpiry };