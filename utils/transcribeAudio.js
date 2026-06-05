// utils/transcribeAudio.js
// ── Dual-engine transcription ─────────────────────────────────────────────────
//   • ElevenLabs Scribe v2 → mixed / Indic / Hinglish audio
//     - No chunking needed (handles full-length files)
//     - Built-in diarization with detect_speaker_roles → auto-labels agent/customer
//     - 90+ languages, word-level timestamps
//   • Groq Whisper large-v3 → purely English audio (free tier)
//
// Routing: audioLang = 'english' → Groq | anything else → ElevenLabs
// ─────────────────────────────────────────────────────────────────────────────

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const axios        = require('axios');
const FormData     = require('form-data');

const GROQ_STT_URL      = 'https://api.groq.com/openai/v1/audio/transcriptions';
const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const WHISPER_MODEL     = 'whisper-large-v3';

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

// ─────────────────────────────────────────────────────────────────────────────
// ELEVENLABS ENGINE  (mixed / Indic / Hinglish)
// ─────────────────────────────────────────────────────────────────────────────
// Response shape (diarized):
// {
//   text: string,                    // full transcript
//   language_code: string,           // detected language
//   words: [
//     { text, start, end, type, speaker_id }
//   ]
// }
// speaker_id will be "agent" or "customer" when detect_speaker_roles=true
// ─────────────────────────────────────────────────────────────────────────────

async function runElevenLabs(audioInput) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set in your environment variables.');

  // Resolve to buffer + filename
  let fileBuffer, fileName;

  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const response = await axios.get(audioInput, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data);
    const urlPath = new URL(audioInput).pathname;
    fileName = path.basename(urlPath) || 'audio.mp3';
  } else {
    fileBuffer = fs.readFileSync(audioInput);
    fileName   = path.basename(audioInput);
  }

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName });
  form.append('model_id', 'scribe_v2');
  // diarize=true → separate speakers
  // detect_speaker_roles=true → auto-label as "agent" / "customer"
  form.append('diarize', 'true');
  form.append('detect_speaker_roles', 'true');
  form.append('timestamps_granularity', 'word');
  // tag_audio_events=false → skip [laughter] [music] tags in transcript
  form.append('tag_audio_events', 'false');

  let data;
  try {
    const resp = await axios.post(ELEVENLABS_STT_URL, form, {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`ElevenLabs STT failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  if (!data?.words || data.words.length === 0) {
    // Fall back to flat transcript if no word data
    return { text: data?.text?.trim() || '' };
  }

  const lang = data.language_code || 'unknown';
  console.log(`[ElevenLabs] Detected language: ${lang}`);
  console.log(`[ElevenLabs] Total words: ${data.words.length}`);

  // ── Build dialog from word-level speaker turns ──────────────────────────────
  // Group consecutive words by speaker_id into lines
  // speaker_id: "agent" → Employee, "customer" → Client, anything else → Speaker N
  const LABEL_MAP = { agent: 'Employee', customer: 'Client' };

  const lines    = [];
  let curSpeaker = null;
  let curWords   = [];
  let curStart   = 0;

  for (const word of data.words) {
    // Skip non-word tokens (spaces, punctuation events)
    if (word.type !== 'word') continue;

    const spk = word.speaker_id || 'unknown';

    if (spk !== curSpeaker) {
      // Flush previous turn
      if (curWords.length > 0) {
        const label = LABEL_MAP[curSpeaker] || `Speaker ${curSpeaker}`;
        lines.push(`[${formatTime(curStart)}] ${label}: ${curWords.join(' ').trim()}`);
      }
      curSpeaker = spk;
      curWords   = [word.text];
      curStart   = word.start || 0;
    } else {
      curWords.push(word.text);
    }
  }

  // Flush last turn
  if (curWords.length > 0) {
    const label = LABEL_MAP[curSpeaker] || `Speaker ${curSpeaker}`;
    lines.push(`[${formatTime(curStart)}] ${label}: ${curWords.join(' ').trim()}`);
  }

  const transcript = lines.join('\n');
  console.log(`[ElevenLabs] Transcript (first 200 chars): ${transcript.slice(0, 200)}`);
  return { text: transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ ENGINE  (pure English, free tier)
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
    console.log('[Transcription] Engine → Groq Whisper large-v3 (English, free)');
    return runGroqWhisper(audioInput);
  }
  console.log('[Transcription] Engine → ElevenLabs Scribe v2 (mixed/Indic, diarized)');
  return runElevenLabs(audioInput);
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
