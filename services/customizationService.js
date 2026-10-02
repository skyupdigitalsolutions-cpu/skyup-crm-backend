// services/customizationService.js
// ─────────────────────────────────────────────────────────────────────────────
// I/O layer for per-company customization (Mongo + cache). All logic about
// WHAT a valid customization is lives in utils/customizationResolver.js.
//
//   getCustomization(companyId)                → resolved config (never throws)
//   updateSection(companyId, section, value, actor) → saves + invalidates caches
//   resetSection(companyId, section, actor)    → back to CRM defaults
//
// Caching: a tiny in-process map (5s) in front of Redis (60s). Every write
// invalidates both, plus the entitlement cache (module toggles feed into
// entitlements). Reads fail OPEN to defaults so a DB/Redis hiccup can never
// change how the CRM behaves.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const mongoose = require("mongoose");
const CompanyCustomization = require("../models/CompanyCustomization");
const R = require("../utils/customizationResolver");

const REDIS_TTL_SECONDS = 60;
const LOCAL_TTL_MS      = 30 * 1000;  // PERF: was 5s → a DB read (~150 ms) every 5s per company when Redis is off; saves clear it instantly
const cacheKey = (id) => `cust:${id}`;
const _local = new Map(); // id → { value, expiresAt }

function redis() {
  try {
    const { redisClient } = require("../middlewares/rateLimiter");
    return redisClient && redisClient.isReady ? redisClient : null;
  } catch (_) {
    return null;
  }
}

function idOf(companyId) {
  if (!companyId) return null;
  if (typeof companyId === "object" && companyId._id) return String(companyId._id);
  return String(companyId);
}

async function loadStored(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return CompanyCustomization.findOne({ company: id }).select("-history").lean();
}

/**
 * Resolved customization for a company (defaults ⊕ stored overrides).
 * Never throws — on any error returns the CRM defaults.
 */
async function getCustomization(companyId) {
  const id = idOf(companyId);
  if (!id) return R.resolveCustomization({});

  const hit = _local.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let resolved = null;
  const client = redis();
  if (client) {
    try {
      const raw = await client.get(cacheKey(id));
      if (raw) resolved = JSON.parse(raw);
    } catch (_) { /* fall through */ }
  }

  if (!resolved) {
    try {
      const stored = await loadStored(id);
      resolved = R.resolveCustomization(stored || {});
    } catch (err) {
      console.error(`[customization] load failed for ${id}:`, err.message);
      return R.resolveCustomization({});
    }
    if (client) {
      client.set(cacheKey(id), JSON.stringify(resolved), { EX: REDIS_TTL_SECONDS }).catch(() => {});
    }
  }

  _local.set(id, { value: resolved, expiresAt: Date.now() + LOCAL_TTL_MS });
  _lastKnown.set(id, resolved);
  if (_local.size > 5000) _local.clear(); // crude bound
  if (_lastKnown.size > 5000) _lastKnown.clear();
  return resolved;
}

// Last successfully resolved value per company (no TTL) — for SYNC callers.
const _lastKnown = new Map();

/**
 * Synchronous best-effort read for code paths that can't await (promise-chain
 * route handlers, aggregation builders). Returns the last resolved config for
 * the company — or the CRM defaults the very first time — and refreshes it in
 * the background. Prefer getCustomization() wherever you can await.
 */
function peekCustomization(companyId) {
  const id = idOf(companyId);
  if (!id) return R.resolveCustomization({});
  const known = _lastKnown.get(id);
  const hit = _local.get(id);
  if (!hit || hit.expiresAt <= Date.now()) {
    getCustomization(id).catch(() => {});
  }
  return known || R.resolveCustomization({});
}

/** Fetch customization for many companies at once (jobs). Returns Map<id, resolved>. */
async function getCustomizationMany(companyIds) {
  const ids = [...new Set((companyIds || []).map(idOf).filter(Boolean))];
  const out = new Map();
  await Promise.all(ids.map(async (id) => out.set(id, await getCustomization(id))));
  return out;
}

async function invalidateCustomization(companyId) {
  const id = idOf(companyId);
  if (!id) return;
  _local.delete(id);
  _lastKnown.delete(id);
  const client = redis();
  if (client) await client.del(cacheKey(id)).catch(() => {});
  // Module toggles are merged into entitlements — refresh those too.
  try {
    const { invalidateEntitlementCache } = require("./entitlementService");
    await invalidateEntitlementCache(id);
  } catch (_) { /* best effort */ }
}

function actorFrom(actor) {
  return {
    actorId:   actor?.id && mongoose.Types.ObjectId.isValid(String(actor.id)) ? actor.id : null,
    actorRole: actor?.role || "",
    actorName: actor?.name || "",
  };
}

