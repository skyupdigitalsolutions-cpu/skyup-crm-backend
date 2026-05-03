// controllers/transcriptionController.js
// Handles AI transcription + summarization for:
//   • Twilio recordings (stored in Call model, audio fetched live from Twilio)
//   • Mobile recordings (stored in MobileCallLog.recordings[], audio on disk)

const Call        = require('../models/Call');
const MobileCallLog = require('../models/MobileCallLog');
const { transcribeTwilioRecording, transcribeMobileRecording } = require('../utils/transcribeAudio');
const { summarizeCallTranscript } = require('../utils/summarizeCall');

// ── Helper: run the full pipeline and return result ───────────────────────────
async function runPipeline(transcribeFn, contactName) {
  // 1. Transcribe audio → text
  const { transcript } = await transcribeFn();

  // 2. Summarize transcript → structured CRM data
  const summary = await summarizeCallTranscript(transcript, contactName);

  return { transcript, summary };
}

// ── POST /api/transcription/twilio/:recordingSid ──────────────────────────────
// Accessible by admin (uses protectAdmin in route)
// Body: optional { contactName }
const transcribeTwilioCall = async (req, res) => {
  const { recordingSid } = req.params;

  try {
    // Mark as processing
    await Call.findOneAndUpdate(
      { recordingSid },
      { transcribeStatus: 'processing' }
    );

    const call = await Call.findOne({ recordingSid });
    const contactName = req.body.contactName || call?.contactName || 'the customer';

    const { transcript, summary } = await runPipeline(
      () => transcribeTwilioRecording(recordingSid),
      contactName
    );

    // Persist results
    const updated = await Call.findOneAndUpdate(
      { recordingSid },
      {
        transcript,
        summary,
        transcribeStatus: 'done',
      },
      { new: true }
    );

    res.json({
      message:    'Transcription complete',
      transcript,
      summary,
      call:       updated,
    });
  } catch (err) {
    console.error('[transcribeTwilioCall] error:', err.message);

    // Mark as failed so the UI can show an error state
    await Call.findOneAndUpdate(
      { recordingSid },
      { transcribeStatus: 'failed' }
    ).catch(() => {});

    res.status(500).json({ message: err.message || 'Transcription failed' });
  }
};

// ── GET /api/transcription/twilio/:recordingSid ───────────────────────────────
// Poll endpoint — returns current transcript/summary without re-running
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
// Accessible by the owning user (uses protect in route)
const transcribeMobileCall = async (req, res) => {
  const { callLogId, recordingId } = req.params;

  try {
    // Find the call log and specific recording
    const log = await MobileCallLog.findOne({
      _id:  callLogId,
      user: req.user._id,         // scoped to the requesting user
    });

    if (!log) return res.status(404).json({ message: 'Call log not found' });

    const recording = log.recordings.id(recordingId);
    if (!recording) return res.status(404).json({ message: 'Recording not found' });

    // Mark as processing
    recording.transcribeStatus = 'processing';
    await log.save();

    const contactName = log.name || 'the customer';

    const { transcript, summary } = await runPipeline(
      () => transcribeMobileRecording(recording.url),
      contactName
    );

    // Persist results into the sub-document
    recording.transcript       = transcript;
    recording.summary          = summary;
    recording.transcribeStatus = 'done';
    await log.save();

    res.json({
      message:    'Transcription complete',
      transcript,
      summary,
      recordingId,
    });
  } catch (err) {
    console.error('[transcribeMobileCall] error:', err.message);

    // Best-effort: mark the recording as failed
    try {
      const log = await MobileCallLog.findOne({ _id: callLogId, user: req.user._id });
      if (log) {
        const rec = log.recordings.id(recordingId);
        if (rec) { rec.transcribeStatus = 'failed'; await log.save(); }
      }
    } catch { /* ignore */ }

    res.status(500).json({ message: err.message || 'Transcription failed' });
  }
};

// ── GET /api/transcription/mobile/:callLogId/:recordingId ─────────────────────
// Poll endpoint for mobile recording
const getMobileTranscription = async (req, res) => {
  try {
    const log = await MobileCallLog.findOne({
      _id:  req.params.callLogId,
      user: req.user._id,
    });
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