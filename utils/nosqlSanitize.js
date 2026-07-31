// utils/nosqlSanitize.js
// ─────────────────────────────────────────────────────────────────────────────
// NoSQL OPERATOR-INJECTION GUARD
// OWASP A03:2021 (Injection) · ISO/IEC 27001:2022 A.8.28 (Secure coding)
//
// MongoDB query operators are objects whose keys start with "$" (e.g. {$ne:null},
// {$gt:""}). If a request body/params object reaches a query unfiltered, an
// attacker can send  { "email": { "$ne": null } }  and turn an equality lookup
// into a match-anything query — the classic NoSQL auth-bypass. Dotted keys
// ("a.b") can likewise reach into nested paths. This middleware strips any key
// that begins with "$" or contains "." from incoming request objects.
//
// WHY NOT express-mongo-sanitize:
//   This app runs Express 5, where `req.query` is a lazy getter with no setter.
//   express-mongo-sanitize reassigns `req.query`, which throws
//   "Cannot set property query of #<IncomingMessage> which has only a getter"
//   and crashes the request. This implementation mutates objects IN PLACE and
//   never reassigns req.query, so it is safe on Express 5.
//
// SCOPE: sanitises req.body and req.params (where untrusted operator objects
// realistically arrive). req.query values are strings once parsed and cannot
// carry an operator object, so the query container is left untouched — avoiding
// the Express-5 getter trap entirely.
//
// Mount ONCE, right after the body parsers, before the routes:
//   const { nosqlSanitize } = require("./utils/nosqlSanitize");
//   app.use(nosqlSanitize());
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_KEY = /^\$|\./; // key starts with "$"  OR  contains "."

// Recursively delete forbidden keys from a plain object/array, in place.
// Depth-guarded so a maliciously deep payload can't blow the stack.
function scrub(node, depth) {
  if (depth > 20 || node === null || typeof node !== "object") return node;

  if (Array.isArray(node)) {
    for (const item of node) scrub(item, depth + 1);
    return node;
  }

  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEY.test(key)) {
      delete node[key]; // drop the operator/dotted key entirely
      continue;
    }
    scrub(node[key], depth + 1);
  }
  return node;
}

/**
 * Express middleware factory. Returns a middleware that scrubs req.body and
 * req.params of Mongo operator keys before any controller/query sees them.
 */
function nosqlSanitize() {
  return function nosqlSanitizeMiddleware(req, _res, next) {
    try {
      if (req.body   && typeof req.body   === "object") scrub(req.body, 0);
      if (req.params && typeof req.params === "object") scrub(req.params, 0);
    } catch (_) {
      // Never let a sanitiser bug take down a request — fail open on scrub error.
    }
    next();
  };
}

module.exports = { nosqlSanitize, scrub };