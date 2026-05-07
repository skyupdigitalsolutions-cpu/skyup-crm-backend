// backend/controllers/mobileCallLogController.js
// CHANGE: Added getTodayCallLogs() — returns only today's logs for the mobile app.
//         Added ?date= filter to getCallLogs() so mobile can request a specific day.
//         Sync endpoint unchanged — backend still stores all logs permanently.
//         Mobile app should only SEND today's logs (enforced in backgroundSyncService).

const MobileCallLog = require('../models/MobileCallLog');
const Lead          = require('../models/Leads');
const multer        = require('multer');

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
    resource_type:   'video',
    public_id:       `${req.user._id}_${Date.now()}`,
    allowed_formats: ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus'],
  }),
});

const allowedMimes = [
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav',
  'audio/amr', 'audio/3gpp', 'audio/ogg', 'audio/x-m4a',
];

const upload = multer({
  storage: cloudinaryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only audio files are allowed'), false);
  },
});

function normalizePhone(phone) {
  return String(phone).replace(/[\s\-\(\)\+]/g, '').slice(-10);
}

async function findLeadByPhone(phoneNumber, companyId) {
  const normalized = normalizePhone(phoneNumber);
  const leads = await Lead.find({ company: companyId }).lean();
  return leads.find(lead => normalizePhone(lead.mobile || '') === normalized) || null;
}

function callTypeToOutcome(callType) {
  const map = {
    incoming: 'Incoming Call', outgoing: 'Outgoing Call',
    missed:   'Missed Call',   rejected: 'Rejected',
    blocked:  'Blocked',       voicemail:'Voicemail', unknown: 'Call',
  };
  return map[callType] || 'Call';
}

// ── POST /api/call-logs/sync ──────────────────────────────────────────────────
// No change — backend always stores permanently. Mobile app is responsible for
// only sending today's logs (see backgroundSyncService LOOKBACK_MS change).
const syncCallLogs = async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs) || logs.length === 0)
      return res.status(400).json({ message: 'No logs provided' });

    const batch = logs.slice(0, 500);

    const docs = await Promise.all(
      batch.map(async (log) => {
        const matchedLead = await findLeadByPhone(log.phoneNumber, req.user.company);
        return {
          user:        req.user._id,
          company:     req.user.company,
          phoneNumber: log.phoneNumber,
          callType:    log.callType || 'unknown',
          duration:    parseInt(log.duration || 0),
          timestamp:   new Date(parseInt(log.timestamp)),
          name:        log.name || '',
          matchedLead: matchedLead?._id || null,
          _leadObj:    matchedLead || null,
        };
      }),
    );

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
// CHANGE: Added optional ?date=YYYY-MM-DD query param.
//         Mobile app uses this to fetch a specific day's logs.
//         Admin/web dashboard omits ?date to get paginated full history.
const getCallLogs = async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 50);

    // NEW: if ?date=YYYY-MM-DD is provided, restrict to that day (IST midnight → midnight)
    const filter = { user: req.user._id };
    if (req.query.date) {
      const dayStart = new Date(req.query.date);          // e.g. 2026-05-07T00:00:00.000Z
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
// NEW ENDPOINT — mobile app calls this on screen mount instead of fetching
// all historical logs. Returns only today's logs, no pagination needed.
const getTodayCallLogs = async (req, res) => {
  try {
    const now      = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(now); dayEnd.setHours(23, 59, 59, 999);

    const logs = await MobileCallLog.find({
      user:      req.user._id,
      timestamp: { $gte: dayStart, $lte: dayEnd },
    })
      .sort({ timestamp: -1 })
      .populate('matchedLead', 'name mobile status');

    res.json({ logs, date: now.toISOString().slice(0, 10), count: logs.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/match?phone=XXXXXXXXXX ─────────────────────────────────
const matchPhone = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ message: 'phone query param required' });
    const lead = await findLeadByPhone(phone, req.user.company);
    if (!lead) return res.json({ matched: false });
    res.json({ matched: true, leadId: lead._id, name: lead.name, status: lead.status, mobile: lead.mobile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/recording ─────────────────────────────────────────────
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { phoneNumber, timestamp, remark, leadId } = req.body;
    const fileUrl = req.file.path || req.file.secure_url || req.file.url;
    const ts = timestamp ? new Date(parseInt(timestamp)) : null;

    let resolvedLeadId = null;
    if (leadId) {
      const lead = await Lead.findOne({ _id: leadId, company: req.user.company });
      if (lead) resolvedLeadId = lead._id;
    }

    const newRecording = {
      url:  fileUrl,
      name: req.file.originalname,
      size: req.file.size,
      uploadedAt: new Date(),
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
    const logs = await MobileCallLog.find({ matchedLead: req.params.leadId, company })
      .sort({ timestamp: -1 }).populate('user', 'name email');
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
    const [logs, total] = await Promise.all([
      MobileCallLog.find({ company })
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status')
        .populate('user', 'name email'),
      MobileCallLog.countDocuments({ company }),
    ]);
    res.json({ logs, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  upload, syncCallLogs, getCallLogs, getTodayCallLogs,
  matchPhone, uploadRecording, getCompanyRecordings,
  getCompanyAllLogs, getCallLogsForLead, saveRemark,
};
