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

const app    = express();
const server = http.createServer(app);
// ✅ FIXED server.js

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://skyup-crm-frontend.onrender.com", // add your real domain here
];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
};

// Fix Socket.IO CORS
const io = new Server(server, { cors: corsOptions });

// Fix Express CORS (replace the existing app.use(cors()))
app.use(cors(corsOptions));

// ── CRITICAL: Capture raw body for Meta HMAC signature verification ───────────
// This MUST come before any other body parser
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  })(req, res, next);
});

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/plain", limit: "5mb" }));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Server is running'));

// ── Meta Routes — BEFORE rate limiter so Meta webhook IPs are never throttled ─
app.use('/meta',            metaWebhookRoute);
app.use('/api/meta-config', metaConfigRoute);

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

// ── Chat Routes ───────────────────────────────────────────────────────────────
app.use('/api/chat', chatRoutes);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
initSocket(io);

// ── Start Server ──────────────────────────────────────────────────────────────
connectDB().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});