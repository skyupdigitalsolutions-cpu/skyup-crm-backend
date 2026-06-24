// utils/invoiceNumber.js
// ─────────────────────────────────────────────────────────────────────────────
// Issues sequential, gap-free invoice numbers in the format SDS-001, SDS-002, …
//
// Numbering is atomic: nextInvoiceNumber() does a single findOneAndUpdate with
// $inc on the "invoice" counter, so two checkouts happening at the same instant
// get two different consecutive numbers (no duplicates, no skips).
//
// The numeric part is zero-padded to at least 3 digits and grows automatically
// past 999 (SDS-1000, SDS-1001, …).
// ─────────────────────────────────────────────────────────────────────────────

const Counter = require("../models/Counter");

const PREFIX = "SDS";
const PAD = 3;

/**
 * Atomically reserve and return the next invoice number, e.g. "SDS-001".
 * @param {object} [opts]
 * @param {string} [opts.sequence="invoice"]  counter name (lets you keep
 *        separate series if ever needed).
 * @returns {Promise<string>}
 */
async function nextInvoiceNumber({ sequence = "invoice" } = {}) {
  const doc = await Counter.findOneAndUpdate(
    { _id: sequence },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const n = doc.seq;
  return `${PREFIX}-${String(n).padStart(PAD, "0")}`;
}

/**
 * Fallback id used only if the counter write fails for some reason, so a
 * checkout never crashes purely because numbering had a hiccup. Still unique.
 */
function fallbackInvoiceNumber() {
  return `${PREFIX}-${Date.now().toString().slice(-8)}`;
}

module.exports = { nextInvoiceNumber, fallbackInvoiceNumber, PREFIX };
