// middlewares/rateLimiter.js
// ─────────────────────────────────────────────────────────────────────────────
// Single shared Redis client used by:
//   1. express-rate-limit  (generalLimiter, authLimiter)
//   2. WhatsApp dedup lock (wa:dedup:<waMessageId>)
//   3. JWT token blacklist (bl:<token>)
// ─────────────────────────────────────────────────────────────────────────────

const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { RedisStore }                = require("rate-limit-redis");
const { createClient }              = require("redis");

// ── Create & connect the shared Redis client ──────────────────────────────────
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    // Reconnect FOREVER with a capped backoff. Previously this returned an
    // Error once retries passed 10, which made node-redis PERMANENTLY give up.
    // A brief Redis blip then left the client "closed" for good — and because
    // the rate-limiter store threw "The client is closed" on every request, the
    // ENTIRE API returned 500s until a manual redeploy. Never stop retrying:
    // when Redis comes back the client reconnects on its own and limiting
    // resumes automatically. Backoff caps at 5s so we don't hammer the server.
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

redisClient.connect().catch((err) => {
  console.error("❌ Redis connection failed:", err.message);
  console.warn("⚠️  Rate limiter will fall back to in-memory store.");
});

redisClient.on("connect",      () => console.log("✅ Redis connected"));
redisClient.on("error",        (err) => console.error("Redis error:", err.message));
redisClient.on("reconnecting", () => console.log("🔄 Redis reconnecting..."));

// ── Resilience helpers ────────────────────────────────────────────────────────
// The rate limiters use Redis as their store. If Redis is unreachable we must
// DEGRADE (skip limiting), not take the whole API down. The Redis helper
// functions further below already fail open with `if (!redisClient.isReady)`;
// these two apply the same policy to the rate-limit middleware.

// True when the shared client is not currently usable (down / reconnecting).
const redisDown = () => !redisClient.isReady;

// Wrap a rate-limit middleware so that if its store errors (e.g. Redis drops
// mid-request), the request is ALLOWED through instead of 500ing. When the
// limit is genuinely exceeded, express-rate-limit sends its own 429 and never
// calls our callback, so real limiting still works — we only intercept errors.
function failOpen(limiter) {
  return (req, res, next) => {
    limiter(req, res, (err) => {
      if (err) {
        console.error(
          "⚠️  Rate limiter store error — failing open (request allowed):",
          err.message,
        );
        return next(); // serve the request rather than crash it
      }
      next();
    });
  };
}

// ── Each limiter gets its OWN store instance with a unique prefix ─────────────
function makeStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix: `rl:${prefix}:`,
  });
}

// ── General rate limiter (all authenticated routes) ───────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("general"),
  keyGenerator: (req) => {
    if (req.user?._id)       return `u:${req.user._id}`;
    if (req.admin?._id)      return `a:${req.admin._id}`;
    if (req.superAdmin?._id) return `s:${req.superAdmin._id}`;
    return ipKeyGenerator(req.ip);
  },
  skip: (req) => {
    // Redis unavailable → skip limiting entirely rather than let the store
    // throw "The client is closed" on every request (which 500'd the whole API).
    if (redisDown()) return true;
    const p = req.path || "";
    return (
      p.startsWith("/socket.io")       ||
      p.startsWith("/recordings")      ||
      p === "/"                        ||
      p === "/api/health"              ||
      p === "/api/attendance/ping"     ||
      p === "/api/attendance/my-today" ||
      p === "/api/lead/my-leads"       ||
      p.startsWith("/meta")            ||
      p.startsWith("/website-webhook") ||
      p.startsWith("/msg91-webhook")      // MSG91 sends from fixed IPs — must not be rate-limited
    );
  },
  message: {
    success: false,
    message: "Too many requests, please try again after 15 minutes.",
  },
});

