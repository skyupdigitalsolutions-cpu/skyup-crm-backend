// utils/transcribeAudio.js
// Downloads audio (Twilio or local file) and sends to OpenAI Whisper for transcription.

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const axios   = require('axios');
const OpenAI  = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Transcribe a Twilio recording (fetched via Twilio REST API) ───────────────
// recordingSid: e.g. "RExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
// Returns: { transcript: string }
async function transcribeTwilioRecording(recordingSid) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

  // Download to a temp file so Whisper can read it
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
    const transcript = await runWhisper(tmpPath);
    return { transcript };
  } finally {
    // Always clean up the temp file
    fs.unlink(tmpPath, () => {});
  }
}

// ── Transcribe a mobile recording (stored in uploads/recordings/) ─────────────
// relativeUrl: e.g. "/recordings/userId_ts_file.mp3"
// Returns: { transcript: string }
async function transcribeMobileRecording(relativeUrl) {
  const filePath = path.join(__dirname, '..', 'uploads', relativeUrl);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Recording file not found: ${filePath}`);
  }

  const transcript = await runWhisper(filePath);
  return { transcript };
}

// ── Core Whisper call ─────────────────────────────────────────────────────────
async function runWhisper(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file:             fs.createReadStream(filePath),
    model:            'whisper-1',
    language:         'en',          // change to 'hi' if calls are in Hindi, or remove for auto-detect
    response_format:  'text',
  });

  // When response_format is 'text', the SDK returns a string directly
  return typeof transcription === 'string'
    ? transcription.trim()
    : (transcription.text || '').trim();
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };