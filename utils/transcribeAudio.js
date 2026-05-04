// utils/transcribeAudio.js
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const axios  = require('axios');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Transcribe a Twilio recording ─────────────────────────────────────────────
async function transcribeTwilioRecording(recordingSid) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const tmpPath = path.join(os.tmpdir(), `twilio_${recordingSid}.mp3`);

  const response = await axios.get(twilioUrl, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
  });

  fs.writeFileSync(tmpPath, response.data);
  try {
    const transcript = await runWhisper(tmpPath);
    return { transcript };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Transcribe a mobile recording ─────────────────────────────────────────────
// relativeUrl may be:
//   "/recordings/userId_ts_file.mp3"  ← stored on server disk
//   "https://..."                      ← external URL (S3, CDN, etc.)
async function transcribeMobileRecording(relativeUrl) {
  let filePath = null;
  let isTemp   = false;

  // ── Case 1: Full external URL — download to temp file first ──────────────
  if (relativeUrl && relativeUrl.startsWith('http')) {
    filePath = path.join(os.tmpdir(), `mobile_${Date.now()}.mp3`);
    isTemp   = true;
    const response = await axios.get(relativeUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, response.data);
  } else {
    // ── Case 2: Relative path on disk ────────────────────────────────────
    // Strip any leading slashes so path.join works correctly
    const clean = (relativeUrl || '').replace(/^\/+/, '');

    // Try  <project_root>/uploads/<clean>  first
    const candidate1 = path.join(__dirname, '..', 'uploads', clean);
    // Try  <project_root>/<clean>          as fallback (path already has 'uploads' in it)
    const candidate2 = path.join(__dirname, '..', clean);

    if (fs.existsSync(candidate1)) {
      filePath = candidate1;
    } else if (fs.existsSync(candidate2)) {
      filePath = candidate2;
    } else {
      throw new Error(
        `Recording file not found.\n  Tried: ${candidate1}\n  Tried: ${candidate2}\n  URL stored: ${relativeUrl}`
      );
    }
  }

  try {
    const transcript = await runWhisper(filePath);
    return { transcript };
  } finally {
    if (isTemp) fs.unlink(filePath, () => {});
  }
}

// ── Core Whisper call ─────────────────────────────────────────────────────────
async function runWhisper(filePath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to your environment variables on Render.');
  }

  const transcription = await openai.audio.transcriptions.create({
    file:            fs.createReadStream(filePath),
    model:           'whisper-1',
    response_format: 'text',
    // Remove the language: 'en' line below if your calls are in Hindi/mixed language
    language:        'en',
  });

  return typeof transcription === 'string'
    ? transcription.trim()
    : (transcription.text || '').trim();
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };