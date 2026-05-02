// controllers/mobileCallLogController.js
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
        // ✅ FIX Bug #3: added callType to filter so two calls to the same number
        // at the same second (different type e.g. incoming vs missed) are not
        // collapsed into one document
        filter: {
          user:        doc.user,
          phoneNumber: doc.phoneNumber,
          timestamp:   doc.timestamp,
          callType:    doc.callType,
        },
        update: { $setOnInsert: doc },
        upsert: true,
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
// Accepts: callLogId (preferred) OR phoneNumber + timestamp (fallback)
// ✅ FIX Bug #1: was matching by phoneNumber alone — always hit the first call
//    for that number instead of the specific call the recording belongs to.
// ✅ FIX Bug #2: was using $set on a single String field — overwrote previous
//    recording. Now uses $push into recordings[] array so all uploads are kept.
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { phoneNumber, timestamp, callLogId } = req.body;

    // Build the filter — prefer _id match (most precise), fall back to
    // phoneNumber + timestamp (both must be present)
    let filter;
    if (callLogId) {
      filter = { _id: callLogId, user: req.user._id };
    } else if (phoneNumber && timestamp) {
      filter = {
        user:        req.user._id,
        phoneNumber: phoneNumber,
        timestamp:   new Date(parseInt(timestamp)),
      };
    } else {
      // Clean up the uploaded file since we won't use it
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        message: 'Provide either callLogId or both phoneNumber and timestamp',
      });
    }

    const newRecording = {
      url:        `/recordings/${req.file.filename}`,
      name:       req.file.originalname,
      size:       req.file.size,
      uploadedAt: new Date(),
    };

    // ✅ $push keeps all recordings — never overwrites an existing one
    const updated = await MobileCallLog.findOneAndUpdate(
      filter,
      { $push: { recordings: newRecording } },
      { new: true },  // do NOT upsert — recording must attach to existing call log
    );

    if (!updated) {
      // Clean up orphaned file
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({
        message: 'Call log not found. Sync call logs first before uploading a recording.',
      });
    }

    res.json({
      message:       'Recording uploaded',
      recordingId:   updated.recordings[updated.recordings.length - 1]._id,
      totalRecordings: updated.recordings.length,
      log:           updated,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── DELETE /api/call-logs/recording ──────────────────────────────────────────
// Bonus: lets mobile app delete a specific recording by its _id
const deleteRecording = async (req, res) => {
  try {
    const { callLogId, recordingId } = req.body;

    if (!callLogId || !recordingId) {
      return res.status(400).json({ message: 'callLogId and recordingId are required' });
    }

    const log = await MobileCallLog.findOne({ _id: callLogId, user: req.user._id });
    if (!log) return res.status(404).json({ message: 'Call log not found' });

    const recording = log.recordings.id(recordingId);
    if (!recording) return res.status(404).json({ message: 'Recording not found' });

    // Delete the physical file
    const filePath = path.join(__dirname, '../uploads', recording.url);
    fs.unlink(filePath, () => {});  // best-effort, don't block response

    // Remove from array
    await MobileCallLog.findByIdAndUpdate(
      callLogId,
      { $pull: { recordings: { _id: recordingId } } },
      { new: true },
    );

    res.json({ message: 'Recording deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { upload, syncCallLogs, getCallLogs, matchPhone, uploadRecording, deleteRecording };