/**
 * Validate + save ONE section. Returns the freshly resolved customization.
 * Throws CustomizationError (status 400) for invalid input.
 */
async function updateSection(companyId, section, value, actor) {
  const id = idOf(companyId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) throw new R.CustomizationError("Invalid company.");

  const current = await getCustomizationFresh(id);
  const clean = R.validateSection(section, value, current);

  await CompanyCustomization.findOneAndUpdate(
    { company: id },
    {
      $set: { [section]: clean },
      $inc: { version: 1 },
      $push: { history: { $each: [{ section, action: "update", ...actorFrom(actor), at: new Date() }], $position: 0, $slice: 100 } },
      $setOnInsert: { company: id },
    },
    { upsert: true, new: true }
  );

  await invalidateCustomization(id);
  return getCustomizationFresh(id);
}

/** Reset one section (or "all") back to the CRM defaults. */
async function resetSection(companyId, section, actor) {
  const id = idOf(companyId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) throw new R.CustomizationError("Invalid company.");
  if (section !== "all" && !R.SECTIONS.includes(section)) throw new R.CustomizationError(`Unknown section "${section}".`);

  const unset = {};
  for (const s of section === "all" ? R.SECTIONS : [section]) unset[s] = "";

  await CompanyCustomization.findOneAndUpdate(
    { company: id },
    {
      $unset: unset,
      $inc: { version: 1 },
      $push: { history: { $each: [{ section, action: "reset", ...actorFrom(actor), at: new Date() }], $position: 0, $slice: 100 } },
      $setOnInsert: { company: id },
    },
    { upsert: true, new: true }
  );
  await invalidateCustomization(id);
  return getCustomizationFresh(id);
}

async function getCustomizationFresh(companyId) {
  const id = idOf(companyId);
  _local.delete(id);
  const stored = await loadStored(id);
  return R.resolveCustomization(stored || {});
}

async function getHistory(companyId, limit = 50) {
  const id = idOf(companyId);
  if (!mongoose.Types.ObjectId.isValid(id)) return [];
  const doc = await CompanyCustomization.findOne({ company: id }).select("history").lean();
  return (doc?.history || []).slice(0, limit);
}

/**
 * Merge company module toggles into an entitlements object (mutates + returns).
 *   plan-gated module → ent[key] = ent[key] AND company toggle
 *   nav-only module   → ent[key] = developer toggle (default true) AND company toggle
 */
function applyModulesToEntitlements(ent, cust, devToggles = {}) {
  if (!ent || !cust) return ent;
  for (const m of R.MODULE_CATALOG) {
    const companyOn = R.isModuleOn(cust, m.key);
    if (m.navOnly) {
      const dev = Object.prototype.hasOwnProperty.call(devToggles, m.key) ? !!devToggles[m.key] : true;
      ent[m.key] = dev && companyOn;
    } else if (Object.prototype.hasOwnProperty.call(ent, m.key)) {
      ent[m.key] = !!ent[m.key] && companyOn;
    } else {
      ent[m.key] = false;
    }
  }
  return ent;
}

/**
 * The company's SMS greeting text (Customize CRM → Messaging), with
 * {{name}} / {{company}} filled. Used for SMS history logs and as the
 * "use default greeting" text — replaces the old Skyup-specific copy.
 */
async function renderSmsGreeting(companyId, leadName) {
  try {
    const cust = await getCustomization(companyId);
    const Company = require("../models/Company");
    const co = await Company.findById(idOf(companyId)).select("name brandName headerName").lean();
    const companyName = cust.general?.appName || co?.brandName || co?.headerName || co?.name || "our team";
    return R.fillTemplate(cust.messaging.smsGreeting, { name: leadName || "Sir/Madam", company: companyName });
  } catch (_) {
    return `Hi ${leadName || "Sir/Madam"}, thank you for contacting us! Our team will connect with you shortly.`;
  }
}

/** Display name for a company: Customize CRM app name → brand → header → name. */
async function companyDisplayName(companyId) {
  try {
    const cust = await getCustomization(companyId);
    const Company = require("../models/Company");
    const co = await Company.findById(idOf(companyId)).select("name brandName headerName").lean();
    return cust.general?.appName || co?.brandName || co?.headerName || co?.name || "CRM";
  } catch (_) {
    return "CRM";
  }
}

module.exports = {
  renderSmsGreeting,
  companyDisplayName,
  getCustomization,
  peekCustomization,
  getCustomizationMany,
  getCustomizationFresh,
  invalidateCustomization,
  updateSection,
  resetSection,
  getHistory,
  applyModulesToEntitlements,
  // re-export helpers so callers need a single require
  ...R,
};
