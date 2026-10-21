// backend/controllers/mobileCallLogController.js
// FIX 4C: syncCallLogs() — eliminated N+1 query pattern.
//         Previously: findLeadByPhone() was called once per log entry,
//         each call loading ALL company leads from MongoDB.
//         100 logs = 100 full collection scans.
//         Now: load all company leads ONCE, build a phone-number Map,
//         then do O(1) Map lookups inside the loop. 1 DB call total.

const MobileCallLog = require('../models/MobileCallLog');
const { readPagination, sendObject, applyPage } = require('../utils/paginate');
const Lead          = require('../models/Leads');
const multer        = require('multer');
const { normalizePhone } = require('../utils/normalizePhone');
const { sendInterestedBlast } = require('../services/autoTemplateService');
const mongoose = require('mongoose');
const {
  parseLeadFilters, hasLeadFilters, dayBounds, leadFilterConditions, wasAssignedOnDay, groupStage, buildFilterTree,
} = require('../utils/callDayFilters');                       // "newly assigned that day" + ad-level filters (Calls by Day)

// An aggregation does NOT convert id strings to ObjectIds (normal queries do). protectAny gives employees a STRING
// req.user.userId, so ids used inside $match must be converted by hand or the match silently finds nothing.
const toObjectId = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24 ? new mongoose.Types.ObjectId(String(v)) : v);

// Ids of the leads that satisfy the screen's lead filters (null = no lead filter active). Used to narrow the
// day's call logs to calls on those leads. Employees only ever see their own leads.
async function leadIdsForFilters({ isAdmin, company, selfId, filters, dayStart, dayEnd }) {
  const conds = leadFilterConditions(filters, dayStart, dayEnd);
  if (!conds.length) return null;
  const q = { company, ...(isAdmin ? {} : { user: selfId }), $and: conds };
  const rows = await Lead.find(q).select('_id').limit(5000).lean();
  return rows.map((r) => r._id);
}

// The fields the Calls-by-Day cards need to show which campaign / ad a lead came from.
const LEAD_AD_FIELDS = 'campaign adSetName attribution.metaAdId attribution.metaAdsetId attribution.metaAdName attribution.googleAdGroupId';
const adSummary = (l) => ({
  campaign: l.campaign || '',
  adSet:    (l.adSetName || '') || ((l.attribution && (l.attribution.metaAdsetId || l.attribution.googleAdGroupId)) ? 'Ad set …' + String(l.attribution.metaAdsetId || l.attribution.googleAdGroupId).slice(-6) : ''),
  ad:       (l.attribution && (l.attribution.metaAdName || (l.attribution.metaAdId ? 'Ad …' + String(l.attribution.metaAdId).slice(-6) : ''))) || '',
});

// ── Cloudinary storage ────────────────────────────────────────────────────────
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const cloudinaryStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:          'skyup-crm/recordings',
    // FIX: use 'auto' instead of 'video' — Cloudinary's 'video' type handles audio,
    // but 'auto' lets Cloudinary detect the correct type from the file content
    // rather than the MIME header, which is more reliable when Android OEMs
    // send wrong MIME types (e.g. video/mp4 for .m4a files).
    resource_type:   'auto',
    public_id:       `${(req.user.userId || req.user._id)}_${Date.now()}`,
    allowed_formats: ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'mp4', '3g2'],
  }),
});

// FIX: Expanded MIME allowlist — Android OEMs (Samsung, Xiaomi, MIUI) send
// non-standard MIME types for the same audio formats. e.g.:
//   .m4a → 'audio/x-m4a' OR 'video/mp4' (Samsung uses video/mp4 for m4a)
//   .3gp → 'audio/3gpp' OR 'video/3gpp' OR 'video/3gpp2'
//   .amr → 'audio/amr' OR 'audio/amr-nb' OR 'audio/amr-wb'
// Without these, the fileFilter cb(new Error(...), false) silently rejects
// the upload and the controller receives req.file = undefined, causing
// "No file uploaded" 400 errors even when the file is correctly attached.
const allowedMimes = [
  // MP3
  'audio/mpeg', 'audio/mp3',
  // M4A / AAC (Samsung sends video/mp4 for .m4a files)
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac', 'video/mp4',
  // WAV
  'audio/wav', 'audio/x-wav', 'audio/wave',
  // AMR (narrow and wide band)
  'audio/amr', 'audio/amr-nb', 'audio/amr-wb',
  // 3GP (audio-only and video container — many dialers use video/3gpp)
  'audio/3gpp', 'audio/3gpp2', 'video/3gpp', 'video/3gpp2',
  // OGG / Opus
  'audio/ogg', 'audio/opus', 'audio/x-opus+ogg',
  // Generic fallbacks
  'application/octet-stream', 'binary/octet-stream',
];

const upload = multer({
  storage: cloudinaryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only audio files are allowed'), false);
  },
});

// NOTE: normalizePhone is imported from ../utils/normalizePhone (central source of truth)

function callTypeToOutcome(callType) {
  const map = {
    incoming: 'Incoming Call', outgoing: 'Outgoing Call',
    missed:   'Missed Call',   rejected: 'Rejected',
    blocked:  'Blocked',       voicemail:'Voicemail', unknown: 'Call',
  };
  return map[callType] || 'Call';
}

// ── POST /api/call-logs/sync ──────────────────────────────────────────────────
// FIX 4C: Replaced N+1 findLeadByPhone() calls with a single bulk fetch + Map.

// ── Link agent remarks to their calls ────────────────────────────────────────
// Agents usually add the remark in Lead Detail right after hanging up — BEFORE
// the phone has pushed that call to the server. The remark lands on the lead's
// callHistory, the call log arrives later without one, and Calls by Day showed
// "Remark pending" forever. This copies the agent's own remark (made from just
// before the call up to 12 h after it) onto any call log still missing one,
// both when calls are synced and when the list is read.
const AUTO_REMARK_RX = /^(outgoing|incoming|missed|rejected|voicemail|blocked|unknown)?\s*call\b.*from mobile app/i;
const isRealRemark = (r) => !!(r && String(r).trim() && !AUTO_REMARK_RX.test(String(r).trim()));

async function fillMissingRemarks(logs, opts = {}) {
  try {
    const pending = (logs || []).filter((l) => {
      const leadId = l.matchedLead?._id || l.matchedLead;
      return leadId && !isRealRemark(l.remark);
    });
    if (!pending.length) return 0;

    const leadIds = [...new Set(pending.map((l) => String(l.matchedLead?._id || l.matchedLead)))];
    const leads = await Lead.find(
      { _id: { $in: leadIds } },
      { callHistory: { $slice: -40 } },
    ).lean();
    const byLead = new Map(leads.map((l) => [String(l._id), l.callHistory || []]));

    const BEFORE = 2 * 60 * 1000, AFTER = 12 * 60 * 60 * 1000;
    const writes = [];
    for (const log of pending) {
      const hist = byLead.get(String(log.matchedLead?._id || log.matchedLead)) || [];
      const t = new Date(log.timestamp).getTime();
      const hit = hist
        .filter((h) => isRealRemark(h.remark)
          && (!log.user || !h.userId || String(h.userId) === String(log.user?._id || log.user))
          && new Date(h.calledAt).getTime() >= t - BEFORE
          && new Date(h.calledAt).getTime() <= t + AFTER)
        .sort((a, b) => new Date(a.calledAt) - new Date(b.calledAt))[0];
      if (!hit) continue;
      log.remark = String(hit.remark).trim().slice(0, 500);
      if (hit.outcome && !log.outcome) log.outcome = hit.outcome;
      if (log._id) {
        writes.push({ updateOne: {
          filter: { _id: log._id, $or: [{ remark: { $exists: false } }, { remark: null }, { remark: '' }, { remark: AUTO_REMARK_RX }] },
          update: { $set: { remark: log.remark, ...(hit.outcome ? { outcome: hit.outcome } : {}) } },
        } });
      }
    }
    if (writes.length && opts.persist !== false) {
      await MobileCallLog.bulkWrite(writes, { ordered: false }).catch((e) => console.warn('[fillMissingRemarks]', e.message));
    }
    return writes.length;
  } catch (e) {
    console.warn('[fillMissingRemarks] skipped:', e.message);
    return 0;
  }
}

const syncCallLogs = async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs) || logs.length === 0)
      return res.status(400).json({ message: 'No logs provided' });

    // ── Company-level call-log sync gate ─────────────────────────────────────
    // Super admin can disable device call-log sync per company.
    const Company = require('../models/Company');
    const companyId = (req.user.companyId || req.user.company);
    const batch = logs.slice(0, 500);

    // PERF: this used to load EVERY lead in the company (all phone fields) on
    // every sync — every agent's phone syncs every couple of minutes, so that
    // was thousands of documents over a ~150 ms link each time. Now only the
    // leads whose numbers appear in this batch are fetched (indexed lookup),
    // in parallel with the company gate check.
    const nums = [...new Set(batch.map((l) => normalizePhone(l.phoneNumber || '')).filter(Boolean))];
    const rawVariants = [...new Set(nums.flatMap((n) => [n, `91${n}`, `+91${n}`, `0${n}`]))];
    const [company, companyLeads] = await Promise.all([
      Company.findById(companyId).select('callLogSyncEnabled').lean(),
      nums.length
        ? Lead.find(
            {
              company: companyId,
              $or: [
                { normalizedPhone: { $in: nums } },
                { normalizedSecondaryPhone: { $in: nums } },
                { mobile: { $in: rawVariants } },          // legacy rows without normalizedPhone
              ],
            },
            { mobile: 1, primaryPhone: 1, secondaryPhone: 1, normalizedPhone: 1, normalizedSecondaryPhone: 1, _id: 1, name: 1, status: 1 }
          ).lean()
        : [],
    ]);
    if (company && company.callLogSyncEnabled === false) {
      return res.status(403).json({
        message: 'Device call-log sync is disabled for your company.',
        code:    'call_log_sync_disabled',
      });
    }

    // ── Per-user call-log sync gate ──────────────────────────────────────────
    if (req.user.callLogSyncEnabled === false) {
      return res.status(403).json({
        message: 'Device call-log sync is disabled for your account. Contact your administrator.',
        code:    'call_log_sync_disabled_user',
      });
    }

    const leadMapByPrimary   = new Map();
    const leadMapBySecondary = new Map();

    for (const lead of companyLeads) {
      const normP = lead.normalizedPhone || normalizePhone(lead.primaryPhone || lead.mobile || "");
      const normS = lead.normalizedSecondaryPhone || (lead.secondaryPhone ? normalizePhone(lead.secondaryPhone) : null);
      if (normP) leadMapByPrimary.set(normP,   { ...lead, _matchedAs: "Primary"   });
      if (normS) leadMapBySecondary.set(normS, { ...lead, _matchedAs: "Secondary" });
    }

    const docs = batch.map((log) => {
      const normalized  = normalizePhone(log.phoneNumber || '');
      // Prefer primary match; fall back to secondary
      const matchedLead =
        leadMapByPrimary.get(normalized) ||
        leadMapBySecondary.get(normalized) ||
        null;
      return {
        user:              (req.user.userId || req.user._id),
        company:           (req.user.companyId || req.user.company),
        phoneNumber:       log.phoneNumber,
        callType:          log.callType || 'unknown',
        duration:          parseInt(log.duration || 0),
        timestamp:         new Date(parseInt(log.timestamp)),
        name:              log.name || '',
        matchedLead:       matchedLead?._id || null,
        matchedNumberType: matchedLead?._matchedAs || null,
        _leadObj:          matchedLead || null,
      };
    });

    const ops = docs.map(({ _leadObj, ...doc }) => ({
      updateOne: {
        filter: { user: doc.user, phoneNumber: doc.phoneNumber, timestamp: doc.timestamp },
        update:  { $setOnInsert: doc },
        upsert:  true,
      },
    }));
    const result = await MobileCallLog.bulkWrite(ops);

    // Remark already typed on the lead before this call reached the server →
    // attach it now so the call never shows as "Remark pending".
    // Runs in the background — the phone doesn't wait for it.
    (async () => {
      try {
        const matchedDocs = docs.filter((d) => d.matchedLead);
        const syncedLogs = !matchedDocs.length ? [] : await MobileCallLog.find({
          user: (req.user.userId || req.user._id),
          $or: matchedDocs.map((d) => ({ phoneNumber: d.phoneNumber, timestamp: d.timestamp })),
        }).select('_id user matchedLead timestamp remark outcome').lean();
        if (syncedLogs.length) await fillMissingRemarks(syncedLogs);
      } catch (e) { console.warn('[syncCallLogs] remark link skipped:', e.message); }
    })();

    const leadUpdates = new Map();
    for (const doc of docs) {
      if (!doc._leadObj?._id) continue;
      const id = String(doc._leadObj._id);
      if (!leadUpdates.has(id)) leadUpdates.set(id, []);
      const dur = doc.duration;
      const min = Math.floor(dur / 60), sec = dur % 60;
      const durStr = dur > 0 ? ` (${min > 0 ? min + 'm ' : ''}${sec}s)` : '';
      leadUpdates.get(id).push({
        userId:   (req.user.userId || req.user._id),
        userName: req.user.name || 'Mobile App',
        remark:   `${callTypeToOutcome(doc.callType)} from mobile app${durStr}`,
        outcome:  callTypeToOutcome(doc.callType),
        calledAt: doc.timestamp,
        calledNumber: doc.phoneNumber || null,
        numberType:   doc.matchedNumberType || 'Primary',
      });
    }

    // ── Push new call-history entries onto matched leads ──────────────────────
    // FIX: this used to be `for (const [leadId, entries] of leadUpdates) { await
    // Lead.findById(...); await Lead.findByIdAndUpdate(...); }` — 2 sequential
    // DB round trips PER DISTINCT LEAD in the sync batch. This endpoint is hit
    // by every field agent's device on every call-log sync; a batch touching
    // 30 distinct leads meant 60 serial round trips on a single request.
    // Fixed to 1 batched read + 1 bulkWrite, regardless of how many leads are
    // touched.
    const leadIds = [...leadUpdates.keys()];
    let callHistoryPushCount = 0;

    if (leadIds.length) {
      const existingLeads = await Lead.find(
        { _id: { $in: leadIds } },
        { callHistory: 1 },
      ).lean();
      const existingMap = new Map(existingLeads.map(l => [String(l._id), l]));

      const bulkOps = [];
      for (const [leadId, entries] of leadUpdates) {
        const lead = existingMap.get(leadId);
        if (!lead) continue;
        const existing = new Set((lead.callHistory || []).map(h => new Date(h.calledAt).getTime()));
        const newEntries = entries.filter(e => !existing.has(new Date(e.calledAt).getTime()));
        if (newEntries.length > 0) {
          bulkOps.push({
            updateOne: {
              filter: { _id: leadId },
              update: { $push: { callHistory: { $each: newEntries } } },
            },
          });
          callHistoryPushCount += newEntries.length;
        }
      }

      if (bulkOps.length) {
        try {
          await Lead.bulkWrite(bulkOps);
        } catch (e) {
          console.error('callHistory bulk push error:', e.message);
        }
      }
    }

    res.json({
      message: 'Synced successfully',
      synced:  batch.length,
      inserted: result.upsertedCount,
      callHistoryUpdated: callHistoryPushCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs ────────────────────────────────────────────────────────
const getCallLogs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || 1, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || 50, 10) || 50), 1000);

    // Same admin-aware branching as getTodayCallLogs below — this route now
    // accepts protectAny (admin login on mobile), so it needs the same
    // "admin sees the whole company, agent sees only their own" scope.
    // Without this, an admin session would silently get an empty/irrelevant
    // list here (filtered to a call-log "user" matching their own admin ID,
    // which normal call logs never have) instead of an error — worse,
    // because it looks like "no calls" rather than a clear problem.
    // FIX BUG 1: req.admin is only set for admin/super_admin tokens by protectAny.
    // req.callerCompany is set for ALL authenticated callers (admin AND employee),
    // so using it as the isAdmin signal incorrectly treats every employee request
    // as an admin request, leaking all company-wide call data to regular employees.
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.user?.company;

    if (isAdmin && !company) {
      return res.status(400).json({ message: 'Company not resolved for admin token' });
    }

    const filter = isAdmin
      ? { company, ...(req.query.userId ? { user: req.query.userId } : {}) }
      : { user: (req.user.userId || req.user._id) };

    if (req.query.date) {
      // FIX BUG 2: Use device timezone offset to compute correct UTC boundaries.
      // tzOffset = device's UTC offset in minutes (positive = ahead of UTC, e.g. IST = 330).
      // Without this, calls made between 00:00-05:30 IST appear in the previous UTC day's
      // bucket and are missing from the selected day on Indian devices.
      const tzOffset = parseInt(req.query.tzOffset || '0', 10) || 0;
      const [year, month, day] = req.query.date.split('-').map(Number);
      // Local midnight expressed in UTC:
      const dayStartUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      dayStartUTC.setUTCMinutes(dayStartUTC.getUTCMinutes() - tzOffset);
      const dayEndUTC = new Date(dayStartUTC.getTime() + 24 * 60 * 60 * 1000);
      filter.timestamp = { $gte: dayStartUTC, $lt: dayEndUTC };
    }

    // ── Lead filters (newly assigned that day / campaign / ad set / ad) ───────
    // Narrow the day's calls to calls on leads that match. Calls on numbers that aren't leads drop out while a
    // lead filter is on (they can't match it).
    const leadFilters = parseLeadFilters(req.query);
    if (hasLeadFilters(leadFilters)) {
      const { dayStart: fs, dayEnd: fe } = dayBounds(req.query.date, req.query.tzOffset);
      const ids = await leadIdsForFilters({ isAdmin, company, selfId: (req.user && (req.user.userId || req.user._id)), filters: leadFilters, dayStart: fs, dayEnd: fe });
      if (ids) filter.matchedLead = { $in: ids };
    }

    // ── Incremental refresh: ?since=<ISO> ─────────────────────────────────────
    // Calls by Day polls every minute. Instead of re-downloading the whole day,
    // the app asks only for logs that are new/changed since its last fetch, or
    // whose lead changed (status / remark / follow-up) since then.
    const serverTime = new Date().toISOString();
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!Number.isNaN(since.getTime())) {
        const leadScope = isAdmin
          ? { company, updatedAt: { $gt: since } }
          : { user: (req.user.userId || req.user._id), updatedAt: { $gt: since } };
        const changedLeadIds = await Lead.find(leadScope).select('_id').limit(2000).lean()
          .then((r) => r.map((x) => x._id)).catch(() => []);
        const deltaFilter = {
          ...filter,
          $or: [
            { updatedAt: { $gt: since } },
            { createdAt: { $gt: since } },
            ...(changedLeadIds.length ? [{ matchedLead: { $in: changedLeadIds } }] : []),
          ],
        };
        let dq = MobileCallLog.find(deltaFilter).sort({ timestamp: -1 }).limit(1000)
          .populate('matchedLead', 'name mobile status scheduledCalls ' + LEAD_AD_FIELDS);
        if (isAdmin) dq = dq.populate('user', 'name email');
        const changed = await dq.lean();
        await fillMissingRemarks(changed);
        return res.json({ logs: changed, delta: true, serverTime });
      }
    }

    let logsQuery = MobileCallLog.find(filter)
      .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
      // FIX: extend matchedLead populate to include remark + scheduledCalls
      // so DayCallLogsScreen can show:
      //   • Lead status badge (status)
      //   • Remark status — done vs pending (remark from the MobileCallLog itself,
      //     but status from the lead)
      //   • Next follow-up date badge (scheduledCalls — filtered to pending entries)
      .populate('matchedLead', 'name mobile status scheduledCalls ' + LEAD_AD_FIELDS);
    // Only populate user name/email for admin (company-wide view).
    // Employees already know every log here is their own.
    if (isAdmin) logsQuery = logsQuery.populate('user', 'name email');

    const [logs, total] = await Promise.all([
      logsQuery.lean(),
      MobileCallLog.countDocuments(filter),
    ]);
    // Safety net: link remarks the agent already saved on the lead (fixes
    // calls that were synced after the remark — see fillMissingRemarks).
    await fillMissingRemarks(logs);
    res.json({ logs, page, total, totalPages: Math.ceil(total / limit), serverTime });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/today ──────────────────────────────────────────────────
