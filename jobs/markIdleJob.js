// jobs/markIdleJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Runs every 2 minutes.
// Finds every attendance record whose status is "active" but whose
// lastActivity timestamp is older than 5 minutes (the idle cutoff).
// Marks those records idle, closes the implicit break entry, and pushes
// an `attendance:updated` socket event to each user's private room so
// the mobile widget reflects the change instantly without a manual refresh.
//
// How to activate: in server.js, after connectDB().then(() => { ... })
// add one line inside the callback:
//   const { startIdleJob } = require('./jobs/markIdleJob');
//   startIdleJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron       = require('node-cron');
const Attendance = require('../models/Attendance');

// ── Helpers (duplicated from attendanceController to keep job self-contained) ─
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function calcBreakMinutes(breaks) {
  return breaks.reduce((sum, b) => {
    if (b.startTime && b.endTime)
      return sum + Math.round((new Date(b.endTime) - new Date(b.startTime)) / 60000);
    return sum;
  }, 0);
}

// ── Core scan ─────────────────────────────────────────────────────────────────
async function runMarkIdle() {
  try {
    const date   = todayStr();
    // 5-minute no-ping window → mark idle
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);

    // Find every active record (across ALL companies) where lastActivity has
    // gone stale. We intentionally do not scope by company here — the job
    // should cover every company's employees in one pass.
    const stale = await Attendance.find({
      date,
      status:       'active',
      loginTime:    { $exists: true, $ne: null },
      logoutTime:   null,
      lastActivity: { $lt: cutoff },
    });

    if (stale.length === 0) return;

    const io = global._io;   // set by server.js: global._io = io;

    for (const rec of stale) {
      // Open an auto-idle break entry
      rec.breaks.push({
        startTime: new Date(),
        reason:    'Auto Idle',
      });
      rec.activeBreakIndex  = rec.breaks.length - 1;
      rec.status            = 'idle';
      rec.totalBreakMinutes = calcBreakMinutes(rec.breaks);
      await rec.save();

      // Push update to the user's socket room so the widget flips immediately
      if (io) {
        io.to(`att:${rec.user}`).emit('attendance:updated', rec);
      }
    }

    console.log(`[IdleJob] Marked ${stale.length} user(s) idle at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[IdleJob] Error during idle scan:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startIdleJob() {
  // Runs every 2 minutes — fine-grained enough given the 5-min cutoff.
  cron.schedule('*/2 * * * *', runMarkIdle);
  console.log('[IdleJob] ✅ Idle detection job started (runs every 2 min, cutoff = 5 min)');
}

module.exports = { startIdleJob, runMarkIdle };
