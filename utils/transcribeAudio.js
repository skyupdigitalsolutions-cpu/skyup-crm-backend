// utils/transcribeAudio.js
// ── Dual-engine transcription ─────────────────────────────────────────────────
//   • Sarvam AI (Saaras v3, Batch API) → mixed / Indic / Hinglish audio
//     - FIX: replaces the previous ElevenLabs engine, which was the engine
//       failing in production. Sarvam is purpose-built for Indian languages
//       and telephony-quality audio (8kHz call recordings), which is a better
//       fit for this CRM's call recordings than a general-purpose engine.
//     - Batch API job flow: create job → get upload URL → PUT audio →
//       start job → poll status → get download URL → fetch transcript JSON.
//     - Built-in diarization (with_diarization=true) → speaker_id "0"/"1"/...
//       (unlike ElevenLabs, Sarvam doesn't auto-label agent/customer roles,
//       so we map by first-appearance order, same fallback ElevenLabs used).
//     - Chunk-level (sentence/phrase) timestamps, not word-level.
//   • Groq Whisper large-v3 → purely English audio (free tier, unchanged)
//
// Routing: audioLang = 'english' → Groq | anything else → Sarvam AI
// ─────────────────────────────────────────────────────────────────────────────

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const axios        = require('axios');
const FormData     = require('form-data');

const GROQ_STT_URL       = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const WHISPER_MODEL      = 'whisper-large-v3';

// ── Sarvam AI Batch Speech-to-Text ────────────────────────────────────────────
const SARVAM_BASE_URL       = 'https://api.sarvam.ai';
const SARVAM_MODEL          = process.env.SARVAM_STT_MODEL || 'saaras:v3';
const SARVAM_NUM_SPEAKERS   = parseInt(process.env.SARVAM_NUM_SPEAKERS || '2', 10); // agent + customer, the common case for this CRM
const SARVAM_POLL_INTERVAL_MS = 5000;   // Sarvam's own SDK default (poll_interval=5s)
const SARVAM_POLL_TIMEOUT_MS  = 10 * 60 * 1000; // Sarvam's own SDK default (timeout=600s) — long calls can take a while to process
// ── Sarvam's exact supported MIME subtypes (confirmed from their docs +
// live error responses). NOTE: 3GP/3GPP is NOT in this list — very common
// for Android call-recorder apps, but Sarvam rejects it outright (400
// invalid_request_error). Those get transcoded to WAV before upload; see
// transcodeToSarvamSupportedFormat() below.
const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/x-m4a', aac: 'audio/aac',
  amr: 'audio/amr', ogg: 'audio/ogg', opus: 'audio/opus', mp4: 'audio/mp4',
  flac: 'audio/flac', aiff: 'audio/aiff', webm: 'audio/webm',
};
// Extensions Sarvam will accept as-is — anything else gets transcoded first.
const SARVAM_NATIVE_EXTS = new Set(Object.keys(AUDIO_MIME_BY_EXT));
// FIX: llama-3.1-8b-instant was deprecated by Groq on 2026-06-17 (same
// deprecation batch as leadActionSummary.js's default model) and now 404s on
// every call — see console.groq.com/docs/deprecations. Groq's own migration
// guidance for this exact model is openai/gpt-oss-20b.
const ROMANIZE_MODEL     = process.env.ROMANIZE_MODEL || 'openai/gpt-oss-20b';

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

  // Quick check: if no non-ASCII characters exist, nothing to romanize.
  // FIX: this was `/[^-\x7F]/` (a stray literal DEL byte had ended up in the
  // character class) -- effectively "any character that is not a hyphen",
  // which is true for virtually any non-empty string, so this skip-check
  // never actually skipped anything -- every transcript, including pure
  // English ones, went through the romanization call regardless. The correct
  // check is for the presence of any non-ASCII character.
  if (!/[^\x00-\x7F]/.test(transcript)) {
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
// SARVAM AI ENGINE  (mixed / Indic / Hinglish) — Batch Speech-to-Text
// ─────────────────────────────────────────────────────────────────────────────
// Full job lifecycle (per Sarvam's Batch API — the only Sarvam API that
// supports diarization, which we need for agent/customer separation):
//   1. POST /speech-to-text/job/v1              → create job, get job_id
//   2. POST /speech-to-text/job/v1/upload-files  → get a presigned upload URL
//   3. PUT  <presigned URL>                      → upload the actual audio bytes
//   4. POST /speech-to-text/job/v1/:job_id/start → kick off processing
//   5. GET  /speech-to-text/job/v1/:job_id/status (poll until Completed/Failed)
//   6. POST /speech-to-text/job/v1/download-files → get a presigned download URL
//   7. GET  <presigned URL>                       → the actual transcript JSON
//
// Output JSON shape (diarized):
// {
//   "transcript": "Full transcript text...",
//   "diarized_transcript": {
//     "entries": [
//       { "transcript": "...", "start_time_seconds": 0.01, "end_time_seconds": 2.5, "speaker_id": "0" },
//       ...
//     ]
//   },
//   "language_code": "hi-IN"
// }
// speaker_id is a bare index ("0", "1", ...) — Sarvam doesn't auto-label
// agent/customer roles the way ElevenLabs did, so we map by first-appearance
// order (same fallback strategy the old ElevenLabs code already used for its
// own "speaker_0"/"speaker_1" case).
// ─────────────────────────────────────────────────────────────────────────────

function sarvamHeaders(apiKey, extra = {}) {
  return { 'api-subscription-key': apiKey, ...extra };
}

function guessAudioMime(fileName) {
  const ext = path.extname(fileName || '').replace('.', '').toLowerCase();
  return AUDIO_MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ── Transcode unsupported formats (e.g. .3gp/.3g2 from Android call
// recorders) to WAV before handing them to Sarvam. Sarvam's supported-format
// list does NOT include 3GP at all — uploading one gets a flat 400
// invalid_request_error, not a soft failure, so this has to happen up front
// rather than as a retry-on-error path.
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function transcodeToWav(inputPath) {
  const outputPath = inputPath.replace(path.extname(inputPath), '') + '_converted.wav';
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath],
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`ffmpeg transcode failed: ${stderr || err.message}`));
        resolve(outputPath);
      }
    );
  });
}

