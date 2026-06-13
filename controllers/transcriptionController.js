// controllers/transcriptionController.js

const MobileCallLog = require('../models/MobileCallLog');
const {
  transcribeMobileRecording,
} = require('../utils/transcribeAudio');
const { summarizeCallTranscript, combineLeadSummaries } = require('../utils/summarizeCall');
const Lead = require('../models/Leads');
const {
  getCompanyEntitlements,
  getRemainingUsage,
  consumeUsage,
} = require('../services/entitlementService');

// ── Helper: run full pipeline ─────────────────────────────────────────────────
// withSummary=false produces a transcript only (when the company lacks the
// aiSummary feature or has exhausted its summary quota). Transcription and
// AI Summary are independent features with independent monthly limits.
async function runPipeline(transcribeFn, contactName, withSummary = true) {
  const { transcript } = await transcribeFn();
  const summary = withSummary
    ? await summarizeCallTranscript(transcript, contactName)
    : null;
  return { transcript, summary };
}

// ── Helper: resolve caller from protectAny middleware ─────────────────────────
function getCaller(req) {
  if (req.admin) {
    return { isAdmin: true, company: req.admin.company?._id || req.admin.company };
  }
  return { isAdmin: false, userId: req.user._id, company: req.user.company };
}

// ── POST /api/transcription/mobile/:callLogId/:recordingId ────────────────────
// Body: { audioLang?: 'english' | 'mixed' }
// Enforces the monthly Call Transcription limit. If the company also has the
// AI Summary feature with remaining summary quota, a summary is generated and
// counted separately; otherwise only the transcript is produced.
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

    // ── Enforce monthly limits (transcription + optional summary) ─────────────
    const [ent, remaining] = await Promise.all([
      getCompanyEntitlements(caller.company),
      getRemainingUsage(caller.company),
    ]);

    if (remaining.transcriptions <= 0) {
      return res.status(429).json({
        message: 'Monthly call transcription limit reached. Upgrade your plan or buy a transcription add-on.',
        code: 'TRANSCRIPTION_LIMIT_REACHED',
        limit: remaining.limits?.transcriptions ?? ent.transcriptionsLimit,
        used:  remaining.used?.transcriptions ?? 0,
      });
    }

    // Generate a summary only if the company has the AI Summary feature AND
    // has summary quota left. Transcription proceeds regardless.
    const withSummary = !!ent.aiSummary && remaining.summaries > 0;

    recording.transcribeStatus = 'processing';
    await log.save({ validateBeforeSave: false });

    const contactName = log.name || 'the customer';
    const { transcript, summary } = await runPipeline(
      () => transcribeMobileRecording(recording.url, { audioLang }),
      contactName,
      withSummary,
    );

    recording.transcript       = transcript;
    if (summary) recording.summary = summary;
    recording.transcribeStatus = 'done';
    await log.save({ validateBeforeSave: false });

    // ── Consume usage (transcription always; summary only if produced) ────────
    await consumeUsage(caller.company, 'transcriptionsUsed', 1).catch(() => {});
    if (summary) await consumeUsage(caller.company, 'summariesUsed', 1).catch(() => {});

    res.json({
      message: 'Transcription complete',
      transcript,
      summary,
      summaryGenerated: !!summary,
      recordingId,
    });
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

    // ── Enforce monthly AI Summary limit ──────────────────────────────────────
    const remaining = await getRemainingUsage(caller.company);
    if (remaining.summaries <= 0) {
      return res.status(429).json({
        message: 'Monthly AI summary limit reached. Upgrade your plan or buy an AI summary add-on.',
        code: 'SUMMARY_LIMIT_REACHED',
        limit: remaining.limits?.summaries,
        used:  remaining.used?.summaries ?? 0,
      });
    }

    const combinedSummary = await combineLeadSummaries(summaries, lead.name);

    // Consume one summary unit for the combined-summary generation.
    await consumeUsage(caller.company, 'summariesUsed', 1).catch(() => {});

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
  transcribeMobileCall,
  getMobileTranscription,
  getLeadCombinedSummary,
};