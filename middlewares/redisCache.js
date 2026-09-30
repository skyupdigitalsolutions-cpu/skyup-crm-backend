// middlewares/redisCache.js
// ─────────────────────────────────────────────────────────────────────────────
// Response cache for GET endpoints, backed by the shared Redis client.
// Fails OPEN: if Redis is down, every request simply skips the cache.
//
// Exports (all usable as plain middleware OR as factories):
//   withCache            → router.get('/x', auth, withCache, handler)
//   withCache(60)        → custom TTL in seconds
//   cacheRead / cacheWrite (aliases kept for older route files)
//   invalidateCache      → on write routes; after a successful non-GET
//                          response, clears that company's cached responses
//   invalidateCache('lead') → also clears keys matching a pattern right away
//   prewarmCache()       → safe no-op hook for startup
// Keys are scoped per company AND per user, so users never see each other's data.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let redisClient = null;
try {
  ({ redisClient } = require('./rateLimiter'));
} catch (e) {
  console.warn('[redisCache] rateLimiter/redisClient not available — caching disabled');
}

const TTL_RULES = [
  { pattern: /\/dashboard-stats/, ttl: 60 },
  { pattern: /\/marketing-dashboard/, ttl: 60 },
  { pattern: /\/admin\/company\/leads/, ttl: 30 },
  { pattern: /\/lead\/admin\/all/, ttl: 30 },
  { pattern: /\/lead\/my-leads/, ttl: 30 },
  { pattern: /\/lead\/by-campaign/, ttl: 60 },
  { pattern: /\/lead\/distinct-campaigns/, ttl: 120 },
  { pattern: /\/admin\/company\/users/, ttl: 120 },
  { pattern: /\/admin\/company\/me/, ttl: 120 },
  { pattern: /\/admin\/company\/brand/, ttl: 300 },
  { pattern: /\/company\/msg91/, ttl: 300 },
  { pattern: /\/company\/telegram/, ttl: 120 },
  { pattern: /\/company\/clock-in/, ttl: 120 },
  { pattern: /\/company\/attendance/, ttl: 120 },
  { pattern: /\/attendance\/my-today/, ttl: 20 },
  { pattern: /\/attendance\/admin/, ttl: 30 },
  { pattern: /\/call-logs/, ttl: 30 },
  { pattern: /\/reports\//, ttl: 300 },
  { pattern: /\/project/, ttl: 60 },
  { pattern: /\/follow-up-alerts/, ttl: 30 },
  { pattern: /\/pending-notifications/, ttl: 20 },
];

const NO_CACHE_PATTERNS = [
  /\/login/, /\/logout/, /\/register/,
  /\/whatsapp\/conversations/, /\/chat/,
  /\/unread-counts/, /\/socket/,
  /\/test$/, /\/health/,
  /\/razorpay/, /\/subscription/,
];

const DEFAULT_TTL = 30;
const PREFIX = 'cache:';

// ── helpers ──────────────────────────────────────────────────────────────────
const redisReady = () =>
  !!redisClient && (redisClient.isReady === true || redisClient.status === 'ready');

const isReq = (a) => a && typeof a === 'object' && typeof a.method === 'string' && a.headers;

const getTTL = (url) => {
  const rule = TTL_RULES.find((r) => r.pattern.test(url));
  return rule ? rule.ttl : DEFAULT_TTL;
};

const companyOf = (req) =>
  String(
    req.user?.companyId || req.user?.company?._id || req.user?.company ||
    req.admin?.company?._id || req.admin?.company || req.companyId || 'global'
  );

const userOf = (req) =>
  String(req.user?._id || req.user?.id || req.admin?._id || req.admin?.id || 'anon');

const buildKey = (req) => {
  const hash = crypto.createHash('md5').update(req.originalUrl).digest('hex');
  return `${PREFIX}${companyOf(req)}:${userOf(req)}:${hash}`;
};

async function writeKey(key, data, ttl = DEFAULT_TTL) {
  if (!redisReady()) return;
  const val = JSON.stringify(data);
  if (typeof redisClient.setEx === 'function') await redisClient.setEx(key, ttl, val); // node-redis v4
  else await redisClient.setex(key, ttl, val);                                         // ioredis
}

async function deleteByPattern(pattern) {
  if (!redisReady()) return 0;
  let deleted = 0;
  // SCAN instead of KEYS so large keyspaces never block Redis.
  if (typeof redisClient.scanIterator === 'function') {
    for await (const k of redisClient.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      const keys = Array.isArray(k) ? k : [k];
      for (const key of keys) { await redisClient.del(key); deleted++; }
    }
  } else {
    const keys = await redisClient.keys(pattern);
    await Promise.all(keys.map((key) => redisClient.del(key)));
    deleted = keys.length;
  }
  return deleted;
}

// ── read-through cache middleware ────────────────────────────────────────────
async function readHandler(req, res, next, ttlOverride) {
  try {
    if (req.method !== 'GET' || !redisReady()) return next();
    const url = req.originalUrl;
    if (NO_CACHE_PATTERNS.some((p) => p.test(url))) return next();

    const ttl = ttlOverride || getTTL(url);
    const key = buildKey(req);
    const hit = await redisClient.get(key);
    if (hit) {
      res.set('X-Cache', 'HIT');
      return res.status(200).json(JSON.parse(hit));
    }

    res.set('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        writeKey(key, body, ttl).catch((e) => console.error('[redisCache] write', e.message));
      }
      return originalJson(body);
    };
  } catch (e) {
    console.error('[redisCache] read', e.message);
  }
  next();
}

function invalidateMiddleware(req, res, next) {
  res.on('finish', () => {
    if (req.method !== 'GET' && res.statusCode < 400) {
      deleteByPattern(`${PREFIX}${companyOf(req)}:*`).catch((e) =>
        console.error('[redisCache] invalidate', e.message)
      );
    }
  });
  next();
}

// Works both as plain middleware and as a factory.
function withCache(...args) {
  if (isReq(args[0]) && typeof args[2] === 'function') return readHandler(args[0], args[1], args[2]);
  const ttl = args.find((a) => typeof a === 'number') || (args[0] && args[0].ttl) || undefined;
  return (req, res, next) => readHandler(req, res, next, ttl);
}

function invalidateCache(...args) {
  if (isReq(args[0]) && typeof args[2] === 'function') return invalidateMiddleware(args[0], args[1], args[2]);
  const pattern = args[0];
  if (typeof pattern === 'string' && pattern) {
    const pat = pattern.includes('*') ? pattern : `${PREFIX}*${pattern}*`;
    deleteByPattern(pat).catch(() => {});
  }
  return invalidateMiddleware;
}

async function prewarmCache() {
  if (redisReady()) console.log('[redisCache] ready');
}

module.exports = {
  withCache,
  cacheRead: withCache,
  cacheWrite: withCache,
  invalidateCache,
  prewarmCache,
  deleteByPattern,
  TTL_RULES,
  NO_CACHE_PATTERNS,
};
