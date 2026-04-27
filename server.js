require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');

const { generalLimiter } = require('./middlewares/rateLimiter');
const connectDB           = require('./config/db');
const initSocket          = require('./socket/socketHandler');

// ── CRM Routes ────────────────────────────────────────────────────────────────
const superAdminRoute = require('./routes/superAdminRoute');
const adminRoute      = require('./routes/adminRoute');
const authRoute       = require('./routes/authRoutes');
const leadRoute       = require('./routes/leadRoute');

// ── Privacy & Subscription Routes (NEW) ──────────────────────────────────────
const privacyRoute      = require('./routes/privacyRoute');
const subscriptionRoute = require('./routes/subscriptionRoute');

// ── Chat Engine Routes ─────────────────────────────────────────────────────────
const chatRoutes = require('./routes/chatRoutes');

// ── Meta Routes ───────────────────────────────────────────────────────────────
const metaWebhookRoute = require('./routes/metaWebhook');
const metaConfigRoute  = require('./routes/metaConfig');

// ── Twilio Routes ─────────────────────────────────────────────────────────────
const twilioRoutes = require('./routes/twilio');

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

// ── Saanvi Voicebot Proxy (avoids CORS) ──────────────────────────────────────
const saanviProxyRoute = require('./routes/saanviProxy');

const app    = express();
const server = http.createServer(app);

// ── Static origins always allowed ─────────────────────────────────────────────
const staticAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
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

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  })(req, res, next);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/plain", limit: "5mb" }));

app.use(generalLimiter);

app.get('/', (req, res) => res.send('Server is running'));

// ── Webhook Routes (public — no auth) ────────────────────────────────────────
app.use('/meta', metaWebhookRoute);

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
app.use('/api/meta-config', metaConfigRoute);

app.use('/api/superadmin', superAdminRoute);
app.use('/api/admin',      adminRoute);
app.use('/api/auth',       authRoute);
app.use('/api/lead',       leadRoute);

app.use('/api/attendance', attendanceRoute);

app.use('/api/twilio',   twilioRoutes);
app.use('/api/razorpay', razorpayRoute);

app.use('/api/google-ads-config', googleAdsConfigRoute);
app.use('/',                      googleWebhookRoute);

app.use('/api/website-config', websiteConfigRoute);
app.use('/api/chat',           chatRoutes);
app.use('/api/email-campaign', emailCampaignRoute);
app.use('/api/email',          emailHistoryRoute);

// ── Privacy & Subscription (BIP39 zero-knowledge encryption) ─────────────────
app.use('/api/privacy',      privacyRoute);
app.use('/api/subscription', subscriptionRoute);

// ── Saanvi Voicebot Proxy ─────────────────────────────────────────────────────
app.use('/api/saanvi', saanviProxyRoute);

app.set("io", io);
global._io = io;

initSocket(io);

connectDB().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 BIP39 zero-knowledge encryption: enabled`);
    console.log(`📋 Privacy API:      /api/privacy`);
    console.log(`💳 Subscription API: /api/subscription`);
  });
});