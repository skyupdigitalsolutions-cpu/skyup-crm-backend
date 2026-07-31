// utils/escapeRegex.js
// ─────────────────────────────────────────────────────────────────────────────
// REGEX-INJECTION / ReDoS GUARD
// OWASP A03:2021 (Injection) · ISO/IEC 27001:2022 A.8.28 (Secure coding)
//
// Several list endpoints build a case-insensitive filter straight from a raw
// user-supplied search string:  { $regex: search, $options: "i" }.
// Passing untrusted input directly as a regex pattern has two problems:
//   1. Regex-injection — the user can inject metacharacters (".*", "^", "|",
//      lookaheads) to change what the query matches, e.g. widening a scoped
//      search or crafting catastrophic-backtracking input (ReDoS) that pins CPU.
//   2. Unexpected matches — "a.b" would match "axb" instead of the literal.
//
// escapeRegex() escapes every regex metacharacter so the value is treated as a
// LITERAL substring. Callers keep their existing { $regex, $options:"i" } shape;
// only the pattern string is made safe.
//
//   const { escapeRegex } = require("../utils/escapeRegex");
//   { $regex: escapeRegex(search), $options: "i" }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape all special regex characters in a string so it matches literally.
 * @param {string} input
 * @returns {string} regex-safe literal
 */
function escapeRegex(input) {
  return String(input == null ? "" : input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };