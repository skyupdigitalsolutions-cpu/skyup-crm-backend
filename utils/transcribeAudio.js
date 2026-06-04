// utils/transcribeAudio.js
// ── Groq Whisper large-v3 for transcription + Groq LLM for transliteration ───

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const axios    = require('axios');
const FormData = require('form-data');

const GROQ_STT_URL  = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const WHISPER_MODEL = 'whisper-large-v3';
const CHAT_MODEL    = 'llama-3.1-8b-instant'; // current supported Groq chat model

// ── Transliterate non-English text to Roman script using Groq LLM ─────────────
async function translateToEnglish(text, detectedLanguage) {
  // If already English, skip
  if (detectedLanguage === 'en' || detectedLanguage === 'eng') {
    return text;
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.warn('[Transliteration] GROQ_API_KEY not set — returning original text.');
    return text;
  }

  console.log(`[Transliteration] Converting ${detectedLanguage} → Roman script`);

  try {
    const { data } = await axios.post(
      GROQ_CHAT_URL,
      {
        model: CHAT_MODEL,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content:
              `You are a transliteration expert. Convert the following ${detectedLanguage} text into Roman (English) script — keep the SAME words and pronunciation, just write them in English letters.\n` +
              `Do NOT translate the meaning. Do NOT change the words.\n` +
              `Example: "अभी मैं थोड़ा बिजी हूं" → "abi mein thoda busy hu"\n` +
              `Example: "ನಾನು ಸ್ವಲ್ಪ ಬ್ಯುಸಿ ಇದ್ದೀನಿ" → "naanu svalpa busy iddini"\n` +
              `If the text already has English/Roman words, keep them exactly as-is.\n` +
              `Return ONLY the transliterated text, nothing else.`,
          },
          { role: 'user', content: text },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return (data.choices?.[0]?.message?.content || text).trim();
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error(`[Transliteration] Chat API failed (${err.response?.status ?? 'network'}): ${detail}`);
    console.warn('[Transliteration] Falling back to original transcript text.');
    return text; // don't crash — return the raw transcript
  }
}

// ── Core Groq Whisper large-v3 call ──────────────────────────────────────────
async function runGroqWhisper(audioInput) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set. Add it to your environment variables.');
  }
  console.log('[Groq] Using key ending in:', GROQ_API_KEY.slice(-6));

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

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName });
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  // No language param → auto-detect (Hindi/Kannada/Telugu/Tamil/English)

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
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(`Groq STT request failed (${err.response?.status ?? 'network'}): ${detail}`);
  }

  if (!data || !data.text) {
    throw new Error('Groq Whisper returned an empty transcription.');
  }

  const originalText     = data.text.trim();
  const detectedLanguage = data.language || 'unknown';
  const segments         = data.segments || [];

  console.log(`[Groq] Detected language: ${detectedLanguage}`);
  console.log(`[Groq] Original transcript (first 100 chars): ${originalText.slice(0, 100)}`);

  // ── Format as timestamped segments ───────────────────────────────────────
  let dialogueText = '';
  if (segments.length > 0) {
    dialogueText = segments
      .map(seg => `[${formatTime(seg.start)}] ${seg.text.trim()}`)
      .join('\n');
  }

  // ── Transliterate to Roman script if needed ───────────────────────────────
  const textToTransliterate = dialogueText || originalText;
  const englishText = await translateToEnglish(textToTransliterate, detectedLanguage);

  console.log(`[Transliteration] Roman transcript (first 100 chars): ${englishText.slice(0, 100)}`);

  return { text: englishText };
}

// Format seconds → MM:SS
function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
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
    const { text } = await runGroqWhisper(tmpPath);
    return { transcript: text };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Transcribe a mobile recording ─────────────────────────────────────────────
async function transcribeMobileRecording(relativeUrl) {
  if (relativeUrl && relativeUrl.startsWith('http')) {
    const { text } = await runGroqWhisper(relativeUrl);
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

  const { text } = await runGroqWhisper(filePath);
  return { transcript: text };
}

module.exports = { transcribeTwilioRecording, transcribeMobileRecording };
