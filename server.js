require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const path         = require('path');

const { generalLimiter } = require('./middlewares/rateLimiter');
const connectDB           = require('./config/db');
const initSocket          = require('./socket/socketHandler');

// ── CRM Routes ────────────────────────────────────────────────────────────────
const superAdminRoute   = require('./routes/superAdminRoute');
const developerRoutes   = require('./routes/developerRoutes');
const adminRoute        = require('./routes/adminRoute');
const authRoute         = require('./routes/authRoutes');
const leadRoute         = require('./routes/leadRoute');

// ── Privacy & Subscription Routes ────────────────────────────────────────────
const privacyRoute      = require('./routes/privacyRoute');
const subscriptionRoute = require('./routes/subscriptionRoute');

// ── Chat Engine Routes ─────────────────────────────────────────────────────────
const chatRoutes = require('./routes/chatRoutes');

// ── Meta Routes ───────────────────────────────────────────────────────────────
const metaWebhookRoute = require('./routes/metaWebhook');
const metaConfigRoute  = require('./routes/metaConfig');

// ── Razorpay Routes ───────────────────────────────────────────────────────────
const razorpayRoute = require('./routes/razorpayRoute');

// ── Google Ads Routes ─────────────────────────────────────────────────────────
const googleAdsConfigRoute = require('./routes/googleAdsConfig');
const googleWebhookRoute   = require('./routes/googleWebhook');

// ── Website Contact Form Routes ───────────────────────────────────────────────
const websiteConfigRoute  = require('./routes/websiteConfig');
const websiteWebhookRoute = require('./routes/websiteWebhook');

const attendanceRoute      = require('./routes/attendanceRoute');
const emailCampaignRoute   = require('./routes/emailCampaign');
const emailHistoryRoute    = require('./routes/emailHistory');

// ── Subscription Expiry Email Job ─────────────────────────────────────────────
const { startSubscriptionExpiryJob } = require('./jobs/subscriptionExpiryJob');
const { startIdleJob } = require('./jobs/markIdleJob');
// ── SMS Campaign Routes (MSG91) ───────────────────────────────────────────────
const smsCampaignRoute = require('./routes/smsCampaign');
const smsHistoryRoute  = require('./routes/smsHistory');

// ── Saanvi Voicebot Proxy (avoids CORS) ──────────────────────────────────────
const saanviProxyRoute = require('./routes/saanviProxy');

// ── WhatsApp Routes (MSG91 + Meta) ────────────────────────────────────────────
const whatsappRoutes    = require('./routes/whatsappRoutes');
const msg91WebhookRoute = require('./routes/msg91Webhook');

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Trust proxy — Render sits behind 1 hop of its own reverse proxy.
// '1' = trust only the first X-Forwarded-For entry (prevents IP spoofing).
// ─────────────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

const server = http.createServer(app);

// ── Allowed origins ───────────────────────────────────────────────────────────
// When SERVE_FRONTEND=true the Express server itself serves the React build,
// so frontend and backend share one domain — CORS is not needed for the CRM UI.
// We still need CORS for third-party origins (website widgets, webhooks, etc).
const staticAllowedOrigins = [
  "http://localhost:5173",   // Vite dev server
  "http://localhost:4173",   // Vite preview
  "http://localhost:5000",   // backend itself (for SSR / proxy testing)
  "https://skyup-crm-frontend.onrender.com",
];

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
    return false;
  }
}

const corsOptions = {
  origin: async (origin, callback) => {
    if (!origin) return callback(null, true);
    if (staticAllowedOrigins.includes(origin)) return callback(null, true);
    const allowed = await isDynamicOriginAllowed(origin);
    if (allowed) {
      console.log(`✅ CORS allowed for registered website: ${origin}`);
      return callback(null, true);
    }
    console.warn(`⚠️  CORS blocked unknown origin: ${origin}`);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-company-id"],
  optionsSuccessStatus: 200,
};

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

// ── CORS must be first ────────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/plain", limit: "5mb" }));

app.use(generalLimiter);

// ── Static file serving ───────────────────────────────────────────────────────
app.use('/recordings',    express.static(path.join(__dirname, 'uploads/recordings')));
app.use('/uploads/logos', express.static(path.join(__dirname, 'public/uploads/logos')));

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: Serve the React frontend build from the backend.
// Set SERVE_FRONTEND=true in your Render environment variables.
//
// When enabled:
//   • Copy the `dist/` folder from the frontend build into the backend root.
//     In your Render build command use:
//       cd ../frontend && npm ci && npm run build && cp -r dist ../backend/dist
//   • Both frontend and backend run on the same Render service → same domain.
//   • CORS is no longer needed for the CRM UI (only for webhooks/widgets).
//   • All /api/* requests go straight to Express (no proxy needed).
// ─────────────────────────────────────────────────────────────────────────────
const SERVE_FRONTEND = process.env.SERVE_FRONTEND === 'true';

if (SERVE_FRONTEND) {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  console.log(`🌐 Serving React frontend from: ${distPath}`);
}

app.get('/', (req, res) => {
  if (SERVE_FRONTEND) {
    return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  }
  res.send('Server is running');
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Webhook Routes (public — no auth) ────────────────────────────────────────
app.use('/meta',          metaWebhookRoute);
app.use('/msg91-webhook', msg91WebhookRoute);
app.use('/wa-webhook',    whatsappRoutes);

app.use('/website-webhook', (req, res, next) => {
  const origin = req.headers.origin || '';
  res.header('Access-Control-Allow-Origin',  origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/meta-config',       metaConfigRoute);
app.use('/api/superadmin',        superAdminRoute);
app.use('/api/developer',         developerRoutes);
app.use('/api/admin',             adminRoute);
app.use('/api/auth',              authRoute);
app.use('/api/lead',              leadRoute);
app.use('/api/attendance',        attendanceRoute);
app.use('/api/razorpay',          razorpayRoute);
app.use('/api/google-ads-config', googleAdsConfigRoute);
app.use('/',                      googleWebhookRoute);
app.use('/api/website-config',    websiteConfigRoute);
app.use('/api/chat',              chatRoutes);
app.use('/api/email-campaign',    emailCampaignRoute);
app.use('/api/email',             emailHistoryRoute);
app.use('/api/sms-campaign',      smsCampaignRoute);
app.use('/api/sms',               smsHistoryRoute);
app.use('/api/sms-config',        require('./routes/smsConfig'));
app.use('/api/privacy',           privacyRoute);
app.use('/api/subscription',      subscriptionRoute);
app.use('/api/saanvi',            saanviProxyRoute);
app.use('/api/whatsapp',          whatsappRoutes);
app.use('/api/reports',           require('./routes/reportRoutes'));
app.use('/api/call-logs',         require('./routes/mobileCallLog'));
app.use('/api/transcription',     require('./routes/transcription'));

// ─────────────────────────────────────────────────────────────────────────────
// SPA fallback — must be LAST.
// When SERVE_FRONTEND=true, any route that isn't an API or static file returns
// index.html so React Router handles it client-side.
// ─────────────────────────────────────────────────────────────────────────────
if (SERVE_FRONTEND) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.set("io", io);
global._io = io;

initSocket(io);

connectDB().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🛡️  Trust proxy:       enabled (1 hop)`);
    console.log(`🎙️  Recordings served at: /recordings/`);
    console.log(`🔐 BIP39 zero-knowledge encryption: enabled`);
    console.log(`📋 Privacy API:       /api/privacy`);
    console.log(`💳 Subscription API:  /api/subscription`);
    console.log(`🌐 Frontend served:   ${SERVE_FRONTEND ? 'YES (from dist/)' : 'NO (separate Render service)'}`);
    startSubscriptionExpiryJob();
  });
});

// Line ~265 (inside connectDB().then callback, after startSubscriptionExpiryJob()):
startIdleJob();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const { redisClient } = require('./middlewares/rateLimiter');

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  try {
    if (redisClient.isReady) {
      await redisClient.quit();
      console.log('✅ Redis connection closed.');
    }
  } catch (err) {
    console.error('Redis quit error:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));