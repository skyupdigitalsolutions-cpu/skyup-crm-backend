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
// FIX (clock/timezone bug): this was a straight `new Date().toISOString().slice(0,10)`
// — the UTC date. attendanceController.js's todayStr() was fixed a while back to
// compute the IST wall-clock date instead (UTC and IST disagree on "today" every
// night between 12:00 AM and 5:30 AM IST), but this duplicated copy was never
// updated to match. Net effect: for that ~5.5 hour window every night, this job
// queried Attendance for the WRONG date — every real record for "tonight" was
// filed under the correct IST date by clockIn/pingActivity, while this job was
// searching for the UTC date (still "yesterday"), so it silently found zero
// records and marked nobody idle for the entire early-morning window.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30 in ms
function todayStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
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

    const io  = global._io;
    const now = new Date();

    // ── Build bulkWrite ops — one write per idle record instead of N awaited saves
    const ops = stale.map(rec => {
      const newBreak = { startTime: now, reason: 'Auto Idle', remarkStatus: 'pending' };
      const updatedBreaks = [...rec.breaks, newBreak];
      return {
        updateOne: {
          filter: { _id: rec._id },
          update: {
            $set: {
              status:            'idle',
              activeBreakIndex:  updatedBreaks.length - 1,
              totalBreakMinutes: calcBreakMinutes(updatedBreaks),
            },
            $push: { breaks: newBreak },
          },
        },
      };
    });

    await Attendance.bulkWrite(ops, { ordered: false });

    // Emit socket events after the batch write completes
    if (io) {
      for (const rec of stale) {
        io.to(`att:${rec.user}`).emit('attendance:updated', { ...rec.toObject(), status: 'idle' });
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
