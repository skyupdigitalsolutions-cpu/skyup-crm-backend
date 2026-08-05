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

const GROQ_STT_URL       = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const WHISPER_MODEL      = 'whisper-large-v3';
const ROMANIZE_MODEL     = 'llama-3.1-8b-instant'; // fast + free on Groq

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
// ROMANIZE  (convert native script → Roman/Latin phonetic via Groq LLM)
// ─────────────────────────────────────────────────────────────────────────────
// Converts any Devanagari/native script words to their Roman phonetic form.
// English words and structure ([00:00] Employee:) are preserved as-is.
// "ऐसा कुछ भी नहीं है"  →  "aisa kuch bhi nahi hai"
// "नहीं"                 →  "nahi"
// Uses llama-3.1-8b-instant on Groq (fast, free tier).
// ─────────────────────────────────────────────────────────────────────────────

async function romanizeTranscript(transcript) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.warn('[Romanize] GROQ_API_KEY not set — skipping romanization');
    return transcript;
  }

  // Quick check: if no non-ASCII characters exist, nothing to romanize
  if (!/[^-]/.test(transcript)) {
    console.log('[Romanize] No native script detected — skipping');
    return transcript;
  }

  const systemPrompt = `You are a phonetic transliteration engine.
Your ONLY job: convert any Devanagari, Kannada, Tamil, Telugu, Malayalam, Bengali, or other Indic script words into their Roman/Latin phonetic spelling.

STRICT RULES:
1. Keep ALL English words exactly as they are.
2. Keep ALL timestamps exactly as they are, e.g. [00:09] → [00:09]
3. Keep ALL speaker labels exactly as they are, e.g. "Employee:" → "Employee:"
4. Transliterate Indic script words phonetically — do NOT translate their meaning.
   Example: "नहीं" → "nahi"  (NOT "no")
   Example: "ऐसा कुछ भी नहीं है" → "aisa kuch bhi nahi hai"  (NOT "there is nothing like that")
   Example: "हाँ सर" → "haan sir"  (NOT "yes sir")
5. Output ONLY the converted transcript. No explanations, no preamble.`;

  try {
    const resp = await axios.post(GROQ_CHAT_URL, {
      model: ROMANIZE_MODEL,
      max_tokens: 4096,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: transcript },
      ],
    }, {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const romanized = resp.data?.choices?.[0]?.message?.content?.trim();
    if (!romanized) {
      console.warn('[Romanize] Empty response from Groq — returning original');
      return transcript;
    }
    console.log('[Romanize] Done. Sample:', romanized.slice(0, 150));
    return romanized;
  } catch (err) {
    console.error('[Romanize] Groq LLM error — returning original transcript:', err.message);
    return transcript; // never block the transcription if romanization fails
  }
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
    return { text: data?.text?.trim() || '', durationSec: 0 };
  }

  const lang = data.language_code || 'unknown';
  console.log(`[ElevenLabs] Detected language: ${lang}`);
  console.log(`[ElevenLabs] Total words: ${data.words.length}`);

  // ── Build dialog from word-level speaker turns ──────────────────────────────
  // ElevenLabs returns speaker_id as:
  //   "agent" / "customer"  → when detect_speaker_roles succeeds (best case)
  //   "speaker_0" / "speaker_1" → when role detection is uncertain (fallback)
  //
  // Strategy:
  //   1. If we see "agent"/"customer" labels → use them directly
  //   2. Otherwise → map by first-appearance order: first speaker = Employee, second = Client

  // Fixed role labels (ElevenLabs detect_speaker_roles output)
  const ROLE_MAP = { agent: 'Employee', customer: 'Client' };

  // Dynamic fallback map built on first-appearance order
  const dynamicMap   = {};   // e.g. { speaker_0: 'Employee', speaker_1: 'Client' }
  const ROLE_ORDER   = ['Employee', 'Client', 'Speaker 3', 'Speaker 4'];

  function resolveLabel(spk) {
    if (ROLE_MAP[spk]) return ROLE_MAP[spk];           // agent/customer → direct
    if (dynamicMap[spk]) return dynamicMap[spk];       // already assigned
    const role = ROLE_ORDER[Object.keys(dynamicMap).length] || `Speaker ${spk}`;
    dynamicMap[spk] = role;
    console.log(`[ElevenLabs] Speaker mapping: ${spk} → ${role}`);
    return role;
  }

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
        lines.push(`[${formatTime(curStart)}] ${resolveLabel(curSpeaker)}: ${curWords.join(' ').trim()}`);
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
    lines.push(`[${formatTime(curStart)}] ${resolveLabel(curSpeaker)}: ${curWords.join(' ').trim()}`);
  }

  const rawTranscript = lines.join('\n');
  console.log(`[ElevenLabs] Raw transcript (first 200 chars): ${rawTranscript.slice(0, 200)}`);

  // Audio duration = the end timestamp of the last spoken word (seconds).
  // Used for minute-based billing in the transcription controller.
  let durationSec = 0;
  for (const w of data.words) {
    if (typeof w.end === 'number' && w.end > durationSec) durationSec = w.end;
  }
  console.log(`[ElevenLabs] Audio duration: ${durationSec.toFixed(1)}s`);

  // Romanize any native-script (Devanagari etc.) words → Roman phonetic
  const transcript = await romanizeTranscript(rawTranscript);
  return { text: transcript, durationSec };
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

  // Groq verbose_json returns a top-level `duration` (seconds). Fall back to the
  // last segment's end time if it's missing. Used for minute-based billing.
  let durationSec = typeof data.duration === 'number' ? data.duration : 0;
  if (!durationSec && segments.length > 0) {
    durationSec = segments.reduce((m, s) => Math.max(m, s.end || 0), 0);
  }

  console.log(`[Groq] Transcript (first 100 chars): ${transcript.slice(0, 100)}`);
  console.log(`[Groq] Audio duration: ${durationSec.toFixed(1)}s`);
  return { text: transcript, durationSec };
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

