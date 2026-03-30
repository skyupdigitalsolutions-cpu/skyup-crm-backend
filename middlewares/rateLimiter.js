const rateLimit = require("express-rate-limit");

// ── Dummy pass-through middleware (no limiting) ────────────────────────────
const noLimit = (req, res, next) => next();

// General rate limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => true, // ✅ skip ALL requests — effectively disabled
});

// Auth rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => true, // ✅ skip ALL requests — effectively disabled
});

module.exports = { generalLimiter, authLimiter };