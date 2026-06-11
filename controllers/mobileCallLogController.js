// backend/controllers/mobileCallLogController.js
// FIX 4C: syncCallLogs() — eliminated N+1 query pattern.
//         Previously: findLeadByPhone() was called once per log entry,
//         each call loading ALL company leads from MongoDB.
//         100 logs = 100 full collection scans.
//         Now: load all company leads ONCE, build a phone-number Map,
//         then do O(1) Map lookups inside the loop. 1 DB call total.

const MobileCallLog = require('../models/MobileCallLog');
const Lead          = require('../models/Leads');
const multer        = require('multer');
const { normalizePhone } = require('../utils/normalizePhone');

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
    public_id:       `${req.user._id}_${Date.now()}`,
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
  'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'video/mp4',
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
const syncCallLogs = async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs) || logs.length === 0)
      return res.status(400).json({ message: 'No logs provided' });

    // ── Company-level call-log sync gate ─────────────────────────────────────
    // Super admin can disable device call-log sync per company.
    const Company = require('../models/Company');
    const company = await Company.findById(req.user.company)
      .select('callLogSyncEnabled')
      .lean();
    if (company && company.callLogSyncEnabled === false) {
      return res.status(403).json({
        message: 'Device call-log sync is disabled for your company.',
        code:    'call_log_sync_disabled',
      });
    }

    const batch = logs.slice(0, 500);

    // ── Load all company leads ONCE, build phone Maps (primary + secondary) ──
    const companyLeads = await Lead.find(
      { company: req.user.company },
      { mobile: 1, primaryPhone: 1, secondaryPhone: 1, normalizedPhone: 1, normalizedSecondaryPhone: 1, _id: 1, name: 1, status: 1 }
    ).lean();

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
        user:              req.user._id,
        company:           req.user.company,
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

    const leadUpdates = new Map();
    for (const doc of docs) {
      if (!doc._leadObj?._id) continue;
      const id = String(doc._leadObj._id);
      if (!leadUpdates.has(id)) leadUpdates.set(id, []);
      const dur = doc.duration;
      const min = Math.floor(dur / 60), sec = dur % 60;
      const durStr = dur > 0 ? ` (${min > 0 ? min + 'm ' : ''}${sec}s)` : '';
      leadUpdates.get(id).push({
        userId:   req.user._id,
        userName: req.user.name || 'Mobile App',
        remark:   `${callTypeToOutcome(doc.callType)} from mobile app${durStr}`,
        outcome:  callTypeToOutcome(doc.callType),
        calledAt: doc.timestamp,
        calledNumber: doc.phoneNumber || null,
        numberType:   doc.matchedNumberType || 'Primary',
      });
    }

    let callHistoryPushCount = 0;
    for (const [leadId, entries] of leadUpdates) {
      try {
        const lead = await Lead.findById(leadId).lean();
        if (!lead) continue;
        const existing = new Set((lead.callHistory || []).map(h => new Date(h.calledAt).getTime()));
        const newEntries = entries.filter(e => !existing.has(new Date(e.calledAt).getTime()));
        if (newEntries.length > 0) {
          await Lead.findByIdAndUpdate(leadId, { $push: { callHistory: { $each: newEntries } } });
          callHistoryPushCount += newEntries.length;
        }
      } catch (e) {
        console.error('callHistory push error for lead', leadId, e.message);
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
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 50);

    const filter = { user: req.user._id };
    if (req.query.date) {
      const dayStart = new Date(req.query.date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      filter.timestamp = { $gte: dayStart, $lt: dayEnd };
    }

    const [logs, total] = await Promise.all([
      MobileCallLog.find(filter)
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status'),
      MobileCallLog.countDocuments(filter),
    ]);
    res.json({ logs, page, total, totalPages: Math.ceil(total / limit) });
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
    // Determine date window
    const dateParam = req.query.date;
    let dayStart, dayEnd;
    if (dateParam) {
      dayStart = new Date(dateParam); dayStart.setHours(0, 0, 0, 0);
      dayEnd   = new Date(dateParam); dayEnd.setHours(23, 59, 59, 999);
    } else {
      const now = new Date();
      dayStart  = new Date(now); dayStart.setHours(0, 0, 0, 0);
      dayEnd    = new Date(now); dayEnd.setHours(23, 59, 59, 999);
    }

    const isAdmin = !!(req.admin || req.callerCompany);
    const company = req.callerCompany || req.user?.company;

    let filter;
    if (isAdmin) {
      // Admin: scope by company so ALL agents' logs are merged
      if (!company) return res.status(400).json({ message: 'Company not resolved for admin token' });
      filter = { company, timestamp: { $gte: dayStart, $lte: dayEnd } };
      // Optional drill-down: ?userId=<agentId>
      if (req.query.userId) filter.user = req.query.userId;
    } else {
      // Regular agent: only their own logs
      filter = { user: req.user._id, timestamp: { $gte: dayStart, $lte: dayEnd } };
    }

    const logs = await MobileCallLog.find(filter)
      .sort({ timestamp: -1 })
      .populate('matchedLead', 'name mobile status')
      .populate('user', 'name email');

    res.json({
      logs,
      date:    (dateParam || new Date().toISOString()).slice(0, 10),
      count:   logs.length,
      scoped:  isAdmin ? 'company' : 'user',
    });
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
    const companyId  = req.user.company;

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
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { phoneNumber, timestamp, remark, leadId, fileKey } = req.body;
    const fileUrl = req.file.path || req.file.secure_url || req.file.url;
    const ts = timestamp ? new Date(parseInt(timestamp)) : null;

    let resolvedLeadId = null;
    if (leadId) {
      const lead = await Lead.findOne({ _id: leadId, company: req.user.company });
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
        user:    req.user._id,
        company: req.user.company,
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
      { user: req.user._id, company: req.user.company, phoneNumber },
      {
        $push: { recordings: newRecording },
        $set: {
          company:  req.user.company,
          user:     req.user._id,
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
              if (String(lead.callHistory[i].userId) === String(req.user._id)) { idx = i; break; }
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
    const page    = parseInt(req.query.page  || 1);
    const limit   = parseInt(req.query.limit || 100);
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
    const limit   = parseInt(req.query.limit || 20);
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
      { user: req.user._id, phoneNumber, ...(ts ? { timestamp: ts } : {}) },
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
              if (String(lead.callHistory[i].userId) === String(req.user._id)) { idx = i; break; }
            }
          }
          if (idx >= 0) {
            lead.callHistory[idx].remark = remark.trim();
            if (outcome) lead.callHistory[idx].outcome = outcome;
            lead.markModified('callHistory');
            await lead.save();
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
    const page    = parseInt(req.query.page  || 1);
    const limit   = parseInt(req.query.limit || 200);
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

module.exports = {
  upload, syncCallLogs, getCallLogs, getTodayCallLogs,
  matchPhone, uploadRecording, getCompanyRecordings,
  getCompanyAllLogs, getCallLogsForLead, saveRemark,
  summarizeUnmatchedCall,
};