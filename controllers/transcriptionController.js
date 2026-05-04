// controllers/transcriptionController.js

const Call = require('../models/Call');
const MobileCallLog = require('../models/MobileCallLog');
const { transcribeTwilioRecording, transcribeMobileRecording } = require('../utils/transcribeAudio');
const { summarizeCallTranscript } = require('../utils/summarizeCall');

// ── Helper: run the full pipeline and return result ───────────────────────────
async function runPipeline(transcribeFn, contactName) {
  const { transcript } = await transcribeFn();
  const summary = await summarizeCallTranscript(transcript, contactName);
  return { transcript, summary };
}

// ── Helper: resolve caller identity from protectAny middleware ─────────────────
// Returns { userId, isAdmin, company } regardless of token type
function getCaller(req) {
  if (req.admin) {
    return {
      isAdmin:   true,
      company:   req.admin.company?._id || req.admin.company,
    };
  }
  return {
    isAdmin:  false,
    userId:   req.user._id,
    company:  req.user.company,
  };
}

// ── POST /api/transcription/twilio/:recordingSid ──────────────────────────────
const transcribeTwilioCall = async (req, res) => {
  const { recordingSid } = req.params;
  try {
    await Call.findOneAndUpdate({ recordingSid }, { transcribeStatus: 'processing' });
    const call = await Call.findOne({ recordingSid });
    const contactName = req.body.contactName || call?.contactName || 'the customer';
    const { transcript, summary } = await runPipeline(
      () => transcribeTwilioRecording(recordingSid),
      contactName
    );
    const updated = await Call.findOneAndUpdate(
      { recordingSid },
      { transcript, summary, transcribeStatus: 'done' },
      { new: true }
    );
    res.json({ message: 'Transcription complete', transcript, summary, call: updated });
  } catch (err) {
    console.error('[transcribeTwilioCall] error:', err.message);
    await Call.findOneAndUpdate({ recordingSid }, { transcribeStatus: 'failed' }).catch(() => {});
    res.status(500).json({ message: err.message || 'Transcription failed' });
  }
};

// ── GET /api/transcription/twilio/:recordingSid ───────────────────────────────
const getTwilioTranscription = async (req, res) => {
  try {
    const call = await Call.findOne({ recordingSid: req.params.recordingSid });
    if (!call) return res.status(404).json({ message: 'Recording not found' });
    res.json({
      transcribeStatus: call.transcribeStatus || 'pending',
      transcript:       call.transcript       || null,
      summary:          call.summary          || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/transcription/mobile/:callLogId/:recordingId ────────────────────
// FIX: Accepts both user and admin tokens (protectAny).
// Admin: can transcribe any recording in their company.
// User: can only transcribe their own recordings.
const transcribeMobileCall = async (req, res) => {
  const { callLogId, recordingId } = req.params;
  const caller = getCaller(req);

  try {
    // Build query — admin can access all company logs; user only their own
    const query = caller.isAdmin
      ? { _id: callLogId, company: caller.company }
      : { _id: callLogId, user: caller.userId };

    const log = await MobileCallLog.findOne(query);
    if (!log) return res.status(404).json({ message: 'Call log not found' });

    const recording = log.recordings.id(recordingId);
    if (!recording) return res.status(404).json({ message: 'Recording not found' });

    recording.transcribeStatus = 'processing';
    await log.save();

    const contactName = log.name || 'the customer';
    const { transcript, summary } = await runPipeline(
      () => transcribeMobileRecording(recording.url),
      contactName
    );

    recording.transcript       = transcript;
    recording.summary          = summary;
    recording.transcribeStatus = 'done';
    await log.save();

    res.json({ message: 'Transcription complete', transcript, summary, recordingId });
  } catch (err) {
    console.error('[transcribeMobileCall] error:', err.message);
    try {
      const caller2 = getCaller(req);
      const q = caller2.isAdmin
        ? { _id: callLogId, company: caller2.company }
        : { _id: callLogId, user: caller2.userId };
      const log = await MobileCallLog.findOne(q);
      if (log) {
        const rec = log.recordings.id(recordingId);
        if (rec) { rec.transcribeStatus = 'failed'; await log.save(); }
      }
    } catch { /* ignore */ }
    res.status(500).json({ message: err.message || 'Transcription failed' });
  }
};

// ── GET /api/transcription/mobile/:callLogId/:recordingId ─────────────────────
// FIX: Accepts both user and admin tokens (protectAny).
const getMobileTranscription = async (req, res) => {
  const caller = getCaller(req);
  try {
    const query = caller.isAdmin
      ? { _id: req.params.callLogId, company: caller.company }
      : { _id: req.params.callLogId, user: caller.userId };

    const log = await MobileCallLog.findOne(query);
    if (!log) return res.status(404).json({ message: 'Call log not found' });

    const recording = log.recordings.id(req.params.recordingId);
    if (!recording) return res.status(404).json({ message: 'Recording not found' });

    res.json({
      transcribeStatus: recording.transcribeStatus || 'pending',
      transcript:       recording.transcript       || null,
      summary:          recording.summary          || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  transcribeTwilioCall,
  getTwilioTranscription,
  transcribeMobileCall,
  getMobileTranscription,
};
