// utils/companyCache.js
// ─────────────────────────────────────────────────────────────────────────────
// Cached lookup for a company's display name.
//
// Why this field specifically: `Company.name` is set once at company
// creation (superAdminController) and there is no rename endpoint anywhere
// in the app — so unlike subscriptionStatus/plan/isActive, it is effectively
// immutable in normal operation. That makes it safe to cache with a long TTL
// and NO explicit invalidation wiring: even in the rare case someone renames
// a company directly in the DB, the cache self-heals within TTL_SECONDS.
//
// This does NOT cache subscriptionStatus, plan, isActive, or anything else
// off the Company document — only the name. Don't extend this helper to
// return more fields without adding real invalidation for each one.
// ─────────────────────────────────────────────────────────────────────────────

const Company = require('../models/Company');
const { getOrSetCache } = require('./cacheService');

const TTL_SECONDS = 600; // 10 minutes
const cacheKey = (companyId) => `company:name:${companyId}`;

/**
 * @param {string|ObjectId} companyId
 * @returns {Promise<string>} the company's name, or 'Company' if not found.
 */
async function getCachedCompanyName(companyId) {
  const name = await getOrSetCache(cacheKey(companyId), TTL_SECONDS, async () => {
    const company = await Company.findById(companyId).select('name').lean();
    return company?.name || null;
  });
  return name || 'Company';
}

module.exports = { getCachedCompanyName };
