// utils/planPricing.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for plan PRICING at checkout time.
//
// Both razorpayController and cartController used to carry their own hardcoded
// `PLANS` maps (₹999 / ₹2499 / ₹5999). Those numbers had drifted away from the
// prices the customer actually SEES on the upgrade page (driven by PlanConfig /
// UpgradePlan defaults: ₹2999 / ₹6999 / ₹14999). The result: a customer was
// shown one price and charged a different, lower one.
//
// resolvePlanPricing() now reads the price from PlanConfig (the same record the
// upgrade page renders) and falls back to the canonical UI defaults when no DB
// row exists — so the amount charged always matches the amount displayed.
//
// PRICE SEMANTICS (kept consistent everywhere):
//   • price.monthly = amount charged for ONE month.
//   • price.yearly  = amount charged for ONE year (the full annual total — NOT
//     a per-month rate). The UI shows yearly/12 as the "/mo" figure.
// ─────────────────────────────────────────────────────────────────────────────

const PlanConfig = require("../models/PlanConfig");

// Canonical fallback prices + names. These are LAST-RESORT defaults, used only
// when no PlanConfig row exists for a plan (e.g. a fresh database before the
// developer has saved prices). PlanConfig always wins when present.
//
// Each price can also be overridden via environment variables without touching
// code, e.g. PLAN_BASIC_MONTHLY=3499 PLAN_BASIC_YEARLY=34990. This keeps the
// values out of source for anyone who prefers env-driven config.
const numEnv = (key, def) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const PLAN_DEFAULTS = {
  basic: {
    dbPlan: "basic", name: process.env.PLAN_BASIC_NAME || "Basic",
    monthly: numEnv("PLAN_BASIC_MONTHLY", 2999),  yearly: numEnv("PLAN_BASIC_YEARLY", 29990),
  },
  pro: {
    dbPlan: "pro", name: process.env.PLAN_PRO_NAME || "Pro",
    monthly: numEnv("PLAN_PRO_MONTHLY", 6999),  yearly: numEnv("PLAN_PRO_YEARLY", 69990),
  },
  advance: {
    dbPlan: "advance", name: process.env.PLAN_ADVANCE_NAME || "Advance",
    monthly: numEnv("PLAN_ADVANCE_MONTHLY", 14999), yearly: numEnv("PLAN_ADVANCE_YEARLY", 149990),
  },
  enterprise: {
    dbPlan: "enterprise", name: process.env.PLAN_ENTERPRISE_NAME || "Enterprise",
    monthly: 0, yearly: 0, custom: true,
  },
};

// Legacy / frontend plan-id aliases → canonical plan key.
// The upgrade page historically posted starter/growth for basic/pro, so accept
// both spellings and normalise to the canonical key.
const PLAN_ALIASES = {
  starter: "basic",
  growth:  "pro",
  basic:   "basic",
  pro:     "pro",
  advance: "advance",
  enterprise: "enterprise",
};

function normalizePlanKey(planId) {
  if (!planId) return null;
  const key = String(planId).trim().toLowerCase();
  return PLAN_ALIASES[key] || (PLAN_DEFAULTS[key] ? key : null);
}

/**
 * Resolve the authoritative price + display name for a plan at checkout.
 *
 * @param {string} planId   — plan id from the client (basic/pro/advance or
 *                            legacy starter/growth).
 * @param {"monthly"|"yearly"} billing
 * @returns {Promise<{
 *   planKey: string, dbPlan: string, name: string,
 *   billing: string, price: number, custom: boolean
 * } | null>}  null when the plan id is unknown.
 */
async function resolvePlanPricing(planId, billing = "monthly") {
  const planKey = normalizePlanKey(planId);
  if (!planKey) return null;

  const cycle    = billing === "yearly" ? "yearly" : "monthly";
  const fallback = PLAN_DEFAULTS[planKey];

  let name    = fallback.name;
  let monthly = fallback.monthly;
  let yearly  = fallback.yearly;
  let custom  = !!fallback.custom;

  // Prefer the live PlanConfig record — same source the upgrade page renders.
  try {
    const cfg = await PlanConfig.findOne({ planKey }).lean();
    if (cfg) {
      name    = cfg.name || name;
      custom  = cfg.custom ?? custom;
      // Only override a price when a non-null value is configured; a 0 from the
      // DB is treated as "not set" so we never silently charge ₹0 for a paid plan.
      if (cfg.price?.monthly) monthly = Number(cfg.price.monthly);
      if (cfg.price?.yearly)  yearly  = Number(cfg.price.yearly);
    }
  } catch (_) {
    // DB unavailable — use canonical defaults silently.
  }

  const price = cycle === "yearly" ? yearly : monthly;

  return {
    planKey,
    dbPlan: fallback.dbPlan,
    name,
    billing: cycle,
    price: Math.round(Number(price) || 0),
    custom,
  };
}

module.exports = {
  resolvePlanPricing,
  normalizePlanKey,
  PLAN_DEFAULTS,
  PLAN_ALIASES,
};
