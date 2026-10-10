// services/financeService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Core logic for the Finance Dashboard:
//   • syncConvertedLeads(): turns every "won" lead into ONE invoice record
//     (no invoice number — finance types it in by hand; numbers are never generated)
//   • service / client-source helpers shared by the controller
//   • IST date helpers (follow-up dates are calendar days, India time — same
//     convention as jobs/followUpReminderJob.js)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose        = require("mongoose");
const Lead            = require("../models/Leads");
const User            = require("../models/Users");
const FinanceInvoice  = require("../models/FinanceInvoice");
const { istDayKey }   = require("../utils/istDate");

// ── IST helpers ──────────────────────────────────────────────────────────────
function todayKey(now = new Date()) { return istDayKey(now); }

/** "YYYY-MM-DD" (or any date string / Date) → Date at 00:00 IST of that day. */
function parseDay(input) {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input) ? null : new Date(`${istDayKey(input)}T00:00:00+05:30`);
  const s = String(input).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) {
    const d = new Date(`${m[1]}T00:00:00+05:30`);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : new Date(`${istDayKey(d)}T00:00:00+05:30`);
}

function endOfDay(key) { return new Date(`${key}T23:59:59.999+05:30`); }

// ── Services (several per invoice) ───────────────────────────────────────────
/**
 * Validate / clean a services array from the UI.
 * Returns { services } or { error }. Every line needs a name and an amount > 0
 * (unless allowZero — used only for auto-created lead invoices).
 */
function cleanServices(input, { allowZero = false } = {}) {
  if (!Array.isArray(input) || input.length === 0) return { error: "Add at least one service." };
  if (input.length > 30) return { error: "Too many services on one invoice (max 30)." };
  const out = [];
  for (const row of input) {
    const name = String((row && row.name) || "").trim();
    const amount = Math.round(Number(row && row.amount) * 100) / 100;
    if (!name) return { error: "Every service needs a name." };
    if (name.length > 120) return { error: "A service name is too long." };
    if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
      return { error: `Enter an amount greater than 0 for "${name}".` };
    }
    out.push({ name, amount });
  }
  return { services: out };
}

const REFERRAL_RE = /refer/i;
/** A referral source needs a "referred by" name; other sources must not carry one. */
function cleanSource(source, referredBy) {
  const clientSource = String(source || "").trim().slice(0, 60);
  let ref = String(referredBy || "").trim().slice(0, 120);
  if (REFERRAL_RE.test(clientSource)) {
    if (!ref) return { error: "Enter who referred this client." };
  } else {
    ref = "";
  }
  return { clientSource, referredBy: ref };
}

/** Source + service dropdown values from the company's Customize CRM lists. */
async function listOptions(companyId) {
  let sources = [], services = [];
  try {
    const svc = require("./customizationService");
    const cust = await svc.getCustomization(companyId);
    sources  = (cust && cust.lists && cust.lists.sources)  || [];
    services = (cust && cust.lists && cust.lists.services) || [];
  } catch (e) { /* fall back to empty lists */ }
  sources = sources.map(String).filter(Boolean);
  if (!sources.some((x) => REFERRAL_RE.test(x))) sources.push("Referral");
  return { sources, services: services.map(String).filter(Boolean) };
}

// ── One-time clean-up of data / indexes from the first release ───────────────
// The first version numbered invoices automatically (unique index on number) and
// allowed one invoice per lead (unique index on lead). Both rules are gone, so
// drop those indexes and give old records a clientId.
let _migration = null;
function migrateLegacy() {
  if (_migration) return _migration;
  _migration = (async () => {
    try {
      const col = FinanceInvoice.collection;
      let idx = [];
      try { idx = await col.indexes(); } catch (e) { return; }   // collection not created yet
      for (const i of idx) {
        if (i.name === "company_1_invoiceNumber_1" || i.name === "company_1_lead_1") {
          await col.dropIndex(i.name);
          console.log(`[finance] dropped legacy index ${i.name}`);
        }
      }
      await FinanceInvoice.updateMany(
        { clientId: null },
        [{ $set: { clientId: { $ifNull: ["$lead", "$_id"] }, autoCreated: { $eq: ["$source", "lead"] } } }]
      );
      await FinanceInvoice.syncIndexes().catch(() => {});
    } catch (e) {
      console.error("[finance] legacy migration failed:", e.message);
      _migration = null; // allow a retry
    }
  })();
  return _migration;
}

// ── Money / serialisation ────────────────────────────────────────────────────
function toDTO(inv, now = new Date()) {
  const o = typeof inv.toObject === "function" ? inv.toObject() : inv;
  const today = todayKey(now);
  const fu = o.nextFollowUpDate ? istDayKey(o.nextFollowUpDate) : null;
  const open = o.status === "active" && o.paymentStatus !== "paid";
  return {
    ...o,
    partsPaid: (o.payments || []).length,
    followUpDay: fu,
    isOverdue: !!(open && fu && fu < today),
    isDueToday: !!(open && fu && fu === today),
    // Sort newest-first inside the payload so the UI doesn't have to
    payments: [...(o.payments || [])].sort((a, b) => new Date(b.paidOn) - new Date(a.paidOn)),
    remarks:  [...(o.remarks  || [])].sort((a, b) => new Date(b.at)     - new Date(a.at)),
  };
}