async function transcribeMobileRecording(relativeUrl, options = {}) {
  const audioLang = options.audioLang || 'mixed';

  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text, durationSec } = await transcribeAudio(relativeUrl, audioLang);
    return { transcript: text, durationSec: durationSec || 0 };
  }

  // ── Directory-traversal guard ──────────────────────────────────────────────
  // Strip leading slashes, then normalise. After path.join, check that the
  // resolved path still sits inside the allowed directory. An attacker-crafted
  // URL like "../../etc/passwd" would escape the uploads folder without this.
  const clean = (relativeUrl || '').replace(/^\/+/, '');
  const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
  const fallbackRoot = path.resolve(__dirname, '..');

  const candidate1 = path.join(uploadsRoot, clean);
  const candidate2 = path.join(fallbackRoot, clean);

  // Resolved path MUST start with the allowed root — no escape via ../
  const safeCandidate1 = path.resolve(candidate1);
  const safeCandidate2 = path.resolve(candidate2);

  if (!safeCandidate1.startsWith(uploadsRoot + path.sep) &&
      !safeCandidate1.startsWith(uploadsRoot)) {
    throw new Error(`[Security] Directory traversal attempt blocked: "${relativeUrl}"`);
  }

  let filePath;
  if (fs.existsSync(safeCandidate1))      filePath = safeCandidate1;
  else if (fs.existsSync(safeCandidate2) &&
           safeCandidate2.startsWith(fallbackRoot + path.sep)) filePath = safeCandidate2;
  else throw new Error(
    `Recording file not found.\n  Tried: ${safeCandidate1}\n  Tried: ${safeCandidate2}\n  URL stored: ${relativeUrl}`
  );

  const { text, durationSec } = await transcribeAudio(filePath, audioLang);
  return { transcript: text, durationSec: durationSec || 0 };
}

module.exports = { transcribeMobileRecording };