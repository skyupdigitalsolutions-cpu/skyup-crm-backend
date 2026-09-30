// jobs/followUpDailyPingJob.js
// ─────────────────────────────────────────────────────────────────────────────
// TWO scheduled Telegram pings per company per day:
//
//  PING 1 — 9:00 AM (company timezone)
//  "Good morning — here are today's follow-ups"
//  Shows every lead that has a scheduledCalls entry due today (and any overdue).
//  Grouped by employee so admin knows who needs to call whom.
//
//  PING 2 — 4:00 PM (company timezone)
//  "End-of-afternoon — called vs not-called status"
//  Shows:
//    ✅ Called (+ remark if logged, follow-up set for next day)
//    🔴 Not Called yet (still pending)
//  Based on MobileCallLog for the day vs the follow-up list from Ping 1.
//
// Uses the SAME DailyReportConfig bot token + chatId as the daily report
// (no new config needed — just two extra scheduled sends on top of the
// existing daily performance report).
//
// Idempotency: simple in-memory Set per day (survives server restart via the
// grace-window pattern — each company fires at most once per window).
// A full DailyReportHistory record is NOT created for pings (they are
// lightweight operational pings, not "reports" in the business sense).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron              = require('node-cron');
const mongoose          = require('mongoose');
const DailyReportConfig = require('../models/DailyReportConfig');
const Company           = require('../models/Company');
const Lead              = require('../models/Leads');
const MobileCallLog     = require('../models/MobileCallLog');
const User              = require('../models/Users');
const { getCompanyDayBounds, getTodayInTimezone, sendTelegramMessage } = require('../services/dailyReportService');

// ── Idempotency guards — prevent double-fire within the grace window ───────────
// Format: "companyId:YYYY-MM-DD:ping1" or ":ping2"
const _sentToday = new Set();