async function ensureSarvamCompatible(fileBuffer, fileName) {
  const ext = path.extname(fileName || '').replace('.', '').toLowerCase();
  if (SARVAM_NATIVE_EXTS.has(ext)) return { fileBuffer, fileName };

  console.log(`[Sarvam] "${fileName}" (.${ext}) isn't in Sarvam's supported format list — transcoding to WAV first`);
  const tmpIn = path.join(os.tmpdir(), `sarvam_in_${Date.now()}.${ext || 'bin'}`);
  fs.writeFileSync(tmpIn, fileBuffer);
  try {
    const tmpOut = await transcodeToWav(tmpIn);
    const wavBuffer = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpOut);
    return { fileBuffer: wavBuffer, fileName: fileName.replace(/\.[^.]+$/, '.wav') };
  } finally {
    fs.unlinkSync(tmpIn);
  }
}

async function sarvamCreateJob(apiKey) {
  const resp = await axios.post(
    `${SARVAM_BASE_URL}/speech-to-text/job/v1`,
    {
      job_parameters: {
        model:            SARVAM_MODEL,
        mode:             'transcribe',   // standard transcription in the original language (we romanize separately below)
        language_code:    'unknown',      // auto-detect — audio is mixed/Indic/Hinglish, language isn't known up front
        with_diarization: true,
        num_speakers:     SARVAM_NUM_SPEAKERS,
      },
    },
    { headers: sarvamHeaders(apiKey, { 'Content-Type': 'application/json' }) }
  );
  return resp.data; // { job_id, storage_container_type, job_parameters, job_state }
}

async function sarvamGetUploadUrl(apiKey, jobId, fileName) {
  const resp = await axios.post(
    `${SARVAM_BASE_URL}/speech-to-text/job/v1/upload-files`,
    { job_id: jobId, files: [fileName] },
    { headers: sarvamHeaders(apiKey, { 'Content-Type': 'application/json' }) }
  );
  const entry = resp.data?.upload_urls?.[fileName];
  if (!entry?.file_url) throw new Error(`Sarvam did not return an upload URL for "${fileName}"`);
  return entry.file_url;
}

