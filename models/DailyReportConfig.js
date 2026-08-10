// models/DailyReportConfig.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-company configuration for the Daily Telegram Report feature.
// Completely separate from the existing campaign Telegram notification config
// (Company.telegramBotToken / telegramChatId / telegramEnabled) — those are
// for real-time campaign lead alerts. This is for the scheduled daily summary.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const crypto   = require('crypto');

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
// Bot tokens are sensitive credentials. We encrypt at rest using the same
// ENCRYPTION_KEY already required by the backend environment (used elsewhere
// in fieldCrypto.js). Falls back gracefully if the key is not set (dev mode).
const KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : null;

function encrypt(text) {
  if (!KEY || !text) return text;
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(text) {
  if (!KEY || !text) return text;
  try {
    const [ivHex, tagHex, encHex] = text.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch {
    return text; // return as-is if decryption fails (e.g. not yet encrypted)
  }
}

const dailyReportConfigSchema = new mongoose.Schema(
  {
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Company',
      required: true,
      unique:   true, // one config per company
    },

    // ── Feature toggle ────────────────────────────────────────────────────────
    enabled: { type: Boolean, default: false },

    // ── Telegram credentials (bot token encrypted at rest) ────────────────────
    // NEVER expose telegramBotToken in API responses — always mask it.
    telegramBotToken: { type: String, default: null },
    telegramChatId:   { type: String, default: null, trim: true },

    // ── Schedule ──────────────────────────────────────────────────────────────
    // reportTime: "HH:MM" in 24h format (e.g. "19:00" for 7 PM)
    reportTime: { type: String, default: '19:00' },
    // IANA timezone string (e.g. "Asia/Kolkata", "Asia/Dubai")
    timezone: { type: String, default: 'Asia/Kolkata' },

    // ── Behaviour ────────────────────────────────────────────────────────────
    // If false, skip sending when no activity was recorded for the day
    sendEmptyReport: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// ── Encrypt bot token before save ─────────────────────────────────────────────
dailyReportConfigSchema.pre('save', function (next) {
  if (this.isModified('telegramBotToken') && this.telegramBotToken) {
    this.telegramBotToken = encrypt(this.telegramBotToken);
  }
  next();
});

// ── Instance method: get decrypted token ─────────────────────────────────────
dailyReportConfigSchema.methods.getDecryptedToken = function () {
  return decrypt(this.telegramBotToken);
};

// ── Index ─────────────────────────────────────────────────────────────────────
dailyReportConfigSchema.index({ company: 1 }, { unique: true });

module.exports = mongoose.model('DailyReportConfig', dailyReportConfigSchema);
