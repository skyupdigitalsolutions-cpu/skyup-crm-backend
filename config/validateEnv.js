// config/validateEnv.js
// ─────────────────────────────────────────────────────────────────────────────
// STARTUP SECRET VALIDATION
// ISO/IEC 27001:2022 — A.8.9 Configuration management, A.8.24 Use of cryptography
//
// Previously, missing secrets were papered over with fallbacks (e.g.
// `process.env.JWT_SECRET || "dev-secret"`), so a misconfigured deploy would
// start up and run INSECURELY rather than failing. This module makes the
// process refuse to boot when a required secret is absent or obviously weak.
//
// Call it as the first thing in server.js:
//   require("./config/validateEnv")();
// ─────────────────────────────────────────────────────────────────────────────

// Secrets without which the app must not start.
const REQUIRED = [
  { key: "JWT_SECRET",     minLength: 32, note: "signs all auth tokens" },
  { key: "MONGO_URI",      minLength: 10, note: "database connection", altKeys: ["MONGODB_URI"] },
];

// Recommended but not fatal — warn so gaps are visible in the deploy log.
const RECOMMENDED = [
  { key: "ENCRYPTION_KEY", note: "field-level encryption of lead PII" },
  { key: "ALLOWED_ORIGINS", note: "CORS allowlist" },
];

// Values that must never appear in production.
const FORBIDDEN_VALUES = new Set([
  "dev-secret", "secret", "changeme", "password", "test", "123456", "your-secret-here",
]);

module.exports = function validateEnv({ exitOnFailure = true } = {}) {
  const errors = [];
  const warnings = [];

  for (const { key, minLength, note, altKeys = [] } of REQUIRED) {
    const value = process.env[key] || altKeys.map((k) => process.env[k]).find(Boolean);
    if (!value) {
      errors.push(`${key} is not set (${note}).`);
      continue;
    }
    if (FORBIDDEN_VALUES.has(String(value).toLowerCase())) {
      errors.push(`${key} is set to a well-known placeholder value — replace it with a strong random secret.`);
    }
    if (minLength && String(value).length < minLength) {
      errors.push(`${key} is shorter than the ${minLength}-character minimum (${note}).`);
    }
  }

  for (const { key, note } of RECOMMENDED) {
    if (!process.env[key]) warnings.push(`${key} is not set (${note}).`);
  }

  warnings.forEach((w) => console.warn(`⚠️  Config warning: ${w}`));

  if (errors.length) {
    console.error("\n❌ Refusing to start — required configuration is missing or insecure:");
    errors.forEach((e) => console.error(`   • ${e}`));
    console.error("\nSet these in the environment and redeploy.\n");
    if (exitOnFailure) process.exit(1);
    throw new Error("Invalid environment configuration");
  }

  console.log("🔐 Environment secrets validated.");
  return true;
};