// server.js — UPDATED
// Fix: /uploads/logos static path corrected (public/uploads/logos → uploads/logos)
// Added:
//   - addonRoutes   → /api/addons
//   - benefitRoutes → /api/benefits
//   - usageResetJob → startUsageResetJob()
// All existing code is UNCHANGED except the static path fix.
// ENV: staticAllowedOrigins now loaded from ALLOWED_ORIGINS env variable

// ── Silence ONLY Mongoose's deprecated `new`-option warning ──────────────────
// We intentionally still pass { new: true } to findOneAndUpdate in ~60 places
// (it works fine in Mongoose 7). This warning is harmless log noise and is
// tagged as a MONGOOSE-type warning (not a DeprecationWarning), so
// process.noDeprecation won't catch it. We surgically drop just this one
// message and leave every other warning fully intact.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (msg.includes('`new` option for')) return; // only this Mongoose message
  return _emitWarning(warning, ...args);
};

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

// ── Privacy & Subscription Routes ─────────────────────────────────────────────
const privacyRoute      = require('./routes/privacyRoute');
const subscriptionRoute = require('./routes/subscriptionRoute');

// ── NEW: Addon & Benefit Routes ───────────────────────────────────────────────
const addonRoutes   = require('./routes/addonRoute');
const benefitRoutes = require('./routes/benefitRoute');

// ── Chat Engine Routes ─────────────────────────────────────────────────────────
const chatRoutes = require('./routes/chatRoutes');

// ── Meta Routes ───────────────────────────────────────────────────────────────
const metaWebhookRoute = require('./routes/metaWebhook');
const metaConfigRoute  = require('./routes/metaConfig');

// ── Razorpay Routes ───────────────────────────────────────────────────────────
const razorpayRoute = require('./routes/razorpayRoute');

// ── Trial + Auto-billing Routes (7-day Pro trial w/ saved payment method) ──────
const trialRoute = require('./routes/trialRoute');

// ── Google Ads Routes ─────────────────────────────────────────────────────────
const googleAdsConfigRoute = require('./routes/googleAdsConfig');
const googleAnalyticsRoute = require('./routes/googleAnalytics');
const googleAdsApiRoute    = require('./routes/googleAdsApi');
const googleWebhookRoute   = require('./routes/googleWebhook');

// ── Website Contact Form Routes ───────────────────────────────────────────────
const websiteConfigRoute  = require('./routes/websiteConfig');
const websiteWebhookRoute = require('./routes/websiteWebhook');

const projectRoute         = require('./routes/projectRoute');
const attendanceRoute      = require('./routes/attendanceRoute');
const emailCampaignRoute   = require('./routes/emailCampaign');
const emailHistoryRoute    = require('./routes/emailHistory');

// ── Jobs ──────────────────────────────────────────────────────────────────────
const { startSubscriptionExpiryJob } = require('./jobs/subscriptionExpiryJob');
const { startTrialExpiryJob }        = require('./jobs/trialExpiryJob');
const { startIdleJob }               = require('./jobs/markIdleJob');
const { startLeadAlertsJob }         = require('./jobs/leadAlertsJob');
// NEW: Monthly usage counter reset
const { startUsageResetJob }         = require('./jobs/usageResetJob');
const { startLimitOverrideExpiryJob } = require('./jobs/limitOverrideExpiryJob');
const { startAddonExpiryJob }         = require('./jobs/addonExpiryJob');
const { startMeetingReminderJob }     = require('./jobs/meetingReminderJob');
const { startFollowUpReminderJob }    = require('./jobs/followUpReminderJob');
const { startMetaAutoSyncJob }        = require('./jobs/metaAutoSyncJob'); // NEW — auto-syncs new Meta ad sets & forms

// ── SMS Campaign Routes (MSG91) ───────────────────────────────────────────────
const smsCampaignRoute         = require('./routes/smsCampaign');
const smsCampaignEmployeeRoute = require('./routes/smsCampaignEmployee');
const smsHistoryRoute  = require('./routes/smsHistory');

// ── Saanvi Voicebot Proxy ─────────────────────────────────────────────────────
const saanviProxyRoute = require('./routes/saanviProxy');

// ── WhatsApp Routes (MSG91 + Meta) ────────────────────────────────────────────
const whatsappRoutes    = require('./routes/whatsappRoutes');
const msg91WebhookRoute = require('./routes/msg91Webhook');

const app = express();

app.set('trust proxy', 1);

const server = http.createServer(app);

