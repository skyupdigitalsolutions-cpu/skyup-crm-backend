const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { RedisStore }                = require("rate-limit-redis");
const { createClient }              = require("redis");

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

redisClient.on("connect",      () => console.log("✅ Redis connected (rate-limiter store)"));
redisClient.on("error",        (err) => console.error("Redis error:", err.message));
redisClient.on("reconnecting", () => console.log("🔄 Redis reconnecting..."));

// ✅ Each limiter gets its OWN store instance with a unique prefix
function makeStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix: `rl:${prefix}:`,
  });
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("general"),   // ✅ own store
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("auth"),      // ✅ own store, unique prefix
  keyGenerator: (req) => `auth:${ipKeyGenerator(req.ip)}`,
  message: {
    success: false,
    message: "Too many authentication attempts, please try again after 15 minutes.",
  },
});

module.exports = { generalLimiter, authLimiter };