// ── Conversion date ──────────────────────────────────────────────────────────
// The CRM keeps no "status changed at" stamp, so derive it from the best signal
// available: explicit wonAt → a call/meeting whose outcome was a won status →
// the lead's last update. Admins can correct it on the invoice.
function deriveConversionDate(lead, wonKeys) {
  if (lead.wonAt) return new Date(lead.wonAt);
  const won = new Set((wonKeys || []).map((k) => String(k).toLowerCase()));
  let best = null;
  const consider = (d) => { if (d && (!best || new Date(d) > best)) best = new Date(d); };
  for (const c of lead.callHistory || []) if (won.has(String(c.outcome || "").toLowerCase())) consider(c.calledAt);
  for (const m of lead.meetingRemarks || []) if (won.has(String(m.outcome || "").toLowerCase())) consider(m.metAt);
  return best || new Date(lead.updatedAt || lead.createdAt || Date.now());
}

// ── Sync converted leads → invoices ──────────────────────────────────────────
const _running = new Map();   // companyId → Promise (de-dupe concurrent runs)
const _lastRun = new Map();   // companyId → timestamp
const SYNC_MIN_GAP_MS = 60 * 1000;

async function _doSync(companyId) {
  const svc  = require("./customizationService");
  const cust = await svc.getCustomization(companyId);
  const wonKeys = svc.statusKeysByCategory(cust, "won");
  if (!wonKeys.length) return { created: 0 };

  const cid = new mongoose.Types.ObjectId(String(companyId));
  await migrateLegacy();
  // A converted lead that already has ANY invoice is not re-created
  const alreadyInvoiced = await FinanceInvoice.distinct("lead", { company: cid, lead: { $ne: null } });

  const leads = await Lead.find({
    company:  cid,
    status:   { $in: wonKeys },
    mergedInto: null,
    isClosed: { $ne: true },
    _id:      { $nin: alreadyInvoiced },
  })
    .select("name businessName source service services user assignedAdmin wonAt dealValue createdAt updatedAt callHistory.outcome callHistory.calledAt meetingRemarks.outcome meetingRemarks.metAt")
    .limit(500)
    .lean();

  if (!leads.length) return { created: 0 };

  // Oldest conversions first so invoice numbers follow conversion order
  const prepared = leads
    .map((l) => ({ lead: l, when: deriveConversionDate(l, wonKeys) }))
    .sort((a, b) => a.when - b.when);

  const userIds  = [...new Set(prepared.map((p) => p.lead.user).filter(Boolean).map(String))];
  const users    = userIds.length ? await User.find({ _id: { $in: userIds } }).select("name").lean() : [];
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  let created = 0;
  for (const { lead, when } of prepared) {
    const total = Number(lead.dealValue) > 0 ? Number(lead.dealValue) : 0;
    const names = (lead.services && lead.services.length ? lead.services : [lead.service]).map((n) => String(n || "").trim()).filter(Boolean);
    // One service → it carries the deal value. Several → names only, amounts to be filled in.
    const services = names.length === 1 ? [{ name: names[0], amount: total }] : names.map((name) => ({ name, amount: 0 }));
    const doc = new FinanceInvoice({
      company: cid,
      source: "lead",
      autoCreated: true,
      lead: lead._id,
      clientId: lead._id,
      invoiceNumber: "",                       // finance adds this by hand
      customerName: lead.name || "Unnamed lead",
      businessName: lead.businessName || "",
      clientSource: String(lead.source || "").slice(0, 60),
      services,
      assignedTo: lead.user || null,
      assignedToName: lead.user ? userName.get(String(lead.user)) || "" : "",
      assignedAdmin: lead.assignedAdmin || null,
      createdBy: { id: null, name: "Auto (lead converted)", role: "system" },
      conversionDate: when,
      totalAmount: total,
      remarks: [{ text: "Added automatically from a converted lead. Add the invoice number to complete it.", kind: "system", byName: "System", byRole: "system" }],
    });
    doc.recalc();
    try {
      await doc.save();
      created++;
    } catch (e) {
      if (e.code === 11000) continue; // another sync got there first — fine
      console.error("[finance] sync save failed:", e.message);
    }
  }
  if (created) console.log(`[finance] company ${cid}: ${created} converted lead(s) added to Finance Dashboard`);
  return { created };
}

/**
 * Create invoice records for any converted lead that doesn't have one yet.
 * Safe to call often: concurrent calls share one run, and repeat calls within
 * a minute are skipped unless { force: true }.
 */
async function syncConvertedLeads(companyId, { force = false } = {}) {
  const key = String(companyId);
  if (_running.has(key)) return _running.get(key);
  if (!force && Date.now() - (_lastRun.get(key) || 0) < SYNC_MIN_GAP_MS) return { created: 0, skipped: true };
  const p = _doSync(companyId)
    .catch((e) => { console.error("[finance] syncConvertedLeads failed:", e.message); return { created: 0, error: e.message }; })
    .finally(() => { _running.delete(key); _lastRun.set(key, Date.now()); });
  _running.set(key, p);
  return p;
}

module.exports = {
  todayKey, parseDay, endOfDay,
  cleanServices, cleanSource, listOptions, migrateLegacy,
  toDTO, deriveConversionDate, syncConvertedLeads,
};
