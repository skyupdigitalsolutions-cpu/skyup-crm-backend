// middlewares/requestTiming.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// The server had NO request timing, so "the app is slow" could not be traced to an endpoint. This adds two things to the
// normal pm2 log, with almost no cost:
//
//   [slow] POST /api/call-logs/sync 200 4210 ms        every request slower than SLOW_REQUEST_MS (default 1500 ms)
//   [req-summary 5min] POST /api/call-logs/sync ×412 avg 2210ms max 9100ms | GET /api/lead/my-leads ×95 avg 640ms …
//                                                       every 5 minutes: the busiest routes by total time (what the server
//                                                       spent its time on), with count, average and worst
//
// Routes are grouped by PATTERN (/api/lead/:id, not /api/lead/6a22…), and the query string is never logged — so the log
// stays small and contains no personal data. Set SLOW_REQUEST_MS in .env to change the threshold (0 turns it off).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const SLOW_MS     = parseInt(process.env.SLOW_REQUEST_MS || "1500", 10);
const SUMMARY_MS  = 5 * 60 * 1000;
const stats = new Map();                      // "METHOD route" -> { n, total, max, slow }

function record(key, ms) {
  let s = stats.get(key);
  if (!s) { s = { n: 0, total: 0, max: 0, slow: 0 }; stats.set(key, s); }
  s.n += 1; s.total += ms; if (ms > s.max) s.max = ms; if (ms >= SLOW_MS) s.slow += 1;
}

function requestTiming(req, res, next) {
  if (!SLOW_MS) return next();
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // the matched route PATTERN; everything that matched no route (404s, scanners) shares one key so memory stays bounded
    const pattern = req.route && req.route.path ? `${req.baseUrl || ""}${typeof req.route.path === "string" ? req.route.path : "(pattern)"}` : "(unmatched)";
    const key = `${req.method} ${pattern}`;
    record(key, ms);
    if (ms >= SLOW_MS) console.warn(`[slow] ${key} ${res.statusCode} ${Math.round(ms)} ms`);
  });
  next();
}

// Prints the 5-minute summary and resets. Exported so it can be tested.
function flushSummary(log = console.log) {
  if (!stats.size) return null;
  const rows = [...stats.entries()].map(([k, s]) => ({ k, ...s })).sort((a, b) => b.total - a.total).slice(0, 8);
  const line = "[req-summary 5min] " + rows.map((r) => `${r.k} ×${r.n} avg ${Math.round(r.total / r.n)}ms max ${Math.round(r.max)}ms${r.slow ? ` (${r.slow} slow)` : ""}`).join(" | ");
  stats.clear();
  log(line);
  return line;
}

if (SLOW_MS) setInterval(() => flushSummary(), SUMMARY_MS).unref();     // unref: never keeps the process alive

module.exports = requestTiming;
module.exports.flushSummary = flushSummary;
module.exports._stats = stats;