// Role-aware:
//   • Regular agent (protect)  → returns only their own logs
//   • Admin / super_admin (protectAny) → returns ALL agents' logs for the
//     company, merged and sorted by time. Optional ?userId= to filter to
//     one specific agent. Optional ?date=YYYY-MM-DD to query a past day.
const getTodayCallLogs = async (req, res) => {
  try {
    // FIX: use tzOffset (device UTC offset in minutes) for correct local-day boundaries.
    // Without this, calls near midnight on IST devices appear on the wrong day.
    const dateParam = req.query.date;
    const tzOffset  = parseInt(req.query.tzOffset || '0', 10) || 0;
    let dayStart, dayEnd;
    if (dateParam) {
      const [year, month, day] = dateParam.split('-').map(Number);
      dayStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      dayStart.setUTCMinutes(dayStart.getUTCMinutes() - tzOffset);
      dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
    } else {
      // No date supplied — use the current local day in the device's timezone.
      // Compute "now" shifted by tzOffset so we get the device's current date.
      const nowUTC = Date.now();
      const localMidnightMs = Math.floor((nowUTC + tzOffset * 60000) / 86400000) * 86400000 - tzOffset * 60000;
      dayStart = new Date(localMidnightMs);
      dayEnd   = new Date(localMidnightMs + 24 * 60 * 60 * 1000 - 1);
    }

    // FIX: req.admin is only set for admin/super_admin tokens.
    // req.callerCompany is set for both admin AND employee — cannot use it as isAdmin signal.
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.user?.company;

    let filter;
    if (isAdmin) {
      // Admin: scope by company so ALL agents' logs are merged
      if (!company) return res.status(400).json({ message: 'Company not resolved for admin token' });
      filter = { company, timestamp: { $gte: dayStart, $lte: dayEnd } };
      // Optional drill-down: ?userId=<agentId>
      if (req.query.userId) filter.user = req.query.userId;
    } else {
      // Regular employee: only their own logs
      filter = { user: (req.user.userId || req.user._id), timestamp: { $gte: dayStart, $lte: dayEnd } };
    }

    const pg = readPagination(req, { defaultLimit: 100, maxLimit: 500 });
    const [logs, total] = await Promise.all([
      applyPage(MobileCallLog.find(filter).sort({ timestamp: -1 }), pg)
        .populate('matchedLead', 'name mobile status')
        .populate('user', 'name email')
        .lean(),
      pg.enabled ? MobileCallLog.countDocuments(filter) : null,
    ]);

    return sendObject(res, {
      logs,
      date:    (dateParam || new Date().toISOString()).slice(0, 10),
      count:   logs.length,
      scoped:  isAdmin ? 'company' : 'user',
    }, pg, total);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/match?phone=XXXXXXXXXX ─────────────────────────────────
const matchPhone = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ message: 'phone query param required' });

    const normalized = normalizePhone(phone);
    const companyId  = (req.user.companyId || req.user.company);

    const lead = await Lead.findOne(
      {
        company: companyId,
        $or: [
          { normalizedPhone:          normalized },
          { normalizedSecondaryPhone: normalized },
          { mobile:                   normalized },
          { mobile:                   phone       },
          { mobile:                   '0'  + normalized },
          { mobile:                   '91' + normalized },
        ],
      },
      { mobile: 1, primaryPhone: 1, secondaryPhone: 1, normalizedPhone: 1, normalizedSecondaryPhone: 1, name: 1, status: 1 }
    ).lean();

    if (!lead) return res.json({ matched: false });

    // Determine which number was matched
    const numberType =
      lead.normalizedPhone          === normalized ? 'Primary'   :
      lead.normalizedSecondaryPhone === normalized ? 'Secondary' : 'Legacy';

    res.json({
      matched:    true,
      leadId:     lead._id,
      name:       lead.name,
      status:     lead.status,
      mobile:     lead.mobile,
      numberType,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/recording ─────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// MANUAL RECORDING (source=manual) — for phones that cannot sync call logs, i.e. iPhones.
// An iPhone saves a recorded call in the Notes app; the employee saves the audio to Files and attaches it to the
// lead from the /agent web app. The Android app never sends source=manual, so its path below is unchanged.
//
// Why a separate path: the Android handler adds a recording to the LATEST call record for that phone number, whatever
// time it is given. That is right for a synced call log, but manual recordings from different days would all pile
// under one call. Here a recording joins an existing call only if it is within 10 minutes of the given call time;
// otherwise it creates its own call record with that time.
//
// Rules: the lead is required; an employee can attach only to a lead assigned to them (an admin: any lead in the
// company); the phone number is normalised to 10 digits; the call time must be sane (not in the future, not older
// than 60 days) or it falls back to "now".
// ─────────────────────────────────────────────────────────────────────────────
const MANUAL_MATCH_WINDOW_MS = 10 * 60 * 1000;
const MANUAL_MAX_AGE_MS      = 60 * 24 * 3600 * 1000;
const MANUAL_MAX_DURATION    = 4 * 3600;

// Android's sync stores the number exactly as the phone reported it (+91…, 0…, 10 digits), and its bulk upsert does
// not run the model hook that fills normalizedPhone. So "calls to this number" must match both ways.
const phoneMatch = (n10) => ({ $or: [{ normalizedPhone: n10 }, { phoneNumber: { $in: [n10, `91${n10}`, `+91${n10}`, `0${n10}`, `+91 ${n10}`] } }] });

// The call a recording made at time `ts` belongs to: a call by this employee to this number whose span
// [start − 10 min, start + duration + 10 min] contains `ts`. When several do, the one closest to `ts` wins.
async function findCallForTime({ callerId, companyId, phone, ts }) {
  const rows = await MobileCallLog.find({
    user: callerId, company: companyId, ...phoneMatch(phone),
    timestamp: { $gte: new Date(ts - MANUAL_MAX_DURATION * 1000 - MANUAL_MATCH_WINDOW_MS), $lte: new Date(ts + MANUAL_MATCH_WINDOW_MS) },
  }).select('_id timestamp duration durationEstimated source').lean();
  let best = null, bestGap = Infinity;
  for (const r of rows) {
    const start = new Date(r.timestamp).getTime();
    const end   = start + (Number(r.duration) || 0) * 1000;
    const gap   = ts < start ? start - ts : ts > end ? ts - end : 0;     // 0 when ts is inside the call
    if (gap <= MANUAL_MATCH_WINDOW_MS && gap < bestGap) { best = r; bestGap = gap; }
  }
  return best;
}

const uploadManualRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { leadId, remark, fileKey } = req.body;
    const callerId  = req.user.userId || req.user._id;
    const companyId = req.user.companyId || req.user.company;

    if (!leadId || !mongoose.Types.ObjectId.isValid(String(leadId))) {
      return res.status(400).json({ message: 'Choose the lead this recording belongs to.' });
    }
    const phone = normalizePhone(req.body.phoneNumber);
    if (!phone) return res.status(400).json({ message: 'This lead has no valid phone number, so the recording cannot be matched to a call.' });

    // an employee may only attach to their own leads; an admin to any lead of the company
    const lead = await Lead.findOne({ _id: leadId, company: companyId, ...(req.admin ? {} : { user: callerId }) });
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const now = Date.now();
    let ts = parseInt(req.body.timestamp, 10);
    if (!Number.isFinite(ts) || ts > now + 5 * 60000 || ts < now - MANUAL_MAX_AGE_MS) ts = now;
    let dur = parseInt(req.body.duration, 10);
    if (!Number.isFinite(dur) || dur < 0) dur = 0;
    dur = Math.min(dur, MANUAL_MAX_DURATION);
    const callType = ['incoming', 'outgoing'].includes(String(req.body.callType)) ? String(req.body.callType) : 'outgoing';
    const fileUrl  = req.file.path || req.file.secure_url || req.file.url;
    const note     = typeof remark === 'string' ? remark.trim().slice(0, 500) : '';   // MobileCallLog.remark maxlength is 500

    if (fileKey) {                                  // same duplicate protection as the Android upload
      const existing = await MobileCallLog.findOne({ user: callerId, company: companyId, 'recordings.fileKey': fileKey, ...phoneMatch(phone) });
      if (existing) {
        const dup = existing.recordings.find((r) => r.fileKey === fileKey);
        return res.json({ message: 'Already uploaded', duplicate: true, log: existing, recording: dup });
      }
    }

    const newRecording = { url: fileUrl, name: req.file.originalname, size: req.file.size, uploadedAt: new Date(), fileKey: fileKey || null };

    // 1) a call already on record (synced from Android, or logged by the /agent app on iPhone) → add the recording to it.
    //    A recording's real length replaces an estimated call length.
    let updated = null;
    const call = await findCallForTime({ callerId, companyId, phone, ts });
    if (call) {
      const $set = { matchedLead: lead._id, ...(note ? { remark: note } : {}) };
      if (dur > 0 && (call.durationEstimated || (Number(call.duration) || 0) < dur)) { $set.duration = dur; $set.durationEstimated = false; }
      updated = await MobileCallLog.findOneAndUpdate({ _id: call._id }, { $push: { recordings: newRecording }, $set }, { new: true });
    }

    // 2) no call on record → this recording becomes its own call record at the given time.
    if (!updated) {
      const doc = {
        user: callerId, company: companyId, phoneNumber: phone, callType, timestamp: new Date(ts), duration: dur,
        name: lead.name || '', matchedLead: lead._id, recordings: [newRecording], source: 'manual',
        ...(note ? { remark: note } : {}),
      };
      try { updated = await MobileCallLog.create(doc); }
      catch (e) {
        if (!(e && e.code === 11000)) throw e;     // an identical call record already exists (same second): add to it
        updated = await MobileCallLog.findOneAndUpdate(
          { user: callerId, phoneNumber: phone, timestamp: new Date(ts), callType },
          { $push: { recordings: newRecording }, $set: { matchedLead: lead._id, ...(note ? { remark: note } : {}) } },
          { new: true },
        );
      }
    }

    // link the recording to the lead's own call history: the entry for this call if there is one (the remark saved
    // after the call), otherwise a new entry so the lead's timeline shows the recording.
    try {
      const fresh = await Lead.findById(lead._id);
      if (fresh) {
        const start = new Date(updated.timestamp || ts).getTime();
        const refs  = [start, start + (Number(updated.duration) || 0) * 1000, ts];
        let idx = -1, minDiff = Infinity;
        (fresh.callHistory || []).forEach((h, i) => {
          if (h.recordingUrl) return;                // never overwrite another call's recording
          const t = new Date(h.calledAt).getTime();
          const diff = Math.min(...refs.map((r) => Math.abs(t - r)));
          if (diff < minDiff && diff < MANUAL_MATCH_WINDOW_MS) { minDiff = diff; idx = i; }
        });
        if (idx >= 0) {
          if (note) fresh.callHistory[idx].remark = note;
          fresh.callHistory[idx].recordingUrl  = fileUrl;
          fresh.callHistory[idx].recordingName = req.file.originalname;
        } else {
          fresh.callHistory.push({
            userId: callerId, userName: req.user.name || '', remark: note, outcome: '',
            calledAt: new Date(start), recordingUrl: fileUrl, recordingName: req.file.originalname,
            calledNumber: phone, numberType: 'Primary',
          });
        }
        fresh.markModified('callHistory');
        await fresh.save();
      }
    } catch (e) { console.error('manual recording: lead callHistory update error:', e.message); }

    return res.json({ message: 'Recording uploaded', log: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/call-logs/app-call — CALL LOG FOR iPHONE
//
// iOS gives no app (native or web) access to the phone's call history, so an iPhone can never "sync" its call log the
// way the Android app does. What the /agent web app CAN know is the calls it starts itself: the employee taps Call on
// a lead, the dialer opens, and when they come back the app knows which lead was called, when the call was placed
// and how long they were away. This endpoint turns that into a normal call-log record, so iPhone calls show up in
// Calls by Day, Call Monitoring, daily reports and talk time just like Android calls.
//
// Called twice per call (both are safe to repeat — the record is keyed by employee + number + dial time):
//   1. when the employee returns to the app      → { leadId, dialedAt, returnedAt }
//   2. when they save the after-call remark      → + { answered, outcome, remark }   (answered=false sets duration 0)
//
// The duration is the time spent away from the app (ringing + talking), so it is stored with durationEstimated=true.
// Attaching the call recording later replaces it with the recording's real length.
// Not captured: incoming calls, and calls dialled outside the app — iOS does not expose them.
// ─────────────────────────────────────────────────────────────────────────────
const APP_CALL_MAX_AGE_MS = 24 * 3600 * 1000;

const logAppCall = async (req, res) => {
  try {
    const callerId  = req.user.userId || req.user._id;
    const companyId = req.user.companyId || req.user.company;
    const { leadId } = req.body || {};
    if (!leadId || !mongoose.Types.ObjectId.isValid(String(leadId))) return res.status(400).json({ message: 'leadId is required' });

    const lead = await Lead.findOne({ _id: leadId, company: companyId, ...(req.admin ? {} : { user: callerId }) })
      .select('_id name mobile primaryPhone secondaryPhone normalizedPhone normalizedSecondaryPhone').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // same switches as the Android sync
    const Company = require('../models/Company');
    const company = await Company.findById(companyId).select('callLogSyncEnabled').lean();
    if (company && company.callLogSyncEnabled === false) return res.status(403).json({ message: 'Call logging is disabled for your company.', code: 'call_log_sync_disabled' });
    if (req.user.callLogSyncEnabled === false) return res.status(403).json({ message: 'Call logging is disabled for your account.', code: 'call_log_sync_disabled_user' });

    // the number comes from the lead, never trusted from the phone; the secondary number only if it really is the lead's
    const primary   = lead.normalizedPhone || normalizePhone(lead.primaryPhone || lead.mobile || '');
    const secondary = lead.normalizedSecondaryPhone || (lead.secondaryPhone ? normalizePhone(lead.secondaryPhone) : null);
    const asked     = req.body.phoneNumber ? normalizePhone(req.body.phoneNumber) : null;
    const phone     = asked && secondary && asked === secondary ? secondary : primary;
    if (!phone) return res.status(400).json({ message: 'This lead has no valid phone number.' });

    const now = Date.now();
    const dialedAt = parseInt(req.body.dialedAt, 10);
    if (!Number.isFinite(dialedAt) || dialedAt > now + 5 * 60000 || dialedAt < now - APP_CALL_MAX_AGE_MS) {
      return res.status(400).json({ message: 'Invalid call time.' });
    }
    const returnedAt = parseInt(req.body.returnedAt, 10);
    const awaySec = Number.isFinite(returnedAt) && returnedAt > dialedAt
      ? Math.min(Math.round((returnedAt - dialedAt) / 1000), MANUAL_MAX_DURATION) : 0;
    const answered = req.body.answered === false || req.body.answered === 'false' ? false
      : req.body.answered === true || req.body.answered === 'true' ? true : null;
    const duration = answered === false ? 0 : awaySec;
    const remark  = typeof req.body.remark === 'string' ? req.body.remark.trim().slice(0, 500) : '';
    const outcome = typeof req.body.outcome === 'string' ? req.body.outcome.trim().slice(0, 100) : '';

    // a phone that ALSO syncs its real call log (Android) already has this call — keep the real record only
    const synced = await MobileCallLog.findOne({
      user: callerId, company: companyId, source: null, ...phoneMatch(phone),
      timestamp: { $gte: new Date(dialedAt - MANUAL_MATCH_WINDOW_MS), $lte: new Date(dialedAt + MANUAL_MATCH_WINDOW_MS) },
    }).select('_id').lean();
    if (synced) return res.json({ message: 'Already synced from the phone', skipped: true });

    const key = { user: callerId, phoneNumber: phone, timestamp: new Date(dialedAt), callType: 'outgoing' };
    const apply = async (existing) => {
      const $set = { matchedLead: lead._id, ...(remark ? { remark } : {}), ...(outcome ? { outcome } : {}) };
      // Only an app-made duration may change — never a phone-reported one or a recording's real length.
      // Requests can arrive out of order (the phone retries ones that failed offline), so a request without an
      // outcome never undoes a "didn't answer" (0) that a remark already set.
      const appMade = existing.source === 'agent-web' && !(existing.recordings || []).length;
      if (appMade || existing.durationEstimated) {
        if (answered === false) { $set.duration = 0; $set.durationEstimated = false; }
        else if (awaySec > 0 && (existing.durationEstimated || answered === true)) { $set.duration = awaySec; $set.durationEstimated = true; }
      }
      return MobileCallLog.findOneAndUpdate({ _id: existing._id }, { $set }, { new: true });
    };

    const existing = await MobileCallLog.findOne(key);
    let log;
    if (existing) log = await apply(existing);
    else {
      try {
        log = await MobileCallLog.create({
          ...key, company: companyId, duration, durationEstimated: duration > 0, name: lead.name || '',
          matchedLead: lead._id, source: 'agent-web', ...(remark ? { remark } : {}), ...(outcome ? { outcome } : {}),
        });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;      // the other request for this call got there first
        log = await apply(await MobileCallLog.findOne(key));
      }
    }
    return res.json({ message: 'Call logged', log });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    // Phones that cannot sync call logs (iPhone) attach recordings by hand from the /agent web app — see uploadManualRecording.
    if (String((req.body && req.body.source) || '').toLowerCase() === 'manual') return uploadManualRecording(req, res);
    const { phoneNumber, timestamp, remark, leadId, fileKey } = req.body;
    const fileUrl = req.file.path || req.file.secure_url || req.file.url;
    const ts = timestamp ? new Date(parseInt(timestamp)) : null;

    let resolvedLeadId = null;
    if (leadId) {
      const lead = await Lead.findOne({ _id: leadId, company: (req.user.companyId || req.user.company) });
      if (lead) resolvedLeadId = lead._id;
    }

    // ── FIX: Server-side dedup by fileKey ─────────────────────────────────────
    // The mobile app sends fileKey = normalizedPhone::filename::mtimeMs.
    // If a recording with this exact fileKey already exists in the log's
    // recordings array, reject the upload immediately — the file was already
    // uploaded (by auto-sync or a previous manual tap) and Cloudinary has it.
    // This prevents duplicate entries in MongoDB even if the mobile-side dedup
    // (AsyncStorage) is cleared, app is reinstalled, or two devices upload
    // the same file simultaneously.
    if (fileKey) {
      const existing = await MobileCallLog.findOne({
        user:    (req.user.userId || req.user._id),
        company: (req.user.companyId || req.user.company),
        phoneNumber,
        'recordings.fileKey': fileKey,
      });
      if (existing) {
        const dup = existing.recordings.find(r => r.fileKey === fileKey);
        return res.json({ message: 'Already uploaded', duplicate: true, log: existing, recording: dup });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const newRecording = {
      url:       fileUrl,
      name:      req.file.originalname,
      size:      req.file.size,
      uploadedAt: new Date(),
      fileKey:   fileKey || null,   // FIX: store fileKey for future dedup checks
    };

    const updated = await MobileCallLog.findOneAndUpdate(
      { user: (req.user.userId || req.user._id), company: (req.user.companyId || req.user.company), phoneNumber },
      {
        $push: { recordings: newRecording },
        $set: {
          company:  (req.user.companyId || req.user.company),
          user:     (req.user.userId || req.user._id),
          phoneNumber,
          ...(remark         ? { remark:      remark.trim()  } : {}),
          ...(resolvedLeadId ? { matchedLead: resolvedLeadId } : {}),
        },
        $setOnInsert: {
          callType:  'outgoing',
          timestamp: ts || new Date(),
          duration:  0,
          name:      '',
        },
      },
      { upsert: true, new: true, sort: { timestamp: -1 } },
    );

    const savedRecording = updated.recordings[updated.recordings.length - 1];
    const fileUrl_forHistory = savedRecording?.url || fileUrl;

    const targetLeadId = resolvedLeadId || updated.matchedLead;
    if (targetLeadId) {
      try {
        const lead = await Lead.findById(targetLeadId);
        if (lead?.callHistory?.length > 0) {
          const refTime = updated.timestamp ? new Date(updated.timestamp).getTime() : null;
          let idx = -1;
          if (refTime) {
            let minDiff = Infinity;
            lead.callHistory.forEach((h, i) => {
              const diff = Math.abs(new Date(h.calledAt).getTime() - refTime);
              if (diff < minDiff && diff < 10 * 60 * 1000) { minDiff = diff; idx = i; }
            });
          } else {
            for (let i = lead.callHistory.length - 1; i >= 0; i--) {
              if (String(lead.callHistory[i].userId) === String((req.user.userId || req.user._id))) { idx = i; break; }
            }
          }
          if (idx >= 0) {
            if (remark?.trim()) lead.callHistory[idx].remark = remark.trim();
            lead.callHistory[idx].recordingUrl  = fileUrl_forHistory;
            lead.callHistory[idx].recordingName = req.file.originalname;
            lead.markModified('callHistory');
            await lead.save();
          }
        }
      } catch (e) { console.error('lead callHistory recording update error:', e.message); }
    }

    res.json({ message: 'Recording uploaded', log: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/recordings ─────────────────────────────────────────────
const getCompanyRecordings = async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page || 1, 10) || 1);
    const limit   = Math.min(Math.max(1, parseInt(req.query.limit || 100, 10) || 100), 1000);
    const company = req.callerCompany || req.user?.company;
    if (!company) return res.status(400).json({ message: 'Company not found in token' });
    const [recordings, total] = await Promise.all([
      MobileCallLog.find({ company, 'recordings.0': { $exists: true } })
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status')
        .populate('user', 'name email'),
      MobileCallLog.countDocuments({ company, 'recordings.0': { $exists: true } }),
    ]);
    res.json({ recordings, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/lead/:leadId ───────────────────────────────────────────
const getCallLogsForLead = async (req, res) => {
  try {
    const company = req.callerCompany || req.user?.company;
    const limit   = Math.min(Math.max(1, parseInt(req.query.limit || 20, 10) || 20), 1000);
    const logs = await MobileCallLog.find({ matchedLead: req.params.leadId, company })
      .sort({ timestamp: -1 }).limit(limit).populate('user', 'name email');
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/remark ────────────────────────────────────────────────
const saveRemark = async (req, res) => {
  try {
    const { phoneNumber, timestamp, remark, outcome } = req.body;
    if (!phoneNumber || !remark)
      return res.status(400).json({ message: 'phoneNumber and remark are required' });

    const ts = timestamp ? new Date(parseInt(timestamp)) : null;
    const updated = await MobileCallLog.findOneAndUpdate(
      { user: (req.user.userId || req.user._id), phoneNumber, ...(ts ? { timestamp: ts } : {}) },
      { $set: { remark: remark.trim(), ...(outcome ? { outcome } : {}) } },
      { sort: { timestamp: -1 }, new: true },
    );

    if (updated?.matchedLead) {
      try {
        const lead = await Lead.findById(updated.matchedLead);
        if (lead) {
          const refTime = updated.timestamp ? new Date(updated.timestamp).getTime() : null;
          let idx = -1;
          if (refTime) {
            let minDiff = Infinity;
            lead.callHistory.forEach((h, i) => {
              const diff = Math.abs(new Date(h.calledAt).getTime() - refTime);
              if (diff < minDiff && diff < 10 * 60 * 1000) { minDiff = diff; idx = i; }
            });
          } else {
            for (let i = lead.callHistory.length - 1; i >= 0; i--) {
              if (String(lead.callHistory[i].userId) === String((req.user.userId || req.user._id))) { idx = i; break; }
            }
          }
          if (idx >= 0) {
            lead.callHistory[idx].remark = remark.trim();
            if (outcome) lead.callHistory[idx].outcome = outcome;
            lead.markModified('callHistory');
            await lead.save();
          }

          // ── Auto-blast when mobile app marks the call outcome "Interested" ──
          // Same once-only guard as patchLead: atomically claim before sending.
          const _cust = await require('../services/customizationService').getCustomization(lead.company);
          const _oc = typeof outcome === 'string' ? require('../services/customizationService').findOutcome(_cust, outcome) : null;
          if (_oc ? _oc.behavior === 'interested' : (typeof outcome === 'string' && outcome.trim().toLowerCase() === 'interested')) {
            const blastCompanyId = lead.company?._id || lead.company || updated.company;
            if (blastCompanyId) {
              Lead.findOneAndUpdate(
                { _id: lead._id, $or: [{ interestedBlastSentAt: null }, { interestedBlastSentAt: { $exists: false } }] },
                { $set: { interestedBlastSentAt: new Date() } },
                { new: true }
              )
                .then(async (claimed) => {
                  if (!claimed) {
                    console.log(`[interestedBlast] Skipped — blast already sent for lead ${lead._id}`);
                    return;
                  }
                  const summary = await sendInterestedBlast(claimed, blastCompanyId);
                  // Lock only after at least one channel actually delivered;
                  // a fully failed/skipped blast releases the claim to retry.
                  const anySent = (summary || []).some((r) => r.status === 'sent');
                  if (!anySent) {
                    await Lead.updateOne(
                      { _id: lead._id },
                      { $set: { interestedBlastSentAt: null } }
                    ).catch(() => {});
                  }
                })
                .catch((err) =>
                  console.error('[interestedBlast] saveRemark trigger error:', err.message)
                );
            }
          }
        }
      } catch (e) { console.error('remark lead update error:', e.message); }
    }

    res.json({ message: 'Remark saved', log: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/all ────────────────────────────────────────────────────
const getCompanyAllLogs = async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page || 1, 10) || 1);
    const limit   = Math.min(Math.max(1, parseInt(req.query.limit || 200, 10) || 200), 1000);
    const company = req.callerCompany || req.user?.company;
    if (!company) return res.status(400).json({ message: 'Company not found in token' });

    const filter = { company };

    // ── Optional userId — scope to a single employee (used by admin drawer) ──
    // Without this, the limit applies company-wide and the employee's logs
    // could be cut off if other users filled the limit.
    if (req.query.userId) {
      filter.user = req.query.userId;
    }

    // ── Optional since — only return logs from this date onwards ──
    // Used with userId to exclude logs predating the employee's account creation
    // (prevents old device logs from a prior employee appearing).
    if (req.query.since) {
      const sinceDate = new Date(req.query.since);
      if (!isNaN(sinceDate.getTime())) {
        filter.timestamp = { $gte: sinceDate };
      }
    }

    const [logs, total] = await Promise.all([
      MobileCallLog.find(filter)
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status')
        .populate('user', 'name email'),
      MobileCallLog.countDocuments(filter),
    ]);
    res.json({ logs, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/summarize-unmatched ───────────────────────────────────
// Generates an AI summary for a non-lead call log entry using GPT.
// Body: { logId } — the MobileCallLog _id to summarize.
// Only works if the log has at least one recording with a transcript.
// If no transcript is available, returns a basic metadata-based summary.
const summarizeUnmatchedCall = async (req, res) => {
  try {
    const { logId } = req.body;
    if (!logId) return res.status(400).json({ message: 'logId is required' });

    const company = req.callerCompany || req.user?.company;
    const log = await MobileCallLog.findOne({ _id: logId, company });
    if (!log) return res.status(404).json({ message: 'Call log not found' });

    // Build a summary from metadata if no transcript exists
    const hasTranscript = log.recordings?.some(r => r.transcript);

    let summary;
    if (hasTranscript) {
      const { summarizeCallTranscript } = require('../utils/summarizeCall');
      // Combine all transcripts from this call
      const combinedTranscript = log.recordings
        .filter(r => r.transcript)
        .map(r => r.transcript)
        .join('\n\n---\n\n');
      summary = await summarizeCallTranscript(combinedTranscript, log.name || 'Unknown contact');
    } else {
      // No transcript — build a metadata-only summary
      const durMin  = Math.floor((log.duration || 0) / 60);
      const durSec  = (log.duration || 0) % 60;
      const durStr  = log.duration > 0 ? `${durMin > 0 ? durMin + 'm ' : ''}${durSec}s` : 'no duration recorded';
      const dateStr = log.timestamp ? new Date(log.timestamp).toLocaleDateString('en-IN') : 'unknown date';
      summary = {
        summary:       `${log.callType || 'Unknown'} call with ${log.phoneNumber} on ${dateStr}, lasting ${durStr}. This number is not in the CRM.`,
        keyPoints:     [
          `Call type: ${log.callType || 'unknown'}`,
          `Duration: ${durStr}`,
          log.name ? `Contact name on device: ${log.name}` : 'No contact name saved on device',
          'Number not matched to any CRM lead',
        ],
        sentiment:     'Neutral',
        nextAction:    'Review if this contact should be added as a lead.',
        suggestedTemp: null,
      };
    }

    // Persist the summary on the first recording (or create a placeholder recording)
    if (log.recordings?.length > 0) {
      log.recordings[0].summary = summary;
      if (!log.recordings[0].transcribeStatus || log.recordings[0].transcribeStatus === 'pending') {
        log.recordings[0].transcribeStatus = 'done';
      }
      log.markModified('recordings');
    } else {
      log.recordings = [{
        url:              '',
        name:             'auto-summary',
        uploadedAt:       new Date(),
        summary,
        transcribeStatus: 'done',
      }];
    }

    await log.save();
    res.json({ message: 'Summary generated', summary, log });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// ── GET /api/call-logs/uncalled ───────────────────────────────────────────────
// Returns leads assigned to this user that were NEVER called on the selected
// date AND have never been called at all since then (carry-forward rule):
//
//   "Not called on day X" means:
//     • Lead was assigned to this user on or BEFORE day X (createdAt <= dayEnd)
//     • Lead has NO callHistory entry with calledAt on day X
//
//   "Carry-forward" rule:
//     • If a lead was assigned on day X and not called on day X, it should
//       appear on day X+1, X+2, etc. until it IS called.
//     • Implementation: we query leads with callHistory completely empty OR
//       whose most recent callHistory.calledAt is BEFORE dayStart.
//       This means "never been called yet" OR "not called since before this day."
//       The frontend then shows these on the selected day regardless of when
//       the lead was created — so an uncalled lead from 3 days ago still shows
//       on today's "Not Called" section.
//
//   "Disappear" rule:
//     • Once any callHistory entry exists with calledAt >= dayStart, the lead
//       is considered called and drops off the "Not Called" list for that day.
//     • Closed leads (isClosed: true) and merged leads are excluded.
//
//  Query params:
//    date=YYYY-MM-DD  — the day to check (defaults to today)
//    tzOffset=330     — device UTC offset in minutes (IST = 330)
//    limit=200
//    page=1
const getUncalledLeads = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || 1, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || 200, 10) || 200), 1000);

    // FIX: use req.admin only (not req.callerCompany) — same fix as getCallLogs
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.user?.company;

    if (!company) return res.status(400).json({ message: 'Company not resolved' });

    // Compute day boundaries in device timezone (same logic as getCallLogs)
    const tzOffset = parseInt(req.query.tzOffset || '0', 10) || 0;
    let dayStart, dayEnd;

    if (req.query.date) {
      const [year, month, day] = req.query.date.split('-').map(Number);
      dayStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      dayStart.setUTCMinutes(dayStart.getUTCMinutes() - tzOffset);
      dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
    } else {
      const nowUTC = Date.now();
      const localMidnightMs = Math.floor((nowUTC + tzOffset * 60000) / 86400000) * 86400000 - tzOffset * 60000;
      dayStart = new Date(localMidnightMs);
      dayEnd   = new Date(localMidnightMs + 24 * 60 * 60 * 1000 - 1);
    }

    // ── Base filter ────────────────────────────────────────────────────────────
    // For an employee: their assigned leads only.
    // For admin: all company leads (admin oversight view).
    const baseFilter = {
      company,
      isClosed:   { $ne: true },
      mergedInto: null,
      // Lead must have been created/assigned on or before end of selected day
      // (a lead created tomorrow cannot be "uncalled today")
      createdAt: { $lte: dayEnd },
    };

    if (!isAdmin) {
      baseFilter.user = req.user.userId || req.user._id;
    }

    // ── "Not called" filter ────────────────────────────────────────────────────
    // A lead is "not called on/before dayEnd" when:
    //   1. callHistory is completely empty  →  never called at all
    //   2. Every callHistory entry's calledAt is BEFORE dayStart
    //      → was called before, but not on or after this day (= carry-forward
    //        from a previous day where the call happened but nothing recent)
    //
    // We use $or to combine these:
    //   $or: [
    //     { callHistory: { $size: 0 } },                      — never called
    //     { callHistory: { $not: { $elemMatch: { calledAt: { $gte: dayStart } } } } }
    //                                                          — no call on/after dayStart
    //   ]
    // The second condition absorbs the first (empty array matches $not $elemMatch),
    // so we just need the second condition:
    const uncalledFilter = {
      ...baseFilter,
      $nor: [
        { 'callHistory.calledAt': { $gte: dayStart } }
      ],
    };

    // ?search= — find ANY not-called lead by name / number / campaign, not just
    // the page the app happened to have loaded.
    const rawSearch = String(req.query.search || '').trim().slice(0, 60);
    if (rawSearch) {
      const esc = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const digits = rawSearch.replace(/\D/g, '');
      const ors = [
        { name: { $regex: esc, $options: 'i' } },
        { campaign: { $regex: esc, $options: 'i' } },
      ];
      if (digits.length >= 3) {
        ors.push({ normalizedPhone: { $regex: digits } });
        ors.push({ mobile: { $regex: digits } });
        ors.push({ primaryPhone: { $regex: digits } });
      }
      uncalledFilter.$and = [{ $or: ors }];
    }

    // Lead filters — newly assigned that day / campaign / ad set / ad (see utils/callDayFilters.js).
    // Merged with the search clause above, never replacing it.
    const leadFilters = parseLeadFilters(req.query);
    const filterConds = leadFilterConditions(leadFilters, dayStart, dayEnd);
    if (filterConds.length) uncalledFilter.$and = [...(uncalledFilter.$and || []), ...filterConds];

    const [leads, total] = await Promise.all([
      Lead.find(uncalledFilter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('_id name mobile primaryPhone status remark initialRemark temperature Quality campaign source createdAt callHistory.calledAt scheduledCalls date user activityTimeline.action activityTimeline.timestamp ' + LEAD_AD_FIELDS)
        .populate('user', 'name email')
        .lean(),
      Lead.countDocuments(uncalledFilter),
    ]);

    // Annotate each lead with useful computed fields
    const annotated = leads.map(lead => ({
      ...lead,
      callHistoryCount: (lead.callHistory || []).length,
      hasScheduledCalls: (lead.scheduledCalls || []).some(sc => !sc.done),
      pendingScheduledCalls: (lead.scheduledCalls || [])
        .filter(sc => sc && !sc.done && sc.scheduledAt)
        .map(sc => ({ scheduledAt: sc.scheduledAt, type: sc.type, note: sc.note }))
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)),
      // Days since created (so the agent knows how long this lead has been waiting)
      daysSinceAssigned: Math.floor((dayEnd - new Date(lead.createdAt)) / (24 * 60 * 60 * 1000)),
      // Newly assigned on the selected day (created that day, or assigned / re-assigned that day)
      assignedOnDay: wasAssignedOnDay(lead, dayStart, dayEnd),
      ad: adSummary(lead),
      activityTimeline: undefined,          // only needed to work out assignedOnDay — don't send the log to the phone
    }));

    res.json({ leads: annotated, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('[getUncalledLeads]', error.message);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/lead-filters ───────────────────────────────────────────
// Options for the Calls-by-Day pickers: every campaign → ad set → ad among the leads this screen can show for
// the selected day (the not-called leads + the leads called that day), each with a lead count, plus how many
// leads were newly assigned that day. If ?assigned=day is on, the options narrow to those leads too.
//   ?date=YYYY-MM-DD  ?tzOffset=330  [?assigned=day]
const getLeadFilterOptions = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const company = toObjectId(req.callerCompany || req.user?.company);
    if (!company) return res.status(400).json({ message: 'Company not resolved' });
    const selfId = toObjectId(req.user && (req.user._id || req.user.userId));      // ObjectId — it goes into an aggregation below
    const { dayStart, dayEnd } = dayBounds(req.query.date, req.query.tzOffset);
    const owner = isAdmin ? {} : { user: selfId };
    const assignedOnly = parseLeadFilters({ assigned: req.query.assigned });
    const extra = leadFilterConditions({ assigned: assignedOnly.assigned }, dayStart, dayEnd);

    const base = { company, isClosed: { $ne: true }, mergedInto: null, createdAt: { $lte: dayEnd }, ...owner };
    const uncalled = { ...base, $nor: [{ 'callHistory.calledAt': { $gte: dayStart } }], ...(extra.length ? { $and: extra } : {}) };
    const loggedIds = await MobileCallLog.distinct('matchedLead', {
      ...(isAdmin ? { company } : { user: selfId }),
      timestamp: { $gte: dayStart, $lte: dayEnd },
      matchedLead: { $ne: null },
    });
    const called = { company, ...owner, _id: { $in: loggedIds }, ...(extra.length ? { $and: extra } : {}) };
    const assignedAll = { ...base, $and: leadFilterConditions({ assigned: true }, dayStart, dayEnd) };

    const [a, b, assignedCount] = await Promise.all([
      Lead.aggregate([{ $match: uncalled }, groupStage()]),
      loggedIds.length ? Lead.aggregate([{ $match: called }, groupStage()]) : Promise.resolve([]),
      Lead.countDocuments(assignedAll),
    ]);
    res.json({ assignedCount, ...buildFilterTree([...a, ...b]) });
  } catch (error) {
    console.error('[getLeadFilterOptions]', error.message);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/my-history ─────────────────────────────────────────────
// Complete call log + talk time for ONE employee (the caller; admins may pass
// ?userId=). Query: from, to (ISO), type (incoming|outgoing|missed|rejected),
// search (name / number), leadsOnly=1, page, limit.
// Returns { summary, byDay[], logs[], total, page, pages }.
const getMyCallHistory = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.user?.company;
    const selfId  = req.user?.userId || req.user?._id;
    const userId  = isAdmin && req.query.userId ? req.query.userId : selfId;
    if (!userId || !mongoose.isValidObjectId(String(userId))) {
      return res.status(400).json({ message: 'Employee not resolved.' });
    }
    const uid = new mongoose.Types.ObjectId(String(userId));

    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 6 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: 'Invalid date range.' });
    }
    const base = { user: uid, timestamp: { $gte: from, $lte: to } };
    if (isAdmin && company) base.company = company;

    const listFilter = { ...base };
    const type = String(req.query.type || '');
    if (['incoming', 'outgoing', 'missed', 'rejected'].includes(type)) listFilter.callType = type;
    if (req.query.leadsOnly === '1') listFilter.matchedLead = { $ne: null };
    const q = String(req.query.search || '').trim().slice(0, 40);
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const digits = q.replace(/\D/g, '');
      listFilter.$or = [{ name: new RegExp(esc, 'i') }];
      if (digits.length >= 3) listFilter.$or.push({ phoneNumber: new RegExp(digits) }, { normalizedPhone: new RegExp(digits) });
    }

    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const tzMin = parseInt(req.query.tzOffset || '330', 10) || 0;
    const tz = `${tzMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, '0')}${String(Math.abs(tzMin) % 60).padStart(2, '0')}`;

    const [sumAgg, byDay, logs, total] = await Promise.all([
      MobileCallLog.aggregate([
        { $match: base },
        { $group: {
          _id: null,
          total:     { $sum: 1 },
          incoming:  { $sum: { $cond: [{ $eq: ['$callType', 'incoming'] }, 1, 0] } },
          outgoing:  { $sum: { $cond: [{ $eq: ['$callType', 'outgoing'] }, 1, 0] } },
          missed:    { $sum: { $cond: [{ $eq: ['$callType', 'missed'] }, 1, 0] } },
          rejected:  { $sum: { $cond: [{ $eq: ['$callType', 'rejected'] }, 1, 0] } },
          connected: { $sum: { $cond: [{ $gt: ['$duration', 0] }, 1, 0] } },
          talkSecs:  { $sum: { $ifNull: ['$duration', 0] } },
          inSecs:    { $sum: { $cond: [{ $eq: ['$callType', 'incoming'] }, { $ifNull: ['$duration', 0] }, 0] } },
          outSecs:   { $sum: { $cond: [{ $eq: ['$callType', 'outgoing'] }, { $ifNull: ['$duration', 0] }, 0] } },
          longest:   { $max: { $ifNull: ['$duration', 0] } },
          leads:     { $sum: { $cond: [{ $ifNull: ['$matchedLead', false] }, 1, 0] } },
          numbers:   { $addToSet: { $ifNull: ['$normalizedPhone', '$phoneNumber'] } },
          recorded:  { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$recordings', []] } }, 0] }, 1, 0] } },
        } },
        { $project: { _id: 0, uniqueNumbers: { $size: '$numbers' }, total: 1, incoming: 1, outgoing: 1, missed: 1, rejected: 1, connected: 1, talkSecs: 1, inSecs: 1, outSecs: 1, longest: 1, leads: 1, recorded: 1 } },
      ]),
      MobileCallLog.aggregate([
        { $match: base },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: tz } },
          calls: { $sum: 1 },
          talkSecs: { $sum: { $ifNull: ['$duration', 0] } },
          missed: { $sum: { $cond: [{ $eq: ['$callType', 'missed'] }, 1, 0] } },
        } },
        { $sort: { _id: -1 } },
      ]),
      MobileCallLog.find(listFilter)
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .select('phoneNumber name callType duration timestamp matchedLead remark recordings.url recordings.durationSec recordings.transcribeStatus')
        .populate('matchedLead', 'name status')
        .lean(),
      MobileCallLog.countDocuments(listFilter),
    ]);

    const summary = sumAgg[0] || { total: 0, incoming: 0, outgoing: 0, missed: 0, rejected: 0, connected: 0, talkSecs: 0, inSecs: 0, outSecs: 0, longest: 0, leads: 0, recorded: 0, uniqueNumbers: 0 };
    summary.avgSecs = summary.connected ? Math.round(summary.talkSecs / summary.connected) : 0;

    res.json({
      range: { from, to },
      summary,
      byDay: byDay.map((d) => ({ date: d._id, calls: d.calls, talkSecs: d.talkSecs, missed: d.missed })),
      logs, total, page, pages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getMyCallHistory,
  upload, syncCallLogs, getCallLogs, getTodayCallLogs,
  matchPhone, uploadRecording, logAppCall, getCompanyRecordings,
  getCompanyAllLogs, getCallLogsForLead, saveRemark,
  summarizeUnmatchedCall, getUncalledLeads, getLeadFilterOptions,
};
