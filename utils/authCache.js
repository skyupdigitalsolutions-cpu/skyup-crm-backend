// utils/authCache.js
// ─────────────────────────────────────────────────────────────────────────────
// Short-lived in-process cache for the documents every authenticated request
// loads (Admin + populated Company, User, Company subscription fields).
//
// Before: each admin API call did Admin.findById().populate("company") — two
// MongoDB round-trips that load the WHOLE company document — before the real
// work even started. A page that fires 6-8 API calls paid that 6-8 times.
//
// Safety:
//  • Entries are stored as plain (lean) objects and every request gets its own
//    hydrated copy, so one request mutating req.admin never leaks to another.
//  • Model hooks (Company / Admin / User) call invalidate*() on every write, so
//    plan changes, payments, suspensions and role changes apply immediately on
//    this server. TTL (20s) bounds staleness across multiple pm2 instances.
// ─────────────────────────────────────────────────────────────────────────────
const TTL_MS = 20 * 1000;
const MAX_ENTRIES = 5000;

const stores = {
  admin:   new Map(), // adminId   → { value, companyId, exp }
  user:    new Map(), // userId    → { value, companyId, exp }
  company: new Map(), // companyId → { value, exp }
};

const idOf = (v) => (v == null ? "" : String(v._id || v));

function get(kind, id) {
  const m = stores[kind];
  const key = idOf(id);
  const e = m.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { m.delete(key); return null; }
  return e.value;
}

function set(kind, id, value, companyId) {
  const m = stores[kind];
  if (m.size >= MAX_ENTRIES) m.delete(m.keys().next().value); // drop oldest
  m.set(idOf(id), { value, companyId: companyId ? idOf(companyId) : null, exp: Date.now() + TTL_MS });
}

function invalidate(kind, id) {
  stores[kind].delete(idOf(id));
}

// A company changed → drop it and every admin/user entry that embeds it.
function invalidateCompany(companyId) {
  const cid = idOf(companyId);
  stores.company.delete(cid);
  for (const kind of ["admin", "user"]) {
    for (const [k, e] of stores[kind]) if (e.companyId === cid) stores[kind].delete(k);
  }
}

function clear(kind) {
  if (kind) stores[kind].clear();
  else Object.values(stores).forEach((m) => m.clear());
}

/**
 * Attach write hooks to a schema so any change invalidates the cache.
 * Must be called BEFORE mongoose.model(...).
 *   kind: "admin" | "user" | "company"
 */
function attachInvalidation(schema, kind) {
  const drop = (id) => {
    if (!id) return;
    if (kind === "company") invalidateCompany(id);
    else invalidate(kind, id);
  };
  const dropAll = () => {
    if (kind === "company") { clear("company"); clear("admin"); clear("user"); }
    else clear(kind);
  };

  schema.post("save", function (doc) { drop(doc && doc._id); });

  const singleQueryHooks = ["findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "updateOne", "replaceOne", "deleteOne"];
  schema.post(singleQueryHooks, { document: false, query: true }, function () {
    try {
      const q = this.getQuery ? this.getQuery() : {};
      const id = q && q._id;
      if (id && (typeof id !== "object" || id._bsontype || id.toHexString)) drop(id);
      else dropAll();
    } catch (_) { dropAll(); }
  });
  schema.post(["updateMany", "deleteMany", "bulkWrite"], function () { dropAll(); });
  schema.post("deleteOne", { document: true, query: false }, function (doc) { drop(doc && doc._id); });
}

module.exports = { get, set, invalidate, invalidateCompany, clear, attachInvalidation, TTL_MS };
