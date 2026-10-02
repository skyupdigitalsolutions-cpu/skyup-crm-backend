// utils/paginate.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared, BACKWARD-COMPATIBLE pagination for list endpoints.
//
// Opt-in: pagination only kicks in when the caller sends ?page= or ?limit=
// (or ?cursor= for cursor mode). Existing screens that call the endpoint
// without those params keep getting exactly the same response as before, so
// nothing breaks while the frontend moves over endpoint by endpoint.
//
// When paginated:
//   • Endpoints that return a bare ARRAY still return the array (same shape),
//     and the paging info is sent in headers:
//         X-Total-Count, X-Page, X-Limit, X-Total-Pages, X-Has-More
//   • Endpoints that return an OBJECT get  { ...body, total, page, limit,
//     pages, hasMore }  merged in.
//
// Usage in a controller:
//   const pg = readPagination(req, { defaultLimit: 50, maxLimit: 500 });
//   let q = Model.find(filter).sort({ createdAt: -1 });
//   if (pg.enabled) q = q.skip(pg.skip).limit(pg.limit);
//   const [items, total] = await Promise.all([q.lean(), pg.enabled ? Model.countDocuments(filter) : null]);
//   return sendList(res, items, pg, total);              // array endpoints
//   return sendObject(res, { leads: items }, pg, total);  // object endpoints
// ─────────────────────────────────────────────────────────────────────────────

const HARD_MAX = 1000;

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse ?page & ?limit.  enabled=false when neither was sent.
 * @param {object} req
 * @param {{ defaultLimit?: number, maxLimit?: number, force?: boolean }} [opts]
 *   force=true → always paginate (for endpoints that must never be unbounded).
 */
function readPagination(req, opts = {}) {
  const { defaultLimit = 50, maxLimit = 500, force = false } = opts;
  const q = req.query || {};
  const hasParams = q.page !== undefined || q.limit !== undefined;
  const cap = Math.min(maxLimit, HARD_MAX);

  let page  = toInt(q.page);
  let limit = toInt(q.limit);
  if (!Number.isFinite(page)  || page  < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  limit = Math.min(limit, cap);

  return {
    enabled: force || hasParams,
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function meta(pg, total) {
  const t = Number.isFinite(total) ? total : null;
  const pages = t == null ? null : Math.max(1, Math.ceil(t / pg.limit));
  return {
    total: t,
    page: pg.page,
    limit: pg.limit,
    pages,
    hasMore: t == null ? null : pg.page * pg.limit < t,
  };
}

function setHeaders(res, m) {
  try {
    if (m.total != null) res.set("X-Total-Count", String(m.total));
    res.set("X-Page", String(m.page));
    res.set("X-Limit", String(m.limit));
    if (m.pages != null) res.set("X-Total-Pages", String(m.pages));
    if (m.hasMore != null) res.set("X-Has-More", m.hasMore ? "1" : "0");
  } catch { /* headers already sent */ }
}

/** For endpoints whose response body is a bare array. */
function sendList(res, items, pg, total, status = 200) {
  if (pg && pg.enabled) setHeaders(res, meta(pg, total));
  return res.status(status).json(items);
}

/** For endpoints whose response body is an object. */
function sendObject(res, body, pg, total, status = 200) {
  if (!pg || !pg.enabled) return res.status(status).json(body);
  const m = meta(pg, total);
  setHeaders(res, m);
  return res.status(status).json({ ...body, ...m });
}

/** Apply skip/limit to a mongoose query only when pagination is enabled. */
function applyPage(query, pg) {
  return pg && pg.enabled ? query.skip(pg.skip).limit(pg.limit) : query;
}

module.exports = { readPagination, sendList, sendObject, applyPage, meta };
