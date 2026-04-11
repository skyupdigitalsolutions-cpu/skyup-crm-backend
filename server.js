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

// ── Dynamic CORS — checks WebsiteConfig collection for registered websites ────
const corsOptions = {
  origin: async (origin, callback) => {
    // Allow requests with no origin (Postman, server-to-server, curl, mobile)
    if (!origin) return callback(null, true);

    // Always allow static CRM origins
    if (staticAllowedOrigins.includes(origin)) return callback(null, true);

    // Dynamically check if origin matches any active registered website
    try {
      const WebsiteConfig = require('./models/WebsiteConfig');
      const hostname = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const config = await WebsiteConfig.findOne({
        pageUrl:  { $regex: hostname, $options: "i" },
        isActive: true,
      });
      if (config) {
        console.log(`✅ CORS allowed for registered website: ${origin}`);
        return callback(null, true);
      }
    } catch (e) {
      console.error("CORS DB check error:", e.message);
      // On DB error fall through — don't crash the server
    }

    console.warn(`⚠️  CORS blocked unknown origin: ${origin}`);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
};

// ── Socket.IO with same dynamic CORS ─────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: async (origin, callback) => {
      if (!origin) return callback(null, true);
      if (staticAllowedOrigins.includes(origin)) return callback(null, true);
      try {
        const WebsiteConfig = require('./models/WebsiteConfig');
        const hostname = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
        const config = await WebsiteConfig.findOne({
          pageUrl:  { $regex: hostname, $options: "i" },
          isActive: true,
        });
        if (config) return callback(null, true);
      } catch (e) { /* fall through */ }
      callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  },
});

// ── CRITICAL: Capture raw body for Meta HMAC signature verification ───────────
// This MUST come before any other body parser
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  })(req, res, next);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/plain", limit: "5mb" }));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Server is running'));

// ── Meta Routes — BEFORE rate limiter so Meta webhook IPs are never throttled ─
app.use('/meta',            metaWebhookRoute);
app.use('/api/meta-config', metaConfigRoute);

// ── Website Webhook — BEFORE global CORS so preflight is never blocked ────────
// webhook_secret is the real auth guard; CORS is just browser-level protection.
// The OPTIONS preflight is answered immediately (no async DB call) so the
// browser never sees a missing Access-Control-Allow-Origin header.
app.use('/website-webhook', (req, res, next) => {
  const origin = req.headers.origin || '';

  // Set permissive CORS headers for every request on this path
  res.header('Access-Control-Allow-Origin',  origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Vary', 'Origin');

  // ✅ Respond to preflight immediately — no async work needed here
  if (req.method === 'OPTIONS') return res.sendStatus(200);

  // Fire-and-forget DB logging (does NOT block the request)
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

// ── Apply dynamic CORS to all remaining Express routes ────────────────────────
app.use(cors(corsOptions));

// ── Rate limiter for all other routes ─────────────────────────────────────────
app.use(generalLimiter);

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