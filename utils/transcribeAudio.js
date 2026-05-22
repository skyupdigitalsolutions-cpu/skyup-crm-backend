// utils/transcribeAudio.js
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const axios  = require('axios');
const { AssemblyAI } = require('assemblyai');

const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

// ── Core AssemblyAI transcription call ────────────────────────────────────────
// audioInput: local file path (string) OR a public/accessible URL (string)
async function runAssemblyAI(audioInput) {
  if (!process.env.ASSEMBLYAI_API_KEY) {
    throw new Error('ASSEMBLYAI_API_KEY is not set. Add it to your environment variables.');
  }

  const transcript = await client.transcripts.transcribe({
    audio:        audioInput,
    speech_models: ['universal-3-pro', 'universal-2'],   // required by AssemblyAI v2 API
    // Remove language_code below if your calls are in Hindi / mixed language.
    // AssemblyAI will then auto-detect the language.
    language_code: 'en',
  });

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI transcription error: ${transcript.error}`);
  }

  return {
    text: transcript.text?.trim() || '',
    transcriptId: transcript.id,   // <-- needed for LeMUR summarization
  };
}

// ── Transcribe a Twilio recording ─────────────────────────────────────────────
// Twilio URLs require HTTP Basic Auth, so we download the file first,
// then upload the local file to AssemblyAI.
async function transcribeTwilioRecording(recordingSid) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const tmpPath = path.join(os.tmpdir(), `twilio_${recordingSid}.mp3`);

  const response = await axios.get(twilioUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  fs.writeFileSync(tmpPath, response.data);

  try {
    const { text, transcriptId } = await runAssemblyAI(tmpPath);
    return { transcript: text, transcriptId };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Transcribe a mobile recording ─────────────────────────────────────────────
// relativeUrl may be:
//   "/recordings/userId_ts_file.mp3"  ← stored on server disk
//   "https://..."                      ← external URL (S3, CDN, etc.)
//
// For external URLs, AssemblyAI can fetch them directly — no local download needed.
async function transcribeMobileRecording(relativeUrl) {
  // ── Case 1: Full external URL — pass directly to AssemblyAI ─────────────
  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text, transcriptId } = await runAssemblyAI(relativeUrl);
    return { transcript: text, transcriptId };
  }

  // ── Case 2: Relative path on disk ────────────────────────────────────────
  const clean = (relativeUrl || '').replace(/^\/+/, '');

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

  const { text, transcriptId } = await runAssemblyAI(filePath);
  return { transcript: text, transcriptId };
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };
