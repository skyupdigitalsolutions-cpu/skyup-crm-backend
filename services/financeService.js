// services/financeService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Core logic for the Finance Dashboard:
//   • per-company invoice numbering (INV-0001 …, prefix configurable)
//   • syncConvertedLeads(): turns every "won" lead into an invoice record
//   • IST date helpers (follow-up dates are calendar days, India time — same
//     convention as jobs/followUpReminderJob.js)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose        = require("mongoose");
const Counter         = require("../models/Counter");
const Lead            = require("../models/Leads");
const User            = require("../models/Users");
const FinanceInvoice  = require("../models/FinanceInvoice");
const FinanceSettings = require("../models/FinanceSettings");
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

// ── Settings ─────────────────────────────────────────────────────────────────
async function getSettings(companyId) {
  let s = await FinanceSettings.findOne({ company: companyId }).lean();
  if (!s) {
    try {
      s = (await FinanceSettings.create({ company: companyId })).toObject();
    } catch (e) {
      if (e.code === 11000) s = await FinanceSettings.findOne({ company: companyId }).lean();
      else throw e;
    }
  }
  return s;
}

function cleanPrefix(p) {
  const v = String(p || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.slice(0, 10) || "INV";
}

// ── Invoice numbering ────────────────────────────────────────────────────────
const counterId = (companyId) => `finance_invoice:${companyId}`;
const pad = (n) => String(n).padStart(4, "0");

/**
 * Atomically reserve the next invoice number for a company. Skips any number
 * already taken (e.g. one the admin typed in by hand), so it never collides.
 */
async function nextInvoiceNumber(companyId, prefix) {
  const p = cleanPrefix(prefix);
  for (let i = 0; i < 25; i++) {
    const doc = await Counter.findOneAndUpdate(
      { _id: counterId(companyId) },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const candidate = `${p}-${pad(doc.seq)}`;
    const taken = await FinanceInvoice.exists({ company: companyId, invoiceNumber: candidate });
    if (!taken) return candidate;
  }
  return `${p}-${Date.now().toString().slice(-8)}`;
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
  const alreadyInvoiced = await FinanceInvoice.distinct("lead", { company: cid, lead: { $ne: null } });

  const leads = await Lead.find({
    company:  cid,
    status:   { $in: wonKeys },
    mergedInto: null,
    isClosed: { $ne: true },
    _id:      { $nin: alreadyInvoiced },
  })
    .select("name businessName service services user assignedAdmin wonAt dealValue createdAt updatedAt callHistory.outcome callHistory.calledAt meetingRemarks.outcome meetingRemarks.metAt")
    .limit(500)
    .lean();

  if (!leads.length) return { created: 0 };

  // Oldest conversions first so invoice numbers follow conversion order
  const prepared = leads
    .map((l) => ({ lead: l, when: deriveConversionDate(l, wonKeys) }))
    .sort((a, b) => a.when - b.when);

  const settings = await getSettings(cid);
  const userIds  = [...new Set(prepared.map((p) => p.lead.user).filter(Boolean).map(String))];
  const users    = userIds.length ? await User.find({ _id: { $in: userIds } }).select("name").lean() : [];
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  let created = 0;
  for (const { lead, when } of prepared) {
    const invoiceNumber = await nextInvoiceNumber(cid, settings.invoicePrefix);
    const total = Number(lead.dealValue) > 0 ? Number(lead.dealValue) : 0;
    const doc = new FinanceInvoice({
      company: cid,
      source: "lead",
      lead: lead._id,
      invoiceNumber,
      customerName: lead.name || "Unnamed lead",
      businessName: lead.businessName || "",
      service: (lead.services && lead.services.length ? lead.services.join(", ") : lead.service) || "",
      assignedTo: lead.user || null,
      assignedToName: lead.user ? userName.get(String(lead.user)) || "" : "",
      assignedAdmin: lead.assignedAdmin || null,
      createdBy: { id: null, name: "Auto (lead converted)", role: "system" },
      conversionDate: when,
      totalAmount: total,
      remarks: [{ text: "Invoice created automatically from converted lead.", kind: "system", byName: "System", byRole: "system" }],
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
  getSettings, cleanPrefix, nextInvoiceNumber,
  toDTO, deriveConversionDate, syncConvertedLeads,
};