// ── Auth rate limiter (login / register endpoints) ────────────────────────────
// PERF/PRODUCTION FIX: this was keyed by IP ALONE — `auth:${ip}` — with max: 30
// per 15 minutes shared by EVERY request from that IP. For a field team of
// 50-100 mobile agents this is a real outage waiting to happen: anyone behind
// the same office WiFi, or the same mobile carrier's NAT gateway (very common
// in India — many subscribers share one public IP), shares that same bucket.
// A normal morning login rush of even 10-15 agents from the same network
// exhausts it in minutes, and every agent after that gets "Too many
// authentication attempts" trying to log into THEIR OWN separate account.
//
// Fix: key by IP + the account identifier (email) being attempted, so the
// limit is effectively PER ACCOUNT — this still fully stops someone hammering
// one specific account (brute force), but two different employees logging
// into two different accounts from the same IP no longer share a bucket.
// A second, much higher, IP-only limiter behind it (ipFloodLimiter below)
// remains as a blunt anti-flood backstop against a single IP hitting the auth
// endpoints with an unreasonable number of DIFFERENT accounts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // per ACCOUNT, not per IP — was 30 shared across everyone on the IP
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("auth"),
  skip: () => redisDown(), // Redis down → don't block logins on it
  keyGenerator: (req) => {
    const identifier = (req.body?.email || "").toLowerCase().trim();
    return identifier
      ? `auth:${ipKeyGenerator(req.ip)}:${identifier}`
      : `auth:${ipKeyGenerator(req.ip)}`; // no identifier in body — fall back to IP-only
  },
  message: {
    success: false,
    message: "Too many authentication attempts, please try again after 15 minutes.",
  },
});

// Blunt per-IP backstop so one IP can't hammer many DIFFERENT accounts to get
// around the per-account limiter above. Set high enough that a legitimate
// 50-100 person office/field team logging in from a shared network in a
// short window is never affected — this exists only to catch genuine abuse.
const ipFloodLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("auth-ip"),
  skip: () => redisDown(),
  keyGenerator: (req) => `authip:${ipKeyGenerator(req.ip)}`,
  message: {
    success: false,
    message: "Too many authentication attempts from this network, please try again after 15 minutes.",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT Token Blacklist helpers
// Used by logout endpoints to invalidate tokens before their natural expiry.
// Keys are stored as  bl:<token>  with TTL = remaining token lifetime.
// isTokenBlacklisted() is called inside authMiddleware before accepting a JWT.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a JWT to the blacklist.
 * @param {string} token        - The raw JWT string
 * @param {number} expirySeconds - Seconds until the token would naturally expire
 */
async function blacklistToken(token, expirySeconds) {
  try {
    if (!redisClient.isReady) return; // Redis down — skip silently
    await redisClient.set(`bl:${token}`, "1", { EX: Math.max(1, expirySeconds) });
    console.log(`🚫 Token blacklisted (TTL: ${expirySeconds}s)`);
  } catch (err) {
    console.error("blacklistToken error:", err.message);
  }
}

/**
 * Check whether a JWT has been blacklisted.
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function isTokenBlacklisted(token) {
  try {
    if (!redisClient.isReady) return false; // Redis down — fail open
    const val = await redisClient.get(`bl:${token}`);
    return val !== null;
  } catch (err) {
    console.error("isTokenBlacklisted error:", err.message);
    return false; // fail open so a Redis hiccup doesn't lock out everyone
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp message dedup lock helper
// Prevents race-condition duplicates when Meta fires the same webhook twice
// within milliseconds. Uses SET NX (set-if-not-exists) as an atomic lock.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to acquire a dedup lock for a WhatsApp message ID.
 * Returns true  → this process should handle the message (lock acquired).
 * Returns false → another process already claimed it (skip).
 * @param {string} waMessageId
 * @returns {Promise<boolean>}
 */
async function acquireWaDedupLock(waMessageId) {
  try {
    if (!redisClient.isReady) return true; // Redis down — fall through to DB check
    const result = await redisClient.set(
      `wa:dedup:${waMessageId}`,
      "1",
      { NX: true, EX: 120 } // lock expires in 2 min (well beyond any retry window)
    );
    return result === "OK"; // "OK" = lock acquired; null = already exists
  } catch (err) {
    console.error("acquireWaDedupLock error:", err.message);
    return true; // fail open — DB check below will catch true duplicates
  }
}

module.exports = {
  redisClient,
  // Wrapped so a Redis outage degrades to "no limiting" instead of a 500 storm.
  generalLimiter: failOpen(generalLimiter),
  authLimiter:    failOpen(authLimiter),
  ipFloodLimiter: failOpen(ipFloodLimiter),
  blacklistToken,
  isTokenBlacklisted,
  acquireWaDedupLock,
};