async function sarvamUploadFile(uploadUrl, fileBuffer, fileName) {
  // Presigned URLs are Azure Blob SAS URLs (storage_container_type: "Azure_V1")
  // — a block-blob PUT needs this header or Azure rejects the upload.
  await axios.put(uploadUrl, fileBuffer, {
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type':   guessAudioMime(fileName),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

async function sarvamStartJob(apiKey, jobId) {
  await axios.post(
    `${SARVAM_BASE_URL}/speech-to-text/job/v1/${jobId}/start`,
    {},
    { headers: sarvamHeaders(apiKey) }
  );
}

async function sarvamPollStatus(apiKey, jobId) {
  const deadline = Date.now() + SARVAM_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp = await axios.get(
      `${SARVAM_BASE_URL}/speech-to-text/job/v1/${jobId}/status`,
      { headers: sarvamHeaders(apiKey) }
    );
    const status = resp.data;
    console.log(`[Sarvam] Job ${jobId} → ${status.job_state}`);

    if (status.job_state === 'Completed' || status.job_state === 'PartiallyCompleted') return status;
    if (status.job_state === 'Failed') {
      throw new Error(`Sarvam job failed: ${status.error_message || 'unknown error'}`);
    }
    // Still Accepted/Pending/Running — wait and poll again.
    await new Promise((r) => setTimeout(r, SARVAM_POLL_INTERVAL_MS));
  }
  throw new Error(`Sarvam job ${jobId} timed out after ${SARVAM_POLL_TIMEOUT_MS / 1000}s`);
}

async function sarvamDownloadTranscript(apiKey, jobId, outputFileName) {
  const resp = await axios.post(
    `${SARVAM_BASE_URL}/speech-to-text/job/v1/download-files`,
    { job_id: jobId, files: [outputFileName] },
    { headers: sarvamHeaders(apiKey, { 'Content-Type': 'application/json' }) }
  );
  const entry = resp.data?.download_urls?.[outputFileName];
  if (!entry?.file_url) throw new Error(`Sarvam did not return a download URL for "${outputFileName}"`);

  const fileResp = await axios.get(entry.file_url);
  return fileResp.data; // { transcript, diarized_transcript, language_code, ... }
}

async function runSarvam(audioInput) {
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
  if (!SARVAM_API_KEY) throw new Error('SARVAM_API_KEY is not set in your environment variables.');

  // Resolve to buffer + filename (same input handling as before)
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

  // FIX: transcode formats Sarvam doesn't accept (3GP being the one that
  // was hard-failing with 400 invalid_request_error) to WAV before upload.
  ({ fileBuffer, fileName } = await ensureSarvamCompatible(fileBuffer, fileName));

  let job, status, data;
  try {
    job = await sarvamCreateJob(SARVAM_API_KEY);
    console.log(`[Sarvam] Created job ${job.job_id}`);

    const uploadUrl = await sarvamGetUploadUrl(SARVAM_API_KEY, job.job_id, fileName);
    await sarvamUploadFile(uploadUrl, fileBuffer, fileName);
    console.log(`[Sarvam] Uploaded "${fileName}" (${fileBuffer.length} bytes)`);

    await sarvamStartJob(SARVAM_API_KEY, job.job_id);
    status = await sarvamPollStatus(SARVAM_API_KEY, job.job_id);

    const outputFile = status.job_details?.[0]?.outputs?.[0]?.file_name;
    if (!outputFile) throw new Error('Sarvam job completed but returned no output file');

    data = await sarvamDownloadTranscript(SARVAM_API_KEY, job.job_id, outputFile);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Sarvam STT failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  const entries = data?.diarized_transcript?.entries;
  if (!entries || entries.length === 0) {
    // Fall back to flat transcript if diarization returned nothing
    return { text: (data?.transcript || '').trim(), durationSec: 0 };
  }

  console.log(`[Sarvam] Detected language: ${data.language_code || 'unknown'}`);
  console.log(`[Sarvam] Total diarized segments: ${entries.length}`);

  // Map bare speaker indices ("0", "1", ...) to Employee/Client by
  // first-appearance order — Sarvam has no built-in agent/customer role label.
  const dynamicMap = {};
  const ROLE_ORDER = ['Employee', 'Client', 'Speaker 3', 'Speaker 4'];
  function resolveLabel(spk) {
    if (dynamicMap[spk]) return dynamicMap[spk];
    const role = ROLE_ORDER[Object.keys(dynamicMap).length] || `Speaker ${spk}`;
    dynamicMap[spk] = role;
    console.log(`[Sarvam] Speaker mapping: ${spk} → ${role}`);
    return role;
  }

  const lines = entries.map(
    (e) => `[${formatTime(e.start_time_seconds || 0)}] ${resolveLabel(e.speaker_id ?? 'unknown')}: ${(e.transcript || '').trim()}`
  );
  const rawTranscript = lines.join('\n');
  console.log(`[Sarvam] Raw transcript (first 200 chars): ${rawTranscript.slice(0, 200)}`);

  // Duration = the latest end_time_seconds across all segments (chunk-level, not word-level).
  let durationSec = 0;
  for (const e of entries) {
    if (typeof e.end_time_seconds === 'number' && e.end_time_seconds > durationSec) durationSec = e.end_time_seconds;
  }
  console.log(`[Sarvam] Audio duration: ${durationSec.toFixed(1)}s`);

  // Romanize any native-script (Devanagari etc.) words → Roman phonetic (unchanged from before)
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
  console.log('[Transcription] Engine → Sarvam AI Saaras v3 Batch (mixed/Indic, diarized)');
  return runSarvam(audioInput);
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
