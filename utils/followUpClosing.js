// utils/followUpClosing.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Which of a lead's pending follow-ups to close when an employee saves an update (PATCH /lead/:id).
//
//   • a NEW follow-up is being set     → the oldest pending one is replaced (unchanged)
//   • a call / remark is being logged  → close EVERY pending follow-up due today or earlier
//                                         (+ the oldest one if it falls due within 30 min, even past midnight)
//   • anything else (temperature, plain status change) → leave them pending
//
// Why "due today or earlier": the employee has just spoken to the lead, so today's follow-up — whatever time it was
// set for — and every overdue one are handled. A follow-up set for a LATER day is deliberately left alone (and so are
// reminders: closing on every edit used to stop them firing — see the FOLLOW-UP PING FIX in leadController).
// Before this, only the single oldest follow-up was closed, and only once it was already due, so a call at 11 AM never
// completed a 6 PM follow-up and a backlog of overdue ones never cleared.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_MS = 30 * 60 * 1000;

// Last millisecond of the company's day, given the start of that day.
const dayEndOf = (dayStart) => (dayStart instanceof Date && !Number.isNaN(+dayStart) ? new Date(+dayStart + DAY_MS - 1) : null);

// Returns the indexes (into lead.scheduledCalls) to mark done.
function pickFollowUpsToClose({ scheduledCalls, settingNew, loggedCall, now = Date.now(), dayEnd = null }) {
  const pending = (Array.isArray(scheduledCalls) ? scheduledCalls : [])
    .map((sc, idx) => ({ sc, idx }))
    .filter(({ sc }) => sc && !sc.done && sc.scheduledAt && !Number.isNaN(+new Date(sc.scheduledAt)))
    .sort((a, b) => new Date(a.sc.scheduledAt) - new Date(b.sc.scheduledAt));
  if (!pending.length) return [];

  const close = new Set();
  const oldest = pending[0];
  if (settingNew) close.add(oldest.idx);
  if (loggedCall) {
    if (+new Date(oldest.sc.scheduledAt) <= now + SOON_MS) close.add(oldest.idx);
    if (dayEnd) for (const { sc, idx } of pending) if (+new Date(sc.scheduledAt) <= +dayEnd) close.add(idx);
  }
  return [...close].sort((a, b) => a - b);
}

module.exports = { pickFollowUpsToClose, dayEndOf };
