// backend/controllers/mobileCallLogController.js
// CommonJS — matches the rest of the backend (no "type": "module" in package.json)

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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'), false);
    }
  },
});

// ── Helper: normalize phone number for matching ───────────────────────────────
function normalizePhone(phone) {
  return String(phone).replace(/[\s\-\(\)\+]/g, '').slice(-10);
}

// ── Helper: find matching lead by phone ───────────────────────────────────────
async function findLeadByPhone(phoneNumber, companyId) {
  const normalized = normalizePhone(phoneNumber);
  const leads = await Lead.find({ company: companyId }).lean();
  return leads.find(lead => normalizePhone(lead.mobile || '') === normalized) || null;
}

// ── POST /api/call-logs/sync ──────────────────────────────────────────────────
const syncCallLogs = async (req, res) => {
  try {
    const { logs } = req.body;

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ message: 'No logs provided' });
    }

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
        };
      }),
    );

    const ops = docs.map(doc => ({
      updateOne: {
        filter: { user: doc.user, phoneNumber: doc.phoneNumber, timestamp: doc.timestamp },
        update:  { $setOnInsert: doc },
        upsert:  true,
      },
    }));

    const result = await MobileCallLog.bulkWrite(ops);

    res.json({
      message:  'Synced successfully',
      synced:   batch.length,
      inserted: result.upsertedCount,
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
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
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

    res.json({
      matched: true,
      leadId:  lead._id,
      name:    lead.name,
      status:  lead.status,
      mobile:  lead.mobile,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/call-logs/recording ─────────────────────────────────────────────
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { phoneNumber, timestamp } = req.body;
    const fileUrl = `/recordings/${req.file.filename}`;

    const updated = await MobileCallLog.findOneAndUpdate(
      {
        user:        req.user._id,
        phoneNumber: phoneNumber,
        ...(timestamp && { timestamp: new Date(timestamp) }),
      },
      {
        $set: {
          recordingUrl:  fileUrl,
          recordingName: req.file.originalname,
          recordingSize: req.file.size,
        },
      },
      { upsert: true, new: true },
    );

    res.json({ message: 'Recording uploaded', log: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { upload, syncCallLogs, getCallLogs, matchPhone, uploadRecording };