function sentKey(companyId, localDate, type) {
  return `${companyId}:${localDate}:${type}`;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

const GRACE_MINUTES = 5;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function currentTimeInTz(tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function isTimeWindow(targetHHMM, tz) {
  const nowMin    = toMinutes(currentTimeInTz(tz));
  const targetMin = toMinutes(targetHHMM);
  const elapsed   = (nowMin - targetMin + 1440) % 1440;
  return elapsed >= 0 && elapsed <= GRACE_MINUTES;
}

// ── Escape HTML for Telegram ──────────────────────────────────────────────────
function e(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtTime(date, tz) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date);
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[m-1]} ${y}`;
}

// ── PING 1: Morning follow-up list ────────────────────────────────────────────
// Fetches all leads with scheduledCalls due today OR overdue, grouped by employee.

async function buildMorningMessage(companyId, dayStart, dayEnd, tz, companyName, localDate) {
  const cid = new mongoose.Types.ObjectId(String(companyId));

  // ── New leads assigned today ───────────────────────────────────────────────
  const newLeads = await Lead.find({
    company:    cid,
    mergedInto: null,
    isClosed:   { $ne: true },
    createdAt:  { $gte: dayStart, $lte: dayEnd },
  })
    .select('_id name mobile status campaign source remark user createdAt')
    .populate('user', 'name')
    .lean();

  const leads = await Lead.find({
    company:    cid,
    mergedInto: null,
    isClosed:   { $ne: true },
    $or: [
      // Due today (pending)
      { scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $gte: dayStart, $lte: dayEnd } } } },
      // Overdue (past, not done)
      { scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lt: dayStart } } } },
    ],
  })
    .select('_id name mobile status scheduledCalls user')
    .populate('user', 'name')
    .lean();

  if (!leads.length) {
    return `🌅 <b>FOLLOW-UP MORNING PING</b>\n` +
           `📅 ${fmtDate(localDate)} — ${e(companyName)}\n\n` +
           `✅ No follow-ups scheduled for today.`;
  }

  // Group by employee
  const byEmployee = new Map();
  const overdueByEmployee = new Map();

  for (const lead of leads) {
    const empName = lead.user?.name || 'Unassigned';
    for (const sc of (lead.scheduledCalls || [])) {
      if (sc.done) continue;
      const at      = new Date(sc.scheduledAt);
      const isToday = at >= dayStart && at <= dayEnd;
      const isPast  = at < dayStart;
      const timeStr = fmtTime(at, tz);
      const entry   = {
        leadName: lead.name || 'Unknown',
        mobile:   lead.mobile || '',
        status:   lead.status || '',
        timeStr,
        at,
        note: sc.note || '',
        type: sc.type || 'follow-up',
      };

      if (isPast) {
        if (!overdueByEmployee.has(empName)) overdueByEmployee.set(empName, []);
        overdueByEmployee.get(empName).push(entry);
      } else if (isToday) {
        if (!byEmployee.has(empName)) byEmployee.set(empName, []);
        byEmployee.get(empName).push(entry);
      }
    }
  }

  // Sort entries by time within each employee
  for (const arr of byEmployee.values())     arr.sort((a,b) => a.at - b.at);
  for (const arr of overdueByEmployee.values()) arr.sort((a,b) => a.at - b.at);

  const totalDue     = [...byEmployee.values()].reduce((s, a) => s + a.length, 0);
  const totalOverdue = [...overdueByEmployee.values()].reduce((s, a) => s + a.length, 0);

  let msg = `🌅 <b>FOLLOW-UP MORNING PING</b>\n` +
            `📅 ${fmtDate(localDate)} — ${e(companyName)}\n` +
            `📊 ${totalDue} due today · ${totalOverdue} overdue\n`;

  // Overdue section first (most urgent)
  if (overdueByEmployee.size > 0) {
    msg += `\n🔴 <b>OVERDUE — NOT YET DONE</b>\n`;
    for (const [emp, entries] of overdueByEmployee) {
      msg += `\n👤 <b>${e(emp)}</b>\n`;
      entries.slice(0, 10).forEach((en, i) => {
        const note = en.note ? ` — ${e(en.note)}` : '';
        msg += `  ${i+1}. ${e(en.leadName)} · <i>${en.timeStr}</i>${note}\n`;
      });
      if (entries.length > 10) msg += `  <i>…+${entries.length - 10} more</i>\n`;
    }
  }

  // Today's follow-ups by employee
  if (byEmployee.size > 0) {
    msg += `\n🟡 <b>DUE TODAY</b>\n`;
    for (const [emp, entries] of byEmployee) {
      msg += `\n👤 <b>${e(emp)}</b>\n`;
      entries.slice(0, 10).forEach((en, i) => {
        const note = en.note ? ` — ${e(en.note)}` : '';
        msg += `  ${i+1}. ${e(en.leadName)} · <i>${en.timeStr}</i>${note}\n`;
      });
      if (entries.length > 10) msg += `  <i>…+${entries.length - 10} more</i>\n`;
    }
  }

  // New leads section
  if (newLeads.length > 0) {
    // Group by employee
    const newByEmp = new Map();
    for (const lead of newLeads) {
      const empName = lead.user?.name || 'Unassigned';
      if (!newByEmp.has(empName)) newByEmp.set(empName, []);
      newByEmp.get(empName).push(lead);
    }

    msg += `\n🆕 <b>NEW LEADS TODAY (${newLeads.length})</b>\n`;
    for (const [emp, empLeads] of newByEmp) {
      msg += `\n👤 <b>${e(emp)}</b>\n`;
      empLeads.slice(0, 10).forEach((lead, i) => {
        const src = lead.campaign || lead.source || '';
        const srcStr = src ? ` · ${e(src)}` : '';
        msg += `  ${i+1}. ${e(lead.name || 'Unknown')}${srcStr}\n`;
      });
      if (empLeads.length > 10) msg += `  <i>…+${empLeads.length - 10} more</i>\n`;
    }
  }

  msg += `\n📞 Good luck with the calls today!`;
  return msg;
}

// ── PING 2: Afternoon called vs not-called ────────────────────────────────────
// Compares today's follow-up list against MobileCallLog entries for the day.
// A lead is "called" if a MobileCallLog entry exists for their normalized phone
// with timestamp in today's window. Remark is shown if logged.

async function buildAfternoonMessage(companyId, dayStart, dayEnd, tz, companyName, localDate) {
  const cid = new mongoose.Types.ObjectId(String(companyId));

  // ── New leads assigned today ───────────────────────────────────────────────
  const newLeads = await Lead.find({
    company:    cid,
    mergedInto: null,
    isClosed:   { $ne: true },
    createdAt:  { $gte: dayStart, $lte: dayEnd },
  })
    .select('_id name mobile normalizedPhone status campaign source remark user')
    .populate('user', 'name')
    .lean();

  // Get all leads with follow-ups due today
  const leads = await Lead.find({
    company:    cid,
    mergedInto: null,
    isClosed:   { $ne: true },
    $or: [
      { scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $gte: dayStart, $lte: dayEnd } } } },
      { scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lt: dayStart } } } },
    ],
  })
    .select('_id name mobile normalizedPhone status scheduledCalls user remark')
    .populate('user', 'name')
    .lean();

  if (!leads.length) {
    return `🌆 <b>FOLLOW-UP AFTERNOON CHECK</b>\n` +
           `📅 ${fmtDate(localDate)} — ${e(companyName)}\n\n` +
           `✅ No follow-ups were scheduled for today.`;
  }

  // Get today's call logs for this company
  const callLogs = await MobileCallLog.find({
    company:   cid,
    timestamp: { $gte: dayStart, $lte: dayEnd },
  })
    .select('normalizedPhone phoneNumber name remark callType duration timestamp user')
    .populate('user', 'name')
    .lean();

  // Build a set of normalized phones called today (and the remark if any)
  // Key: normalizedPhone → { remark, duration, callType, calledBy }
  const calledMap = new Map();
  for (const log of callLogs) {
    const norm = log.normalizedPhone || (log.phoneNumber || '').replace(/\D/g, '').slice(-10);
    if (!norm) continue;
    // Keep the entry with a remark if multiple calls exist
    const existing = calledMap.get(norm);
    const hasRemark = log.remark && !/^(outgoing|incoming|missed) call from mobile app/i.test(log.remark);
    if (!existing || hasRemark) {
      calledMap.set(norm, {
        remark:   hasRemark ? log.remark : (existing?.remark || ''),
        duration: log.duration || 0,
        callType: log.callType || 'outgoing',
        calledBy: log.user?.name || '',
      });
    }
  }

  // Categorize each lead
  const called    = [];
  const notCalled = [];

  for (const lead of leads) {
    const norm = lead.normalizedPhone || (lead.mobile || '').replace(/\D/g, '').slice(-10);
    const empName = lead.user?.name || 'Unassigned';
    const callInfo = norm ? calledMap.get(norm) : null;

    // Find the most relevant scheduledCall (earliest pending)
    const pendingCalls = (lead.scheduledCalls || [])
      .filter(sc => !sc.done)
      .sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    const scheduledTime = pendingCalls[0]
      ? fmtTime(new Date(pendingCalls[0].scheduledAt), tz)
      : '—';

    const entry = {
      leadName:      lead.name || 'Unknown',
      mobile:        lead.mobile || '',
      status:        lead.status || '',
      employee:      empName,
      scheduledTime,
      remark:        callInfo?.remark || '',
      calledBy:      callInfo?.calledBy || empName,
      duration:      callInfo?.duration || 0,
    };

    if (callInfo) called.push(entry);
    else          notCalled.push(entry);
  }

  // Sort by employee name
  called.sort((a,b)    => a.employee.localeCompare(b.employee));
  notCalled.sort((a,b) => a.employee.localeCompare(b.employee));

  let msg = `🌆 <b>FOLLOW-UP AFTERNOON CHECK</b>\n` +
            `📅 ${fmtDate(localDate)} — ${e(companyName)}\n` +
            `📊 ${called.length} called · ${notCalled.length} not called\n`;

  // Not-called first (most actionable — still time to call before EOD)
  if (notCalled.length > 0) {
    msg += `\n🔴 <b>NOT CALLED YET (${notCalled.length})</b>\n`;
    const MAX = 20;
    notCalled.slice(0, MAX).forEach((en, i) => {
      msg += `${i+1}. <b>${e(en.leadName)}</b> · ${en.scheduledTime} 👤 ${e(en.employee)}\n`;
    });
    if (notCalled.length > MAX) msg += `<i>…+${notCalled.length - MAX} more not called</i>\n`;
  }

  if (called.length > 0) {
    msg += `\n✅ <b>CALLED (${called.length})</b>\n`;
    const MAX = 20;
    called.slice(0, MAX).forEach((en, i) => {
      const rmk = en.remark ? ` — "${e(en.remark)}"` : '';
      msg += `${i+1}. <b>${e(en.leadName)}</b> 👤 ${e(en.calledBy)}${rmk}\n`;
    });
    if (called.length > MAX) msg += `<i>…+${called.length - MAX} more called</i>\n`;
  }

  if (notCalled.length === 0) {
    msg += `\n🎉 All follow-ups completed for today!`;
  } else {
    msg += `\n⏰ ${notCalled.length} lead${notCalled.length > 1 ? 's' : ''} still waiting — follow up before end of day!`;
  }

  // ── New leads section: called vs not-called ────────────────────────────────
  if (newLeads.length > 0) {
    const newCalled    = [];
    const newNotCalled = [];

    for (const lead of newLeads) {
      const norm     = lead.normalizedPhone || (lead.mobile || '').replace(/\D/g, '').slice(-10);
      const empName  = lead.user?.name || 'Unassigned';
      const callInfo = norm ? calledMap.get(norm) : null;
      const src      = lead.campaign || lead.source || '';
      const entry    = {
        leadName: lead.name || 'Unknown',
        employee: empName,
        source:   src,
        remark:   callInfo?.remark || '',
        calledBy: callInfo?.calledBy || empName,
      };
      if (callInfo) newCalled.push(entry);
      else          newNotCalled.push(entry);
    }

    msg += `\n\n🆕 <b>NEW LEADS TODAY (${newLeads.length})</b>\n`;
    msg += `📊 ${newCalled.length} called · ${newNotCalled.length} not called\n`;

    if (newNotCalled.length > 0) {
      msg += `\n🔴 <b>Not Called (${newNotCalled.length})</b>\n`;
      newNotCalled.slice(0, 15).forEach((en, i) => {
        const src = en.source ? ` · ${e(en.source)}` : '';
        msg += `${i+1}. <b>${e(en.leadName)}</b>${src} 👤 ${e(en.employee)}\n`;
      });
      if (newNotCalled.length > 15) msg += `<i>…+${newNotCalled.length - 15} more</i>\n`;
    }

    if (newCalled.length > 0) {
      msg += `\n✅ <b>Called (${newCalled.length})</b>\n`;
      newCalled.slice(0, 15).forEach((en, i) => {
        const rmk = en.remark ? ` — "${e(en.remark)}"` : '';
        msg += `${i+1}. <b>${e(en.leadName)}</b> 👤 ${e(en.calledBy)}${rmk}\n`;
      });
      if (newCalled.length > 15) msg += `<i>…+${newCalled.length - 15} more</i>\n`;
    }
  }

  return msg;
}

// ── Send one ping for one company ─────────────────────────────────────────────

async function sendPing(config, companyName, pingType) {
  const tz        = config.timezone || 'Asia/Kolkata';
  const localDate = getTodayInTimezone(tz);
  const key       = sentKey(String(config.company), localDate, pingType);

  if (_sentToday.has(key)) return; // already sent this ping today
  _sentToday.add(key);

  try {
    const { dayStart, dayEnd } = getCompanyDayBounds(tz, localDate);
    const companyId = String(config.company);
    const token     = config.getDecryptedToken();
    const chatId    = config.telegramChatId;

    if (!token || !chatId) {
      console.warn(`[FollowUpPing] ${pingType}: no token/chatId for company ${companyId}`);
      return;
    }

    let text;
    if (pingType === 'ping1') {
      text = await buildMorningMessage(companyId, dayStart, dayEnd, tz, companyName, localDate);
    } else {
      text = await buildAfternoonMessage(companyId, dayStart, dayEnd, tz, companyName, localDate);
    }

    // Split if over 4000 chars
    const MAX = 4000;
    if (text.length <= MAX) {
      await sendTelegramMessage(token, chatId, text);
    } else {
      // Split at newline boundary
      const chunks = [];
      let chunk = '';
      for (const line of text.split('\n')) {
        if ((chunk + '\n' + line).length > MAX) {
          if (chunk) chunks.push(chunk);
          chunk = line;
        } else {
          chunk = chunk ? chunk + '\n' + line : line;
        }
      }
      if (chunk) chunks.push(chunk);
      for (const c of chunks) {
        await sendTelegramMessage(token, chatId, c);
        await new Promise(r => setTimeout(r, 300)); // respect Telegram rate limit
      }
    }

    console.log(`[FollowUpPing] ✅ ${pingType} sent for ${companyName} (${localDate})`);
  } catch (err) {
    // Remove from set so it can retry on next tick within the grace window
    _sentToday.delete(key);
    console.error(`[FollowUpPing] ❌ ${pingType} failed for ${companyName}:`, err.message);
  }
}

// ── Main tick: checks all enabled companies ───────────────────────────────────

async function runFollowUpPingTick() {
  try {
    const configs = await DailyReportConfig.find({ enabled: true });
    if (!configs.length) return;

    const companyIds = configs.map(c => c.company);
    const companies  = await Company.find({ _id: { $in: companyIds } }).select('name').lean();
    const nameMap    = new Map(companies.map(c => [String(c._id), c.name]));

    await Promise.allSettled(configs.map(async (config) => {
      const tz          = config.timezone || 'Asia/Kolkata';
      const companyName = nameMap.get(String(config.company)) || 'Company';

      // Ping 1 — 9:00 AM in company timezone
      if (isTimeWindow('09:00', tz)) {
        await sendPing(config, companyName, 'ping1');
      }

      // Ping 2 — 16:00 (4 PM) in company timezone
      if (isTimeWindow('16:00', tz)) {
        await sendPing(config, companyName, 'ping2');
      }
    }));
  } catch (err) {
    console.error('[FollowUpPing] Tick error:', err.message);
  }
}

// ── Clear the sent-today guard at midnight ────────────────────────────────────
function scheduleMidnightClear() {
  cron.schedule('0 0 * * *', () => {
    _sentToday.clear();
    console.log('[FollowUpPing] Daily sent-guard cleared at midnight');
  }, { timezone: 'Asia/Kolkata' });
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startFollowUpPingJob() {
  // Runs every minute — same pattern as dailyReportJob
  cron.schedule('* * * * *', runFollowUpPingTick);
  scheduleMidnightClear();
  console.log('[FollowUpPingJob] ✅ Started');
  console.log('  → Ping 1 (Morning follow-up list):    9:00 AM company timezone');
  console.log('  → Ping 2 (Called vs not-called):     4:00 PM company timezone');
}

module.exports = { startFollowUpPingJob, runFollowUpPingTick };
