// services/quotationNumberService.js — atomic, per-company, per-year quotation numbers.
// Uses the existing Counter collection. Numbers reset each year and never repeat (gaps allowed — a deleted
// quotation's number is never reissued). Format: PREFIX/YEAR/0001 (prefix defaults to "SKY").
const Counter = require("../models/Counter");

async function nextQuotationNumber(companyId, { prefix = "SKY", year } = {}) {
  const y = year || new Date().getFullYear();
  const key = `quotation:${String(companyId)}:${y}`;
  // Atomic increment — concurrent requests never collide or skip.
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const seq = doc.seq;
  const padded = String(seq).padStart(4, "0");
  return { number: `${prefix}/${y}/${padded}`, seq, year: y };
}

module.exports = { nextQuotationNumber };
