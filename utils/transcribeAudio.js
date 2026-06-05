// utils/transcribeAudio.js
// ── Dual-engine transcription ─────────────────────────────────────────────────
//   • Sarvam AI  → mixed / Indic audio  (hi, kn, ta, te, ml, mr, gu, bn, pa, or)
//   • Groq Whisper large-v3 → purely English audio
//
// The caller passes  audioLang: 'english' | 'mixed'  (or omits it → 'mixed')
// ─────────────────────────────────────────────────────────────────────────────

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const axios    = require('axios');
const FormData = require('form-data');

// ── API endpoints ─────────────────────────────────────────────────────────────
const GROQ_STT_URL    = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const SARVAM_STT_URL  = 'https://api.sarvam.ai/speech-to-text-translate';

// ── Model constants ───────────────────────────────────────────────────────────
const WHISPER_MODEL   = 'whisper-large-v3';
const CHAT_MODEL      = 'llama-3.1-8b-instant';

// ─────────────────────────────────────────────────────────────────────────────
// GROQ ENGINE  (pure English)
// ─────────────────────────────────────────────────────────────────────────────

async function runGroqWhisper(audioInput) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set in your environment variables.');
  }

  let fileBuffer, fileName;

  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const response = await axios.get(audioInput, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data);
    fileName   = 'audio.mp3';
  } else {
    fileBuffer = fs.readFileSync(audioInput);
    fileName   = path.basename(audioInput);
  }

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName });
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('language', 'en'); // force English for speed + accuracy

  let data;
  try {
    const resp = await axios.post(GROQ_STT_URL, form, {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Groq STT failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  if (!data?.text) throw new Error('Groq Whisper returned an empty transcription.');

  const segments = data.segments || [];
  let transcript = '';

  if (segments.length > 0) {
    transcript = segments
      .map(seg => `[${formatTime(seg.start)}] ${seg.text.trim()}`)
      .join('\n');
  } else {
    transcript = data.text.trim();
  }

  console.log(`[Groq] English transcript (first 100 chars): ${transcript.slice(0, 100)}`);
  return { text: transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// SARVAM AI ENGINE  (mixed / Indic)
// ─────────────────────────────────────────────────────────────────────────────
// Uses  /speech-to-text-translate  endpoint which:
//   • Auto-detects Indian languages (hi, kn, ta, te, ml, mr, gu, bn, pa, or)
//   • Returns transcript already translated to English
//   • Handles code-switched (Hinglish / Kanglish etc.) audio natively
//
// Sarvam accepts: wav, mp3, ogg, flac, aac, opus — max 25 MB / 5 min per chunk.
// ─────────────────────────────────────────────────────────────────────────────

async function runSarvam(audioInput) {
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
  if (!SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY is not set in your environment variables.');
  }

  let fileBuffer, fileName;

  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const response = await axios.get(audioInput, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data);
    // Preserve original extension; default to mp3
    const urlPath = new URL(audioInput).pathname;
    fileName = path.basename(urlPath) || 'audio.mp3';
  } else {
    fileBuffer = fs.readFileSync(audioInput);
    fileName   = path.basename(audioInput);
  }

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName });
  // with_timestamps=true gives segment-level timestamps in the response
  form.append('with_timestamps', 'true');
  // with_diarization — set to true if you want speaker labels (optional)
  form.append('with_diarization', 'false');

  let data;
  try {
    const resp = await axios.post(SARVAM_STT_URL, form, {
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Sarvam STT failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  // Sarvam response shape:
  // { transcript: string, language_code: string, timestamps?: [...] }
  if (!data?.transcript) {
    throw new Error('Sarvam AI returned an empty transcription.');
  }

  const detectedLang = data.language_code || 'unknown';
  console.log(`[Sarvam] Detected language: ${detectedLang}`);

  // Build timestamped transcript if timestamps are available
  let transcript = '';
  if (Array.isArray(data.timestamps) && data.timestamps.length > 0) {
    transcript = data.timestamps
      .map(seg => `[${formatTime(seg.start)}] ${seg.transcript?.trim() || ''}`)
      .filter(line => line)
      .join('\n');
  }
  // Fall back to flat transcript
  if (!transcript) {
    transcript = data.transcript.trim();
  }

  console.log(`[Sarvam] Transcript (first 100 chars): ${transcript.slice(0, 100)}`);
  return { text: transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER — picks engine based on audioLang hint
// ─────────────────────────────────────────────────────────────────────────────
//
//   audioLang = 'english'  → Groq Whisper large-v3  (fast, free tier)
//   audioLang = 'mixed'    → Sarvam AI               (Indic + code-switched)
//   audioLang = undefined  → defaults to 'mixed'     (safe default for India)
//
async function transcribeAudio(audioInput, audioLang = 'mixed') {
  const lang = (audioLang || 'mixed').toLowerCase();

  if (lang === 'english') {
    console.log('[Transcription] Engine: Groq Whisper large-v3 (English)');
    return runGroqWhisper(audioInput);
  }

  console.log('[Transcription] Engine: Sarvam AI (mixed/Indic)');
  return runSarvam(audioInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API  (kept backward-compatible with existing controller calls)
// ─────────────────────────────────────────────────────────────────────────────

// Twilio recording — audioLang passed via options (default: 'mixed')
async function transcribeTwilioRecording(recordingSid, options = {}) {
  const audioLang = options.audioLang || 'mixed';
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
    const { text } = await transcribeAudio(tmpPath, audioLang);
    return { transcript: text };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// Mobile recording — audioLang passed via options (default: 'mixed')
async function transcribeMobileRecording(relativeUrl, options = {}) {
  const audioLang = options.audioLang || 'mixed';

  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text } = await transcribeAudio(relativeUrl, audioLang);
    return { transcript: text };
  }

  const clean      = (relativeUrl || '').replace(/^\/+/, '');
  const candidate1 = path.join(__dirname, '..', 'uploads', clean);
  const candidate2 = path.join(__dirname, '..', clean);

  let filePath;
  if (fs.existsSync(candidate1))      filePath = candidate1;
  else if (fs.existsSync(candidate2)) filePath = candidate2;
  else throw new Error(
    `Recording file not found.\n  Tried: ${candidate1}\n  Tried: ${candidate2}\n  URL stored: ${relativeUrl}`
  );

  const { text } = await transcribeAudio(filePath, audioLang);
  return { transcript: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };
