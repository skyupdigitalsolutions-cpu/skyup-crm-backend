// utils/detectLanguage.js
// ─────────────────────────────────────────────────────────────────────────────
// Best-effort detection of a lead's preferred language from ad-form fields.
// Optional — returns "" when nothing language-like is found.
//
// Works for:
//   • Meta lead forms  → field_data: [{ name, values: [..] }, ...]
//   • Google lead forms → user_column_data: [{ column_name, string_value }, ...]
//   • Any plain object of parsed { fieldName: value }
//
// No optional-chaining / nullish-coalescing operators — Beautify-safe.
// ─────────────────────────────────────────────────────────────────────────────

// Field names that indicate the answer IS the language.
const LANG_KEYS = ["language", "preferred_language", "preferred language", "lang", "language_preference", "भाषा", "لغة"];

// Canonical language names keyed by common values/aliases (lowercased).
const CANON = {
  english: "English", en: "English", eng: "English", inglés: "English",
  hindi: "Hindi", hi: "Hindi", हिंदी: "Hindi", हिन्दी: "Hindi",
  arabic: "Arabic", ar: "Arabic", العربية: "Arabic", عربي: "Arabic",
  tamil: "Tamil", ta: "Tamil", தமிழ்: "Tamil",
  telugu: "Telugu", te: "Telugu",
  kannada: "Kannada", kn: "Kannada",
  malayalam: "Malayalam", ml: "Malayalam",
  marathi: "Marathi", mr: "Marathi",
  gujarati: "Gujarati", gu: "Gujarati",
  bengali: "Bengali", bangla: "Bengali", bn: "Bengali",
  punjabi: "Punjabi", pa: "Punjabi",
  urdu: "Urdu", ur: "Urdu",
  odia: "Odia", oriya: "Odia",
  spanish: "Spanish", es: "Spanish", español: "Spanish",
  french: "French", fr: "French",
};

function canonicalize(raw) {
  if (raw == null) return "";
  const v = String(raw).trim();
  if (!v) return "";
  const key = v.toLowerCase();
  if (CANON[key]) return CANON[key];
  // Title-case an unknown value so filtering stays consistent.
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function isLangKey(name) {
  if (!name) return false;
  const n = String(name).toLowerCase().replace(/[_\s-]+/g, " ").trim();
  for (let i = 0; i < LANG_KEYS.length; i++) {
    const k = LANG_KEYS[i].toLowerCase();
    if (n === k || n.indexOf(k) !== -1) return true;
  }
  return false;
}

// Meta: field_data = [{ name, values: [ "Hindi" ] }, ...]
function fromMetaFieldData(fieldData) {
  if (!Array.isArray(fieldData)) return "";
  for (let i = 0; i < fieldData.length; i++) {
    const f = fieldData[i];
    if (f && isLangKey(f.name)) {
      const vals = f.values;
      if (Array.isArray(vals) && vals.length) return canonicalize(vals[0]);
      if (typeof f.value === "string") return canonicalize(f.value);
    }
  }
  return "";
}

// Google: user_column_data = [{ column_name, string_value }, ...]
function fromGoogleColumns(columns) {
  if (!Array.isArray(columns)) return "";
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (c && isLangKey(c.column_name)) return canonicalize(c.string_value);
  }
  return "";
}

// Plain parsed object: { "Language": "Hindi", ... }
function fromParsedFields(obj) {
  if (!obj || typeof obj !== "object") return "";
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (isLangKey(keys[i])) return canonicalize(obj[keys[i]]);
  }
  return "";
}

module.exports = { fromMetaFieldData, fromGoogleColumns, fromParsedFields, canonicalize, isLangKey };
