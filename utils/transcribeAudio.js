// utils/transcribeAudio.js
// ── Replaced AssemblyAI with ElevenLabs Scribe v2 ────────────────────────────
// Docs: https://elevenlabs.io/docs/speech-to-text

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SCRIBE_URL         = 'https://api.elevenlabs.io/v1/speech-to-text';

// ── Core ElevenLabs Scribe call ───────────────────────────────────────────────
// audioInput: local file path (string) OR a public URL (string)
async function runElevenLabsScribe(audioInput) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not set. Add it to your environment variables.');
  }

  let fileBuffer;
  let fileName;

  // If it's a URL, download first (same pattern as before for Twilio URLs)
  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const response = await axios.get(audioInput, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data);
    fileName   = 'audio.mp3';
  } else {
    // Local file path
    fileBuffer = fs.readFileSync(audioInput);
    fileName   = path.basename(audioInput);
  }

  // Build multipart/form-data request
  const FormData = require('form-data');
  const form     = new FormData();

  form.append('file', fileBuffer, { filename: fileName });

  // ── Language settings ──────────────────────────────────────────────────────
  // ElevenLabs Scribe v2 supports: hi (Hindi), kn (Kannada), te (Telugu),
  // ta (Tamil), en (English), and 90+ more.
  // Set to null / remove to enable auto-detection (recommended for mixed speech).
  // Examples:
  //   form.append('language_code', 'hi');   // Hindi only
  //   form.append('language_code', 'kn');   // Kannada only
  //   form.append('language_code', 'en');   // English only
  // For mixed / code-switch audio, omit language_code (auto-detect):
  // form.append('language_code', 'auto');  // or just don't append it

  form.append('model_id', 'scribe_v2');           // Use Scribe v2 (best accuracy)
  form.append('diarize', 'true');                 // Speaker identification (same as before)
  form.append('timestamps_granularity', 'word');  // Word-level timestamps

  const { data } = await axios.post(SCRIBE_URL, form, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // ElevenLabs returns: { text, words: [...], language_code, language_probability }
  if (!data || !data.text) {
    throw new Error('ElevenLabs Scribe returned an empty transcription.');
  }

  return {
    text: data.text.trim(),
    // No transcriptId needed — summarization now uses the raw text directly via Claude API
  };
}

// ── Transcribe a Twilio recording ─────────────────────────────────────────────
// Twilio URLs require HTTP Basic Auth — download first, then send to Scribe.
async function transcribeTwilioRecording(recordingSid) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const tmpPath   = path.join(os.tmpdir(), `twilio_${recordingSid}.mp3`);

  const response = await axios.get(twilioUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  fs.writeFileSync(tmpPath, response.data);

  try {
    const { text } = await runElevenLabsScribe(tmpPath);
    return { transcript: text };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Transcribe a mobile recording ─────────────────────────────────────────────
// relativeUrl may be:
//   "/recordings/userId_ts_file.mp3"   ← stored on server disk
//   "https://..."                        ← external URL (S3, CDN, Cloudinary, etc.)
//
// For external URLs, we still download then upload (Scribe requires multipart).
async function transcribeMobileRecording(relativeUrl) {
  // ── Case 1: Full external URL ─────────────────────────────────────────────
  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text } = await runElevenLabsScribe(relativeUrl);
    return { transcript: text };
  }

  // ── Case 2: Relative path on disk ─────────────────────────────────────────
  const clean      = (relativeUrl || '').replace(/^\/+/, '');
  const candidate1 = path.join(__dirname, '..', 'uploads', clean);
  const candidate2 = path.join(__dirname, '..', clean);

  let filePath;
  if (fs.existsSync(candidate1)) {
    filePath = candidate1;
  } else if (fs.existsSync(candidate2)) {
    filePath = candidate2;
  } else {
    throw new Error(
      `Recording file not found.\n  Tried: ${candidate1}\n  Tried: ${candidate2}\n  URL stored: ${relativeUrl}`
    );
  }

  const { text } = await runElevenLabsScribe(filePath);
  return { transcript: text };
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };
