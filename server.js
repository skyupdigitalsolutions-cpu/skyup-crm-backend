require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const { generalLimiter } = require('./middlewares/rateLimiter');
const connectDB           = require('./config/db');
const initSocket          = require('./socket/socketHandler');

// CRM Routes
const superAdminRoute = require('./routes/superAdminRoute');
const adminRoute      = require('./routes/adminRoute');
const authRoute       = require('./routes/authRoutes');
const leadRoute       = require('./routes/leadRoute');

//Chat Engine Routes
const chatRoutes = require('./routes/chatRoutes');

// Meta Routes
const metaWebhookRoute = require('./routes/metaWebhook');
const metaConfigRoute  = require('./routes/metaConfig');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

//Middleware

// ADD 2 — Replace app.use(express.json()) with this block
// Raw body must be captured BEFORE express.json() for Meta signature verification
app.use((req, res, next) => {
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // needed by metaSignature.js middleware
    },
  })(req, res, next);
});

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

//Health Check
app.get('/', (req, res) => res.send('Server is running'));

//CRM API Routes
app.use('/api/superadmin', superAdminRoute);
app.use('/api/admin',      adminRoute);
app.use('/api/auth',       authRoute);
app.use('/api/lead',       leadRoute);

//Chat Engine API Routes
app.use('/api/chat',       chatRoutes);

//Meta Routes
app.use('/meta',            metaWebhookRoute);   // Meta calls this (no auth)
app.use('/api/meta-config', metaConfigRoute);    // Admin manages campaigns

//Socket.IO (Chat Engine)
initSocket(io);

//Connect DB & Start Server
connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});