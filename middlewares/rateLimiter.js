// express-rate-limit v8 — IPv6-safe key generation REQUIRED.
// Without ipKeyGenerator(), v8 throws ERR_ERL_KEY_GEN_IPV6 on boot
// because raw req.ip allows IPv6 users to bypass limits via address variation.
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// ─────────────────────────────────────────────────────────────────────────────
// General rate limiter — applied globally in server.js
//
// Strategy:
//  • Per-user bucket if logged in (req.user / req.admin / req.superAdmin),
//    else fall back to ipKeyGenerator(req.ip) for IPv6-safe IP key.
//  • Polling / health-check / streaming endpoints skip karo — warna ek user
//    hi 5 min me limit thok deta hai.
//  • Limit raised from 100 → 1000 per 15 min — active CRM ke liye realistic.
// ─────────────────────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,                // 1000 requests per window per user/IP
  standardHeaders: true,
  legacyHeaders: false,

  // Per-user > per-IP. Office ke 5 users ek hi NAT IP ke peeche baithe ho
  // toh per-IP me sab block ho jaate hain. Logged-in user ka unique id use karo.
  keyGenerator: (req, res) => {
    if (req.user?._id)       return `u:${req.user._id}`;
    if (req.admin?._id)      return `a:${req.admin._id}`;
    if (req.superAdmin?._id) return `s:${req.superAdmin._id}`;
    // ipKeyGenerator handles IPv6 properly (collapses to /56 subnet)
    return ipKeyGenerator(req.ip);
  },

  // High-frequency polling endpoints — count me na lo
  skip: (req) => {
    const p = req.path || "";
    return (
      p.startsWith("/socket.io")           ||  // socket polling fallback
      p.startsWith("/recordings")          ||  // static audio
      p === "/"                            ||
      p === "/api/health"                  ||  // mobile connectivity check
      p === "/api/attendance/ping"         ||  // har few sec hit hota hai
      p === "/api/attendance/my-today"     ||  // mobile dashboard refresh
      p === "/api/lead/my-leads"           ||  // mobile leads list refresh
      p.startsWith("/meta")                ||  // FB webhooks (external)
      p.startsWith("/website-webhook")          // website webhooks (external)
    );
  },

  message: {
    success: false,
    message: "Too many requests, please try again after 15 minutes.",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth rate limiter — stricter, applied to login/register routes only
//
// Per-IP because logged-out user ka koi id nahi hota — but use ipKeyGenerator
// to stay IPv6-safe.
// 20 → 30 to allow a couple of typo retries before locking out.
// ─────────────────────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: "Too many authentication attempts, please try again after 15 minutes.",
  },
});

module.exports = { generalLimiter, authLimiter };