// ── Allowed origins (loaded from ALLOWED_ORIGINS env variable) ────────────────
// In .env:  ALLOWED_ORIGINS=http://localhost:5173,https://skyupcrm.com,...
const staticAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

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
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Public website-lead webhook — accepts leads from ANY landing-page origin ──
// MUST be registered BEFORE the global allowlisted CORS below. Landing pages
// live on arbitrary customer domains, so this endpoint sets permissive CORS
// headers and answers its own preflight. If it were registered after the
// global `app.options()` catch-all, that allowlist would reject the preflight
// first (No 'Access-Control-Allow-Origin' header) and the lead POST would be
// blocked by the browser. Body is parsed inline because the global JSON parser
// is registered further down. Secret verification inside the controller is the
// real security gate — CORS here is intentionally open.
app.use(
  '/website-webhook',
  (req, res, next) => {
    const origin = req.headers.origin || '';
    res.header('Access-Control-Allow-Origin',  origin || '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  },
  express.json(),
  websiteWebhookRoute
);

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
// FIX: was path.join(__dirname, 'public/uploads/logos') — that folder doesn't exist.
// Local uploads land in uploads/logos/; Cloudinary URLs are absolute and don't hit this.
app.use('/uploads/logos', express.static(path.join(__dirname, 'uploads/logos')));

const SERVE_FRONTEND = process.env.SERVE_FRONTEND === 'true';
if (SERVE_FRONTEND) {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  console.log(`🌐 Serving React frontend from: ${distPath}`);
}

app.get('/', (req, res) => {
  if (SERVE_FRONTEND) return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  res.send('Server is running');
});

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Webhook Routes (public — no auth) ────────────────────────────────────────
app.use('/meta',          metaWebhookRoute);
app.use('/msg91-webhook', msg91WebhookRoute);
app.use('/wa-webhook',    whatsappRoutes);

// NOTE: /website-webhook is registered EARLIER (before the global CORS) so its
// permissive cross-origin headers and preflight response are not overridden or
// rejected by the origin allowlist. See the block above `app.use(cors(...))`.

// ── API Routes ────────────────────────────────────────────────────────────────
// ── One-time migration: marketing-only admins → role:marketing_user ───────────
// Runs once after DB connects. Safe to run on every deploy (no-op when done).
const runMarketingRoleMigration = async () => {
  try {
    const Admin = require("./models/Admin");
    const result = await Admin.updateMany(
      { marketingAccess: true, role: { $in: ["admin", "sub_admin"] } },
      { $set: { role: "marketing_user" } }
    );
    if (result.modifiedCount > 0) {
      console.log("[Migration] marketing_user role: updated " + result.modifiedCount + " admin(s) → marketing_user");
    }
  } catch (e) {
    console.warn("[Migration] marketing_user role migration failed (non-fatal):", e.message);
  }
};

app.use('/api/marketing-panel',     require('./routes/marketingPanel'));
app.use('/api/meta-config',         metaConfigRoute);
app.use('/api/meta-qualification',  require('./routes/metaQualification'));
app.use('/api/superadmin',          superAdminRoute);
app.use('/api/developer',           developerRoutes);
app.use('/api/admin',               adminRoute);
app.use('/api/auth',                authRoute);
app.use('/api/terms',               require('./routes/termsRoute'));
app.use('/api/lead',                leadRoute);
app.use('/api/project',             projectRoute);
app.use('/api/attendance',          attendanceRoute);
app.use('/api/razorpay',            razorpayRoute);
app.use('/api/trial',               trialRoute);
app.use('/api/google-ads-config',   googleAdsConfigRoute);
app.use('/api/google-analytics',    googleAnalyticsRoute);
app.use('/api/google-ads-api',      googleAdsApiRoute);
app.use('/',                        googleWebhookRoute);
app.use('/api/website-config',      websiteConfigRoute);
app.use('/api/chat',                chatRoutes);
app.use('/api/email-campaign',      emailCampaignRoute);
app.use('/api/email',               emailHistoryRoute);
app.use('/api/sms-campaign',          smsCampaignRoute);
app.use('/api/sms-campaign/employee', smsCampaignEmployeeRoute);
app.use('/api/sms',                 smsHistoryRoute);
app.use('/api/sms-config',          require('./routes/smsConfig'));
app.use('/api/privacy',             privacyRoute);
app.use('/api/subscription',        subscriptionRoute);
// NEW
app.use('/api/addons',              addonRoutes);
app.use('/api/benefits',            benefitRoutes);
app.use('/api/saanvi',              saanviProxyRoute);
app.use('/api/whatsapp',            whatsappRoutes);
app.use('/api/reports',             require('./routes/reportRoutes'));
app.use('/api/call-logs',           require('./routes/mobileCallLog'));
app.use('/api/transcription',       require('./routes/transcription'));

// ── APK Download Routes ───────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'skyupcrm.apk');
  res.download(apkPath, 'SkyUpCRM.apk', (err) => {
    if (err) res.status(404).json({ message: 'APK not found' });
  });
});

