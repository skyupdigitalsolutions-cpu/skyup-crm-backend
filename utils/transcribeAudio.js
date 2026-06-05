// utils/transcribeAudio.js
// ── Dual-engine transcription ─────────────────────────────────────────────────
//   • Sarvam AI  → mixed / Indic audio  (auto-detects hi/kn/ta/te/ml/mr/gu/bn)
//     Uses /speech-to-text (NOT /speech-to-text-translate) so Hindi stays as
//     Hinglish romanisation, e.g. "mein apka kya help kar sakta hu" not
//     "how can I help you"
//   • Groq Whisper large-v3 → purely English audio  (free tier)
//
// Sarvam limit: 30 s per request → audio is chunked with ffmpeg before upload.
// ─────────────────────────────────────────────────────────────────────────────

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execSync }   = require('child_process');
const axios          = require('axios');
const FormData       = require('form-data');

const GROQ_STT_URL   = 'https://api.groq.com/openai/v1/audio/transcriptions';
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';   // ← transcribe only, no translation
const WHISPER_MODEL  = 'whisper-large-v3';
const CHUNK_SECS     = 25; // stay under Sarvam's 30 s hard limit

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function downloadToTmp(url, suffix = '.mp3') {
  const tmpPath = path.join(os.tmpdir(), `stt_${Date.now()}${suffix}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(tmpPath, Buffer.from(response.data));
  return tmpPath;
}

function getAudioDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

function splitAudio(filePath, chunkSecs = CHUNK_SECS) {
  const duration = getAudioDuration(filePath);
  const chunks   = [];

  if (duration <= chunkSecs) {
    const out = path.join(os.tmpdir(), `chunk_${Date.now()}_0.wav`);
    execSync(`ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 "${out}"`, { stdio: 'pipe' });
    chunks.push(out);
    return chunks;
  }

  const numChunks = Math.ceil(duration / chunkSecs);
  console.log(`[Sarvam] Audio ${duration.toFixed(1)}s → ${numChunks} chunks of ${chunkSecs}s`);

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSecs;
    const out   = path.join(os.tmpdir(), `chunk_${Date.now()}_${i}.wav`);
    execSync(
      `ffmpeg -y -i "${filePath}" -ss ${start} -t ${chunkSecs} -ar 16000 -ac 1 "${out}"`,
      { stdio: 'pipe' }
    );
    chunks.push(out);
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// SARVAM ENGINE  (mixed / Indic, transcribe-only)
// ─────────────────────────────────────────────────────────────────────────────
// /speech-to-text response shape:
// {
//   transcript: string,          // romanised or native-script text
//   language_code: string,       // e.g. "hi-IN", "kn-IN"
//   time_stamps?: [              // present when with_timestamps=true
//     { start: number, end: number, word: string }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────

async function sarvamChunk(chunkPath, chunkIndex) {
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

  const form = new FormData();
  form.append('file', fs.createReadStream(chunkPath), {
    filename: path.basename(chunkPath),
    contentType: 'audio/wav',
  });
  // model: saarika:v2 is Sarvam's latest multilingual STT model
  form.append('model', 'saarika:v2.5');
  form.append('with_timestamps', 'true');
  // language_code: 'unknown' → auto-detect (hi-IN / kn-IN / ta-IN etc.)
  form.append('language_code', 'unknown');
  // script: 'roman' → output in Roman/Latin letters (Hinglish)
  // e.g. "kya kar raha hai" not "क्या कर रहा है"
  form.append('script', 'roman');

  try {
    const resp = await axios.post(SARVAM_STT_URL, form, {
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const data = resp.data;
    if (!data?.transcript) return '';

    const lang = data.language_code || 'unknown';
    console.log(`[Sarvam] Chunk ${chunkIndex}: lang=${lang}, chars=${data.transcript.length}`);
    console.log(`[Sarvam] Chunk ${chunkIndex} sample: ${data.transcript.slice(0, 80)}`);

    // Build timestamped lines using word-level timestamps if present
    // time_stamps is an array of { start, end, word }
    const offsetSecs = chunkIndex * CHUNK_SECS;

    if (Array.isArray(data.time_stamps) && data.time_stamps.length > 0) {
      // Group words into sentence-like segments (split on long pauses > 1 s)
      const lines   = [];
      let lineWords = [];
      let lineStart = data.time_stamps[0].start;

      for (let i = 0; i < data.time_stamps.length; i++) {
        const curr = data.time_stamps[i];
        const next = data.time_stamps[i + 1];
        lineWords.push(curr.word);
        // Start a new line on a gap > 1.2 s or at the very end
        const gap = next ? next.start - curr.end : Infinity;
        if (gap > 1.2 || !next) {
          lines.push(`[${formatTime(lineStart + offsetSecs)}] ${lineWords.join(' ').trim()}`);
          lineWords = [];
          if (next) lineStart = next.start;
        }
      }
      return lines.join('\n');
    }

    // Fallback: flat transcript with chunk offset marker
    return `[${formatTime(offsetSecs)}] ${data.transcript.trim()}`;

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Sarvam STT chunk ${chunkIndex} failed (${err.response?.status ?? 'network'}): ${detail}`);
  }
}

