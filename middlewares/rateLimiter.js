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
    reconnectStrategy: (retries) => {
      if (retries > 10) return new Error("Redis: too many reconnect attempts");
      return Math.min(retries * 100, 3000);
    },
  },
});

redisClient.connect().catch((err) => {
  console.error("❌ Redis connection failed:", err.message);
  console.warn("⚠️  Rate limiter will fall back to in-memory store.");
});

redisClient.on("connect",      () => console.log("✅ Redis connected"));
redisClient.on("error",        (err) => console.error("Redis error:", err.message));
redisClient.on("reconnecting", () => console.log("🔄 Redis reconnecting..."));

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
      p.startsWith("/website-webhook")
    );
  },
  message: {
    success: false,
    message: "Too many requests, please try again after 15 minutes.",
  },
});

// ── Auth rate limiter (login / register endpoints) ────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("auth"),
  keyGenerator: (req) => `auth:${ipKeyGenerator(req.ip)}`,
  message: {
    success: false,
    message: "Too many authentication attempts, please try again after 15 minutes.",
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
  generalLimiter,
  authLimiter,
  blacklistToken,
  isTokenBlacklisted,
  acquireWaDedupLock,
};