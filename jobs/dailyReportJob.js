// jobs/dailyReportJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Daily Telegram Report job.
//
// Pattern: same as all other jobs in this project (node-cron, startXxx export).
// Runs every minute, checks which companies need their report sent right now.
//
// Idempotency:
//   • DailyReportHistory unique index { company, reportDate, triggeredBy }
//     prevents duplicate sends even if the cron fires twice (server restart,
//     clock drift, multiple instances).
//   • generateAndSend() creates a 'pending' record before starting work.
//     A duplicate E11000 → skipped immediately.
//
// Performance:
//   • Only queries DailyReportConfig documents where enabled=true.
//   • In-memory time check (no extra DB query per company per minute).
//   • One company's failure never blocks others (Promise.allSettled).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron               = require('node-cron');
const Company            = require('../models/Company');
const DailyReportConfig  = require('../models/DailyReportConfig');
const { generateAndSend, getTodayInTimezone } = require('../services/dailyReportService');

// ── Check if a company should receive its report right now ────────────────────
// FIX: previously this required an EXACT "HH:MM" string match, checked once
// per minute. If the process was mid-restart, redeploying, or waking up from
// a Render free-tier cold start during that exact minute, the tick was
// missed entirely — and since there was no fallback, that company silently
// got NO report for the whole day, with no error anywhere in the History tab.
//
// Fix: fire any time we're at-or-just-past the target minute, within a small
// grace window. This is safe because generateAndSend() already has a hard
// idempotency guard (DailyReportHistory unique index on
// {company, reportDate, triggeredBy}) — so even if this returns true on
// several consecutive ticks inside the window, only the first one actually
// sends; the rest short-circuit via "Already sent ... skipping".
const GRACE_MINUTES = 5;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function shouldSendNow(config) {
  try {
    const tz  = config.timezone || 'Asia/Kolkata';
    const now = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour:  '2-digit',
      minute:'2-digit',
      hour12: false,
    }).format(new Date()); // "HH:MM"

    const nowMin    = toMinutes(now);
    const targetMin = toMinutes(config.reportTime);

    // Minutes elapsed since target, wrapping around midnight (handles
    // targets like 23:58 correctly instead of going negative).
    const elapsed = (nowMin - targetMin + 1440) % 1440;

    return elapsed >= 0 && elapsed <= GRACE_MINUTES;
  } catch {
    return false;
  }
}

// ── Core tick function ────────────────────────────────────────────────────────
async function runDailyReportTick() {
  try {
    // Fetch all enabled configs in one query
    const configs = await DailyReportConfig.find({ enabled: true }).lean({ virtuals: false });
    if (!configs.length) return;

    // Re-hydrate as full Mongoose docs so getDecryptedToken() works
    const fullConfigs = await DailyReportConfig.find({
      _id: { $in: configs.map(c => c._id) },
      enabled: true,
    });

    const due = fullConfigs.filter(shouldSendNow);
    if (!due.length) return;

    console.log(`[DailyReportJob] ${due.length} company report(s) due at this minute`);

    // Fetch company names in one query
    const companyIds = due.map(c => c.company);
    const companies  = await Company.find({ _id: { $in: companyIds } }).select('name').lean();
    const nameMap    = new Map(companies.map(c => [String(c._id), c.name]));

    // Process all due companies concurrently; failures are isolated
    await Promise.allSettled(
      due.map(async (config) => {
        const companyName = nameMap.get(String(config.company)) || 'Unknown';
        try {
          await generateAndSend(config, companyName, null, 'scheduler');
        } catch (err) {
          console.error(`[DailyReportJob] Error for company ${config.company}:`, err.message);
        }
      }),
    );
  } catch (err) {
    console.error('[DailyReportJob] Tick error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startDailyReportJob() {
  // Runs every minute — checks if any company's configured time matches current time
  cron.schedule('* * * * *', runDailyReportTick);
  console.log('[DailyReportJob] ✅ Daily Telegram Report job started (runs every minute)');
}

module.exports = { startDailyReportJob, runDailyReportTick };
