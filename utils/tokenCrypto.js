// utils/tokenCrypto.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side symmetric encryption for OAuth tokens held by the server
// (e.g. Google Analytics refresh tokens). AES-256-GCM with a key derived from
// GA_TOKEN_ENCRYPTION_KEY (env).
//
// NOTE: this is separate from middlewares/encryption.js, which is a
// zero-knowledge CLIENT-side scheme (the server can't read those). Here the
// server MUST be able to use the token to call Google, so the server holds the
// key. Set a strong GA_TOKEN_ENCRYPTION_KEY in the environment.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const RAW_KEY = process.env.GA_TOKEN_ENCRYPTION_KEY || "";
const KEY = RAW_KEY ? crypto.createHash("sha256").update(RAW_KEY).digest() : null; // 32 bytes

function encryptToken(plain) {
  if (plain == null) return null;
  if (!KEY) {
    // No key configured — store as-is but clearly marked, and warn loudly.
    console.warn("[tokenCrypto] GA_TOKEN_ENCRYPTION_KEY not set — storing token UNENCRYPTED. Set it in env!");
    return `plain:${plain}`;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptToken(stored) {
  if (stored == null) return null;
  if (typeof stored === "string" && stored.startsWith("plain:")) return stored.slice(6);
  if (typeof stored !== "string" || !stored.startsWith("v1:")) return stored; // legacy/plaintext
  if (!KEY) {
    console.warn("[tokenCrypto] Encrypted token present but GA_TOKEN_ENCRYPTION_KEY not set — cannot decrypt.");
    return null;
  }
  try {
    const [, ivHex, tagHex, dataHex] = stored.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error("[tokenCrypto] decrypt failed:", e.message);
    return null;
  }
}

module.exports = { encryptToken, decryptToken };