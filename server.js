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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Middleware ───────────────────────────────────────────────────────────────
// Raw body must be captured BEFORE express.json() for Meta signature verification
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })(req, res, next);
});

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Server is running'));

// ── CRM API Routes ───────────────────────────────────────────────────────────
app.use('/api/superadmin', superAdminRoute);
app.use('/api/admin',      adminRoute);
app.use('/api/auth',       authRoute);
app.use('/api/lead',       leadRoute);

// ── Twilio Routes ────────────────────────────────────────────────────────────
app.use('/api/twilio',     twilioRoutes);

// ── Chat Engine Routes ───────────────────────────────────────────────────────
app.use('/api/chat',       chatRoutes);

// ── Meta Routes ──────────────────────────────────────────────────────────────
app.use('/meta',            metaWebhookRoute);
app.use('/api/meta-config', metaConfigRoute);

// ── Socket.IO ────────────────────────────────────────────────────────────────
initSocket(io);

// ── Connect DB & Start Server ────────────────────────────────────────────────
connectDB().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});