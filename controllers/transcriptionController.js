// controllers/transcriptionController.js

const Call          = require('../models/Call');
const MobileCallLog = require('../models/MobileCallLog');
const {
  transcribeTwilioRecording,
  transcribeMobileRecording,
} = require('../utils/transcribeAudio');
const { summarizeCallTranscript, combineLeadSummaries } = require('../utils/summarizeCall');
const Lead = require('../models/Leads');

// ── Helper: run full pipeline ─────────────────────────────────────────────────
async function runPipeline(transcribeFn, contactName) {
  const { transcript } = await transcribeFn();
  const summary = await summarizeCallTranscript(transcript, contactName);
  return { transcript, summary };
}

// ── Helper: resolve caller from protectAny middleware ─────────────────────────
function getCaller(req) {
  if (req.admin) {
    return { isAdmin: true, company: req.admin.company?._id || req.admin.company };
  }
  return { isAdmin: false, userId: req.user._id, company: req.user.company };
}

// ── POST /api/transcription/twilio/:recordingSid ──────────────────────────────
// Body: { audioLang?: 'english' | 'mixed', contactName?: string }
const transcribeTwilioCall = async (req, res) => {
  const { recordingSid } = req.params;
  // 'mixed' is the safe default for India — handles Hindi/Kannada/Hinglish etc.
  const audioLang = req.body.audioLang || 'mixed';

  try {
    await Call.findOneAndUpdate({ recordingSid }, { transcribeStatus: 'processing' });
    const call = await Call.findOne({ recordingSid });
    const contactName = req.body.contactName || call?.contactName || 'the customer';

    const { transcript, summary } = await runPipeline(
      () => transcribeTwilioRecording(recordingSid, { audioLang }),
      contactName,
    );

    const updated = await Call.findOneAndUpdate(
      { recordingSid },
      { transcript, summary, transcribeStatus: 'done' },
      { new: true },
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
      transcript: call.transcript || null,
      summary:    call.summary    || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/transcription/mobile/:callLogId/:recordingId ────────────────────
// Body: { audioLang?: 'english' | 'mixed' }
const transcribeMobileCall = async (req, res) => {
  const { callLogId, recordingId } = req.params;
  const caller    = getCaller(req);
  const audioLang = req.body.audioLang || 'mixed';

  try {
    const query = caller.isAdmin
      ? { _id: callLogId, company: caller.company }
      : { _id: callLogId, user: caller.userId };

    const log = await MobileCallLog.findOne(query);
    if (!log) return res.status(404).json({ message: 'Call log not found' });

    const recording = log.recordings.id(recordingId);
    if (!recording) return res.status(404).json({ message: 'Recording not found' });

    recording.transcribeStatus = 'processing';
    await log.save({ validateBeforeSave: false });

    const contactName = log.name || 'the customer';
    const { transcript, summary } = await runPipeline(
      () => transcribeMobileRecording(recording.url, { audioLang }),
      contactName,
    );

    recording.transcript       = transcript;
    recording.summary          = summary;
    recording.transcribeStatus = 'done';
    await log.save({ validateBeforeSave: false });

    res.json({ message: 'Transcription complete', transcript, summary, recordingId });
  } catch (err) {
    console.error('[transcribeMobileCall] error:', err.message);
    try {
      const q = caller.isAdmin
        ? { _id: callLogId, company: caller.company }
        : { _id: callLogId, user: caller.userId };
      const log = await MobileCallLog.findOne(q);
      if (log) {
        const rec = log.recordings.id(recordingId);
        if (rec) { rec.transcribeStatus = 'failed'; await log.save({ validateBeforeSave: false }); }
      }
    } catch { /* ignore */ }
    res.status(500).json({ message: err.message || 'Transcription failed' });
  }
};

// ── GET /api/transcription/mobile/:callLogId/:recordingId ─────────────────────
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
      transcript: recording.transcript || null,
      summary:    recording.summary    || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/transcription/lead/:leadId/summary ───────────────────────────────
const getLeadCombinedSummary = async (req, res) => {
  const { leadId } = req.params;
  const caller = getCaller(req);

  try {
    const lead = await Lead.findOne({ _id: leadId, company: caller.company }).lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const logs = await MobileCallLog.find({ matchedLead: leadId, company: caller.company })
      .sort({ timestamp: 1 })
      .lean();

    const summaries = [];
    for (const log of logs) {
      for (const rec of log.recordings || []) {
        if (rec.transcribeStatus === 'done' && rec.summary) {
          summaries.push({ ...rec.summary, calledAt: log.timestamp || log.createdAt });
        }
      }
    }

    if (summaries.length === 0) {
      return res.json({
        leadId,
        leadName:        lead.name,
        totalCalls:      logs.length,
        summarizedCalls: 0,
        combinedSummary: null,
        message: 'No transcribed calls found for this lead. Transcribe some recordings first.',
      });
    }

    const combinedSummary = await combineLeadSummaries(summaries, lead.name);
    res.json({
      leadId,
      leadName:        lead.name,
      totalCalls:      logs.length,
      summarizedCalls: summaries.length,
      combinedSummary,
    });
  } catch (err) {
    console.error('[getLeadCombinedSummary] error:', err.message);
    res.status(500).json({ message: err.message || 'Failed to generate combined summary' });
  }
};

module.exports = {
  transcribeTwilioCall,
  getTwilioTranscription,
  transcribeMobileCall,
  getMobileTranscription,
  getLeadCombinedSummary,
};
