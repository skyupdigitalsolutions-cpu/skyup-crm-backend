// backend/controllers/mobileCallLogController.js
const MobileCallLog = require('../models/MobileCallLog');
const Lead          = require('../models/Leads');
const path          = require('path');
const fs            = require('fs');
const multer        = require('multer');

// ── Multer storage for recordings ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/recordings');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts   = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${req.user._id}_${ts}_${safe}`);
  },
});

const allowedMimes = [
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav',
  'audio/amr', 'audio/3gpp', 'audio/ogg', 'audio/x-m4a',
];

const upload = multer({
  storage,
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
// KEY FIX: Also pushes new call entries into lead.callHistory[] so the
// Leads page and ReportPage reflect all mobile calls immediately.
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

    // Upsert into MobileCallLog
    const ops = docs.map(({ _leadObj, ...doc }) => ({
      updateOne: {
        filter: { user: doc.user, phoneNumber: doc.phoneNumber, timestamp: doc.timestamp },
        update:  { $setOnInsert: doc },
        upsert:  true,
      },
    }));
    const result = await MobileCallLog.bulkWrite(ops);

    // Push new entries into lead.callHistory[] (deduped by timestamp)
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
const getCallLogs = async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 50);
    const [logs, total] = await Promise.all([
      MobileCallLog.find({ user: req.user._id })
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status'),
      MobileCallLog.countDocuments({ user: req.user._id }),
    ]);
    res.json({ logs, page, total, totalPages: Math.ceil(total / limit) });
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
// Uploads a recording and links it to both MobileCallLog and lead.callHistory
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { phoneNumber, timestamp, remark } = req.body;
    const fileUrl = `/recordings/${req.file.filename}`;
    const ts = timestamp ? new Date(parseInt(timestamp)) : null;

    const updated = await MobileCallLog.findOneAndUpdate(
      { user: req.user._id, phoneNumber, ...(ts && { timestamp: ts }) },
      { $set: { recordingUrl: fileUrl, recordingName: req.file.originalname, recordingSize: req.file.size, ...(remark ? { remark: remark.trim() } : {}) } },
      { upsert: true, new: true, sort: { timestamp: -1 } },
    );

    // Update matching lead callHistory entry with recording info
    if (updated.matchedLead) {
      try {
        const lead = await Lead.findById(updated.matchedLead);
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
            lead.callHistory[idx].recordingUrl  = fileUrl;
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
// Admin: all recordings for the company (used by ReportPage)
const getCompanyRecordings = async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 100);
    const [recordings, total] = await Promise.all([
      MobileCallLog.find({ company: req.user.company, recordingUrl: { $ne: null } })
        .sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('matchedLead', 'name mobile status')
        .populate('user', 'name email'),
      MobileCallLog.countDocuments({ company: req.user.company, recordingUrl: { $ne: null } }),
    ]);
    res.json({ recordings, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/lead/:leadId ───────────────────────────────────────────
// All mobile call logs for a specific lead (for lead detail view)
const getCallLogsForLead = async (req, res) => {
  try {
    const logs = await MobileCallLog.find({ matchedLead: req.params.leadId, company: req.user.company })
      .sort({ timestamp: -1 }).populate('user', 'name email');
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/remark ────────────────────────────────────────────────
// Mobile app posts a remark/outcome after a call
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

module.exports = { upload, syncCallLogs, getCallLogs, matchPhone, uploadRecording, getCompanyRecordings, getCallLogsForLead, saveRemark };
