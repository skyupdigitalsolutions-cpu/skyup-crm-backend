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
// Bot tokens are sensitive credentials. We encrypt at rest using the same key
// utils/fieldCrypto.js already uses for other credential fields.
//
// FIX: this previously read process.env.ENCRYPTION_KEY based on a mistaken
// assumption (per the old comment here) that it was "the same ENCRYPTION_KEY
// already required... used elsewhere in fieldCrypto.js" — but fieldCrypto.js
// actually reads FIELD_ENCRYPTION_KEY, a different variable name that was
// never the same value. Since ENCRYPTION_KEY was never actually set in this
// deployment, KEY below was always null, and encrypt()/decrypt() both
// silently no-op when KEY is null — meaning every Daily Report bot token
// saved through this model has been stored as PLAINTEXT, not encrypted,
// despite the code appearing to implement encryption.
//
// Also matching fieldCrypto.js's exact key-derivation method, not just its
// variable name: FIELD_ENCRYPTION_KEY is a PLAIN PASSPHRASE (any length),
// hashed with SHA-256 to get a fixed 32-byte key — NOT raw hex bytes.
// `Buffer.from(key, 'hex')` would only coincidentally work for a passphrase
// that happens to look like valid hex; it would silently break (or throw)
// for a normal, non-hex passphrase. Deriving it the same way fieldCrypto.js
// does is the actually-correct fix, not just reading the right variable name.
const RAW_KEY = process.env.FIELD_ENCRYPTION_KEY || "";
const KEY = RAW_KEY
  ? crypto.createHash('sha256').update(RAW_KEY).digest()
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

// Note: unique index on company is handled by { unique: true } on the schema field above.
// No separate .index() call needed — that would create a duplicate index warning.

module.exports = mongoose.model('DailyReportConfig', dailyReportConfigSchema);
