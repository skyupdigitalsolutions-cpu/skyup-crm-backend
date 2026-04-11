require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');

const { generalLimiter } = require('./middlewares/rateLimiter');
const connectDB           = require('./config/db');
const initSocket          = require('./socket/socketHandler');

// CRM Routes
const superAdminRoute = require('./routes/superAdminRoute');
const adminRoute      = require('./routes/adminRoute');
const authRoute       = require('./routes/authRoutes');
const leadRoute       = require('./routes/leadRoute');

// Chat Engine Routes
const chatRoutes = require('./routes/chatRoutes');

// Meta Routes
const metaWebhookRoute = require('./routes/metaWebhook');
const metaConfigRoute  = require('./routes/metaConfig');

// Twilio Routes
const twilioRoutes = require('./routes/twilio');

// Razorpay Routes
const razorpayRoute = require('./routes/razorpayRoute');

// Google Ads Routes
const googleAdsConfigRoute = require('./routes/googleAdsConfig');
const googleWebhookRoute   = require('./routes/googleWebhook');

// Website Contact Form Routes
const websiteConfigRoute  = require('./routes/websiteConfig');
const websiteWebhookRoute = require('./routes/websiteWebhook');

const app    = express();
const server = http.createServer(app);

// ── Static origins always allowed (CRM frontend + local dev) ─────────────────
const staticAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://skyup-crm-frontend.onrender.com",
];

// ── Shared dynamic origin checker — used by both Express CORS & Socket.IO ─────
// Checks the WebsiteConfig collection for any registered + active website.
// This allows websites connected via "Connect Website" on the Campaigns page
// to POST to /website-webhook AND call any API without CORS errors.
async function isDynamicOriginAllowed(origin) {
  try {
    const WebsiteConfig = require('./models/WebsiteConfig');
    const hostname = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const config = await WebsiteConfig.findOne({
      pageUrl:  { $regex: hostname, $options: "i" },
      isActive: true,
    });
    return !!config;
  } catch (e) {
    console.error("CORS DB check error:", e.message);
    return false; // fail closed on DB error — don't crash
  }
}

// ── Dynamic CORS options for Express routes ───────────────────────────────────
const corsOptions = {
  origin: async (origin, callback) => {
    // Allow no-origin requests (Postman, curl, server-to-server, mobile apps)
    if (!origin) return callback(null, true);

    // Always allow the CRM admin frontend origins
    if (staticAllowedOrigins.includes(origin)) return callback(null, true);

    // Dynamically check if this origin belongs to a registered website campaign
    const allowed = await isDynamicOriginAllowed(origin);
    if (allowed) {
      console.log(`✅ CORS allowed for registered website: ${origin}`);
      return callback(null, true);
    }

    console.warn(`⚠️  CORS blocked unknown origin: ${origin}`);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
};

// ── Socket.IO — same dynamic CORS logic ──────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: async (origin, callback) => {
      if (!origin) return callback(null, true);
      if (staticAllowedOrigins.includes(origin)) return callback(null, true);
      const allowed = await isDynamicOriginAllowed(origin);
      if (allowed) return callback(null, true);
      callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  },
});

// ── CRITICAL: Capture raw body for Meta HMAC signature verification ───────────
// MUST come before any other body parser.
// Without this, req.rawBody is undefined and metaSignature middleware
// will reject all Meta POST webhooks with 500.
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  })(req, res, next);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/plain", limit: "5mb" }));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Server is running'));

// ── Meta Webhook ONLY — BEFORE rate limiter & CORS ───────────────────────────
// Meta webhook calls are server-to-server (no browser Origin header), so CORS
// does not apply. Must be before rate limiter so Meta's IPs are never throttled.
// NOTE: /api/meta-config is the browser-facing API — it is mounted AFTER cors()
// so the frontend's preflight OPTIONS request gets the correct headers.
app.use('/meta', metaWebhookRoute);

// ── Website Webhook — BEFORE global CORS so browser preflight always succeeds ─
// The webhook_secret in the POST body is the real auth guard.
// CORS here is intentionally permissive because:
//   1. Any registered website needs to POST from its own domain.
//   2. We cannot do an async DB lookup inside OPTIONS (preflight) without a race.
//   3. The secret in the payload provides equivalent security to strict CORS.
app.use('/website-webhook', (req, res, next) => {
  const origin = req.headers.origin || '';

  res.header('Access-Control-Allow-Origin',  origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Vary', 'Origin');

  // Answer OPTIONS preflight immediately — no async DB call blocks it
  if (req.method === 'OPTIONS') return res.sendStatus(200);

  // Fire-and-forget DB log (does NOT delay the response to the website visitor)
  if (origin) {
    (async () => {
      try {
        const WebsiteConfig = require('./models/WebsiteConfig');
        const hostname = origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const config = await WebsiteConfig.findOne({
          pageUrl:  { $regex: hostname, $options: 'i' },
          isActive: true,
        });
        if (config) {
          console.log(`🌐 Website webhook from registered site: "${config.sourceName}" (${origin})`);
        } else {
          console.log(`⚠️  Website webhook from unregistered origin: ${origin} — secret will verify`);
        }
      } catch (e) {
        console.error('Website webhook DB log error:', e.message);
      }
    })();
  }

  next();
}, websiteWebhookRoute);

// ── Apply dynamic CORS to all remaining routes ────────────────────────────────
// Single call — replaces the broken double-cors() in the old broken version.
// Runs AFTER meta + website-webhook so those special routes are unaffected.
app.use(cors(corsOptions));

// ── Rate limiter ──────────────────────────────────────────────────────────────
app.use(generalLimiter);

// ── Meta Config API — browser-facing, needs CORS ─────────────────────────────
app.use('/api/meta-config', metaConfigRoute);

// ── CRM API Routes ────────────────────────────────────────────────────────────
app.use('/api/superadmin', superAdminRoute);
app.use('/api/admin',      adminRoute);
app.use('/api/auth',       authRoute);
app.use('/api/lead',       leadRoute);

// ── Twilio Routes ─────────────────────────────────────────────────────────────
app.use('/api/twilio', twilioRoutes);

// ── Razorpay Routes ───────────────────────────────────────────────────────────
app.use('/api/razorpay', razorpayRoute);

// ── Google Ads Routes ─────────────────────────────────────────────────────────
// googleWebhookRoute only handles POST /google-webhook — safe to mount on '/'
app.use('/api/google-ads-config', googleAdsConfigRoute);
app.use('/',                      googleWebhookRoute);

// ── Website Config API Routes ─────────────────────────────────────────────────
app.use('/api/website-config', websiteConfigRoute);

// ── Chat Routes ───────────────────────────────────────────────────────────────
app.use('/api/chat', chatRoutes);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
initSocket(io);

// ── Start Server ──────────────────────────────────────────────────────────────
connectDB().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});