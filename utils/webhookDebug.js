// utils/webhookDebug.js
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight in-memory recorder for incoming webhook hits.
// Purpose: confirm whether MSG91 (or Meta) is actually calling our server, and
// capture the EXACT payload it sends — without needing server-log access.
//
// View the last hits in a browser:
//   GET /msg91-webhook/_debug/recent?key=<WEBHOOK_DEBUG_KEY>
//
// This is a diagnostic aid. It keeps only the last 25 hits in memory (cleared on
// restart) and is gated behind WEBHOOK_DEBUG_KEY. Remove once the issue is fixed.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HITS = 25;
const hits = [];

function recordHit(req) {
  try {
    hits.unshift({
      at:     new Date().toISOString(),
      method: req.method,
      path:   req.originalUrl || req.url,
      ip:     req.headers["x-forwarded-for"] || req.ip || null,
      // Body may be large/odd — guard against circulars and cap size.
      body:   safeBody(req.body),
    });
    if (hits.length > MAX_HITS) hits.length = MAX_HITS;
  } catch (_) {
    /* never let diagnostics break the webhook */
  }
}

function safeBody(body) {
  try {
    const json = JSON.stringify(body);
    return json && json.length > 8000 ? JSON.parse(json.slice(0, 8000) + '"}') : body;
  } catch {
    return String(body);
  }
}

function recentHits() {
  return { count: hits.length, hits };
}

module.exports = { recordHit, recentHits };