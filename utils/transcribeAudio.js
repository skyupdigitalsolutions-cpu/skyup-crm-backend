// utils/transcribeAudio.js
// ── ElevenLabs Scribe v2 for transcription + OpenAI for English translation ───

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');

const SCRIBE_URL    = 'https://api.elevenlabs.io/v1/speech-to-text';
const OPENAI_URL    = 'https://api.openai.com/v1/chat/completions';

// ── Translate any language text to English using OpenAI ───────────────────────
async function translateToEnglish(text, detectedLanguage) {
  // If already English, skip translation
  if (detectedLanguage === 'en' || detectedLanguage === 'eng') {
    return text;
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.warn('[Translation] OPENAI_API_KEY not set — returning original text.');
    return text;
  }

  console.log(`[Translation] Translating from ${detectedLanguage} → English`);

  const { data } = await axios.post(
    OPENAI_URL,
    {
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the following ${detectedLanguage} text to English. 
Keep the meaning accurate and natural. 
If the text already contains some English words (code-switching), keep them as-is.
Return ONLY the translated text, nothing else.`,
        },
        { role: 'user', content: text },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return (data.choices?.[0]?.message?.content || text).trim();
}

// ── Core ElevenLabs Scribe call ───────────────────────────────────────────────
async function runElevenLabsScribe(audioInput) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not set. Add it to your environment variables.');
  }
  console.log('[ElevenLabs] Using key ending in:', ELEVENLABS_API_KEY.slice(-6));

  let fileBuffer;
  let fileName;

  if (typeof audioInput === 'string' && audioInput.startsWith('http')) {
    const response = await axios.get(audioInput, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data);
    fileName   = 'audio.mp3';
  } else {
    fileBuffer = fs.readFileSync(audioInput);
    fileName   = path.basename(audioInput);
  }

  const FormData = require('form-data');
  const form     = new FormData();

  form.append('file', fileBuffer, { filename: fileName });
  form.append('model_id', 'scribe_v2');
  form.append('diarize', 'true');
  form.append('timestamps_granularity', 'word');
  // No language_code → auto-detect (best for Hindi/Kannada/Telugu/Tamil/English)

  const { data } = await axios.post(SCRIBE_URL, form, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (!data || !data.text) {
    throw new Error('ElevenLabs Scribe returned an empty transcription.');
  }

  const originalText      = data.text.trim();
  const detectedLanguage  = data.language_code || 'unknown';

  console.log(`[ElevenLabs] Detected language: ${detectedLanguage}`);
  console.log(`[ElevenLabs] Original transcript (first 100 chars): ${originalText.slice(0, 100)}`);

  // ── Translate to English if needed ────────────────────────────────────────
  const englishText = await translateToEnglish(originalText, detectedLanguage);

  console.log(`[ElevenLabs] English transcript (first 100 chars): ${englishText.slice(0, 100)}`);

  return { text: englishText };
}

// ── Transcribe a Twilio recording ─────────────────────────────────────────────
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
async function transcribeMobileRecording(relativeUrl) {
  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text } = await runElevenLabsScribe(relativeUrl);
    return { transcript: text };
  }

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
