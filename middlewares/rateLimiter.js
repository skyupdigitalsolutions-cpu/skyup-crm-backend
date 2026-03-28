const rateLimit = require("express-rate-limit");

// General rate limiter — by IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: {
    message: "Too many requests, please try again after 15 minutes"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth rate limiter — by EMAIL
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    message: "Too many login attempts, please try again after 1 hour"
  },
  standardHeaders: true,
  legacyHeaders: false,

  // Fixed — IPv6 safe fallback
  keyGenerator: (req, res) => {
    const email = req.body?.email?.toLowerCase();
    if (email) return email;
    return rateLimit.ipKeyGenerator(req, res);
  },
});

module.exports = { generalLimiter, authLimiter };