app.get('/install', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Install SkyUp CRM</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: Arial, sans-serif; background: #f0f4ff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
          .card { background: white; padding: 35px 30px; border-radius: 20px; max-width: 400px; width: 100%; box-shadow: 0 8px 30px rgba(0,0,0,0.12); text-align: center; }
          .logo { font-size: 48px; margin-bottom: 10px; }
          h1 { color: #1a1a2e; font-size: 24px; margin-bottom: 5px; }
          .version { color: #999; font-size: 13px; margin-bottom: 25px; }
          .btn { background: #4f46e5; color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-size: 18px; font-weight: bold; display: inline-block; margin-bottom: 25px; }
          .steps { text-align: left; background: #f8f9ff; padding: 20px; border-radius: 12px; }
          .steps p { font-weight: bold; margin-bottom: 10px; color: #333; }
          .step { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; color: #555; font-size: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">📱</div>
          <h1>SkyUp CRM</h1>
          <p class="version">Version 1.0.0 • Android</p>
          <a class="btn" href="/download">⬇️ Download App</a>
          <div class="steps">
            <p>📋 How to Install:</p>
            <div class="step">1️⃣ Tap Download App above</div>
            <div class="step">2️⃣ Open the downloaded APK file</div>
            <div class="step">3️⃣ Allow unknown sources if asked</div>
            <div class="step">4️⃣ Tap Install ✅</div>
          </div>
        </div>
      </body>
    </html>
  `);
});

if (SERVE_FRONTEND) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.set("io", io);
global._io = io;

initSocket(io);

connectDB().then(() => {
  // Migrate any marketing-only admins that still have role:admin → marketing_user
  runMarketingRoleMigration();

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🛡️  Trust proxy:       enabled (1 hop)`);
    console.log(`🎙️  Recordings served at: /recordings/`);
    console.log(`🔐 BIP39 zero-knowledge encryption: enabled`);
    console.log(`📋 Privacy API:       /api/privacy`);
    console.log(`💳 Subscription API:  /api/subscription`);
    console.log(`📦 Addon API:         /api/addons`);
    console.log(`🎁 Benefit API:       /api/benefits`);
    console.log(`🌐 Frontend served:   ${SERVE_FRONTEND ? 'YES (from dist/)' : 'NO (separate Render service)'}`);
    console.log(`🔒 CORS origins:      ${staticAllowedOrigins.length} origin(s) loaded from ALLOWED_ORIGINS env`);
    startSubscriptionExpiryJob();
    startTrialExpiryJob();   // NEW — emails customers when their 7-day trial lapses
    startIdleJob();
    startLeadAlertsJob();
    startUsageResetJob();   // NEW
    startLimitOverrideExpiryJob();  // NEW — reverts expired priced limit overrides
    startAddonExpiryJob();          // NEW — marks expired add-ons (incl. 30-day credit packs) as expired
    startMeetingReminderJob();      // NEW — day-before + meeting-day WhatsApp/email reminders
    startFollowUpReminderJob();     // NEW — WhatsApp/email reminders to leads with due follow-ups (9:30 AM & 8:30 PM IST)
    startMetaAutoSyncJob();         // NEW — every 30 min: auto-sync new Meta ad sets & lead forms into MetaConfig
    // MSG91 inbound: webhook-only mode — no polling needed
    const { checkFCMHealth } = require('./services/fcmService');
    checkFCMHealth();
  });
});

// ── Keep-alive ping (prevents Render free tier cold starts) ──────────────────
// Pings /api/health every 10 minutes so the server never sleeps.
if (process.env.RENDER_EXTERNAL_URL) {
  const PING_URL = `${process.env.RENDER_EXTERNAL_URL}/api/health`;
  setInterval(() => {
    fetch(PING_URL)
      .then(() => console.log('🏓 Keep-alive ping sent'))
      .catch((err) => console.warn('⚠️  Keep-alive ping failed:', err.message));
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`🏓 Keep-alive enabled → ${PING_URL}`);
}

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

// ── Process-level safety net ──────────────────────────────────────────────────
// Previously there was no handler for unhandled promise rejections or uncaught
// exceptions. A single stray rejection (e.g. a background job or fire-and-forget
// .catch() that was missed) could crash the entire Render process and take down
// the whole API. These handlers log the error with a full stack so it's visible
// in Render logs, without killing the server for a recoverable rejection.
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED PROMISE REJECTION:', reason);
  // Intentionally NOT exiting — log and keep serving. Investigate via the stack.
});

process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
  // An uncaught synchronous exception can leave the process in an undefined
  // state. Log it; let Render's own restart policy handle a hard crash if the
  // process actually becomes unstable. Do not silently swallow.
});