async function runSarvam(audioInput) {
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
  if (!SARVAM_API_KEY) throw new Error('SARVAM_API_KEY is not set in your environment variables.');

  let localPath;
  let needsCleanup = false;

  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const ext    = path.extname(new URL(audioInput).pathname) || '.mp3';
    localPath    = await downloadToTmp(audioInput, ext);
    needsCleanup = true;
  } else {
    localPath = audioInput;
  }

  let chunks = [];
  try {
    chunks = splitAudio(localPath, CHUNK_SECS);
  } finally {
    if (needsCleanup) fs.unlink(localPath, () => {});
  }

  const parts = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const part = await sarvamChunk(chunks[i], i);
      if (part) parts.push(part);
    }
  } finally {
    chunks.forEach(c => fs.unlink(c, () => {}));
  }

  const transcript = parts.join('\n');
  console.log(`[Sarvam] Final transcript (first 150 chars): ${transcript.slice(0, 150)}`);
  return { text: transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ ENGINE  (pure English)
// ─────────────────────────────────────────────────────────────────────────────

async function runGroqWhisper(audioInput) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set in your environment variables.');

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
  form.append('language', 'en');

  let data;
  try {
    const resp = await axios.post(GROQ_STT_URL, form, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Groq STT failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  if (!data?.text) throw new Error('Groq Whisper returned an empty transcription.');

  const segments   = data.segments || [];
  const transcript = segments.length > 0
    ? segments.map(seg => `[${formatTime(seg.start)}] ${seg.text.trim()}`).join('\n')
    : data.text.trim();

  console.log(`[Groq] Transcript (first 100 chars): ${transcript.slice(0, 100)}`);
  return { text: transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeAudio(audioInput, audioLang = 'mixed') {
  const lang = (audioLang || 'mixed').toLowerCase();
  if (lang === 'english') {
    console.log('[Transcription] Engine → Groq Whisper large-v3 (English)');
    return runGroqWhisper(audioInput);
  }
  console.log('[Transcription] Engine → Sarvam AI /speech-to-text (Hinglish/mixed, no translation)');
  return runSarvam(audioInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API  (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeTwilioRecording(recordingSid, options = {}) {
  const audioLang = options.audioLang || 'mixed';
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const tmpPath   = path.join(os.tmpdir(), `twilio_${recordingSid}.mp3`);

  const response = await axios.get(twilioUrl, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
  });
  fs.writeFileSync(tmpPath, response.data);

  try {
    const { text } = await transcribeAudio(tmpPath, audioLang);
    return { transcript: text };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

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

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };
