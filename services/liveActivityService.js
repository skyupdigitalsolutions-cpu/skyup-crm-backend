// services/liveActivityService.js
// ─────────────────────────────────────────────────────────────────────────────
// Real-time idle detection helper used by attendanceController.
//   refreshActivity(userId) → called on every heartbeat/ping; (re)sets a Redis
//                             key that expires after IDLE_SECONDS.
//   clearActivity(userId)   → called on clock-out / break start.
// Fails OPEN: when Redis is down both functions are silent no-ops, and the
// markIdleJob cron (every 2 min) still marks idle users from MongoDB.
//
// Optional instant idle: if Redis keyspace notifications are enabled
// (`CONFIG SET notify-keyspace-events Ex`), an expired key triggers
// attendanceController.markSingleUserIdle(userId) immediately.
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_SECONDS = 5 * 60;
const KEY = (userId) => `act:${userId}`;

let redisClient = null;
try {
  ({ redisClient } = require('../middlewares/rateLimiter'));
} catch { /* no Redis — no-op mode */ }

const ready = () => !!redisClient && redisClient.isReady === true;

async function refreshActivity(userId) {
  if (!ready() || !userId) return;
  await redisClient.set(KEY(userId), '1', { EX: IDLE_SECONDS });
}

async function clearActivity(userId) {
  if (!ready() || !userId) return;
  await redisClient.del(KEY(userId));
}

// ── Expiry subscriber (best-effort) ──────────────────────────────────────────
let subscriberStarted = false;
async function startExpirySubscriber() {
  if (subscriberStarted || !redisClient) return;
  subscriberStarted = true;
  try {
    const sub = redisClient.duplicate();
    sub.on('error', () => {});
    await sub.connect();
    await sub.pSubscribe('__keyevent@*__:expired', (key) => {
      if (!key || !key.startsWith('act:')) return;
      const userId = key.slice(4);
      // Lazy require avoids a circular import with attendanceController.
      const { markSingleUserIdle } = require('../controllers/attendanceController');
      if (typeof markSingleUserIdle === 'function') {
        markSingleUserIdle(userId).catch((e) =>
          console.error('[liveActivityService] markSingleUserIdle:', e.message)
        );
      }
    });
    console.log('✅ [liveActivityService] listening for idle expiries');
  } catch (e) {
    console.warn('⚠️  [liveActivityService] expiry subscriber not started (cron fallback active):', e.message);
  }
}

// Start once Redis is up; never blocks module load.
if (redisClient) {
  if (redisClient.isReady) startExpirySubscriber();
  else redisClient.once?.('ready', () => startExpirySubscriber());
}

module.exports = { refreshActivity, clearActivity, startExpirySubscriber, IDLE_SECONDS };
