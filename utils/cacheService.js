// utils/cacheService.js
// ─────────────────────────────────────────────────────────────────────────────
// Generic Redis read-through cache helper.
//
// This is the SAME pattern already proven in services/entitlementService.js
// (entitlement cache) — pulled out into a reusable module so any controller/
// service can cache a DB round trip in three lines instead of hand-rolling
// get/set/fail-open logic every time:
//
//   const { getOrSetCache, invalidateCache } = require('../utils/cacheService');
//
//   const data = await getOrSetCache(`myFeature:${id}`, 300, async () => {
//     return SomeModel.findById(id).lean();   // only runs on cache miss
//   });
//
//   // wherever that data is mutated:
//   await invalidateCache(`myFeature:${id}`);
//
// Design choices (deliberately matching entitlementService's pattern):
//   • Fails OPEN — if Redis is down/unreachable, we silently fall through to
//     the DB fetch instead of erroring. A Redis outage must never take down
//     a feature that used to work without Redis.
//   • Values are JSON-serialized. Don't cache Mongoose documents directly —
//     pass .lean() query results or plain objects.
//   • Caller owns invalidation. This module does not guess when to bust a
//     key; wire invalidateCache()/invalidateCachePattern() into whatever
//     write path changes that data.
//
// ⚠️  WHAT NOT TO CACHE WITH THIS (use judgement per call site):
//   • Anything gating billing/subscription access (subscriptionStatus,
//     isActive, plan limits) — a stale "active" read could let an expired
//     account keep using paid features past cancellation. Entitlements
//     already have their own dedicated short-TTL cache with explicit
//     invalidation call sites — extend THAT instead of this for billing data.
//   • High-churn transactional data (live lead lists/counts, in-progress
//     call state) where staleness of even a few seconds causes visibly wrong
//     UI (e.g. an agent assigned a lead someone else already claimed).
//   • Anything used to make a security/authorization decision on its own
//     (roles, permissions) — auth already has its own short-TTL in-process
//     cache in authMiddleware.js; don't add a second, differently-timed
//     cache layer for the same decision.
// ─────────────────────────────────────────────────────────────────────────────

const { redisClient } = require('../middlewares/rateLimiter');

/**
 * Read-through cache: returns the cached value if present, otherwise calls
 * fetchFn(), caches its result, and returns it.
 *
 * @param {string}   key         - Redis key. Namespace it, e.g. `company:name:${id}`.
 * @param {number}   ttlSeconds  - How long to cache the result for.
 * @param {Function} fetchFn     - async () => value. Only called on a cache miss.
 * @returns {Promise<*>} the cached or freshly-fetched value.
 */
async function getOrSetCache(key, ttlSeconds, fetchFn) {
  try {
    if (redisClient.isReady) {
      const cached = await redisClient.get(key);
      if (cached !== null) {
        try {
          return JSON.parse(cached);
        } catch {
          // Corrupt cache entry — fall through and refetch/overwrite it.
        }
      }
    }
  } catch (err) {
    console.error(`[cache] read failed for "${key}":`, err.message);
    // fall through to DB fetch
  }

  const fresh = await fetchFn();

  try {
    if (redisClient.isReady && fresh !== undefined) {
      await redisClient.set(key, JSON.stringify(fresh), { EX: ttlSeconds });
    }
  } catch (err) {
    console.error(`[cache] write failed for "${key}":`, err.message);
    // non-fatal — caller still gets the fresh value
  }

  return fresh;
}

/**
 * Deletes a single cache key. Call this from any write path that changes
 * data covered by a getOrSetCache() call using the same key.
 * @param {string} key
 */
async function invalidateCache(key) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.del(key);
  } catch (err) {
    console.error(`[cache] invalidate failed for "${key}":`, err.message);
  }
}

/**
 * Deletes all cache keys matching a prefix, e.g. invalidateCachePattern('leads:company:123:')
 * Uses SCAN (not KEYS) so it never blocks Redis on a large keyspace.
 * @param {string} prefix
 */
async function invalidateCachePattern(prefix) {
  try {
    if (!redisClient.isReady) return;
    const keysToDelete = [];
    for await (const key of redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      keysToDelete.push(key);
    }
    if (keysToDelete.length) await redisClient.del(keysToDelete);
  } catch (err) {
    console.error(`[cache] pattern invalidate failed for "${prefix}*":`, err.message);
  }
}

module.exports = { getOrSetCache, invalidateCache, invalidateCachePattern };
