// utils/mergeImportedLead.js
// ─────────────────────────────────────────────────────────────────────────────
// When a leads file is re-uploaded and a lead with that phone already exists, update it instead of rejecting the row.
//
// Rule chosen by the business: "file wins" — a value in the file REPLACES what's on the lead — BUT done safely:
//   • A BLANK cell in the file never wipes real data. Only a non-empty value overwrites.
//   • Fields that represent WORK the team has done are protected and never overwritten by an import:
//       status, temperature, the assigned employee/admin, call history, follow-ups, recordings, conversion/finance.
//     (The file is the source of the lead's contact details, not of the team's progress on it.)
//   • A lead that has already been worked (has call history) is NOT touched at all — returned as "skipped".
//   • The lead's original created date is kept (so "leads created today" counts don't move); only updatedAt changes.
//   • A remark from the file is appended with a dated note, never overwritten, so earlier remarks are never lost.
//
// buildLeadUpdate returns { update, changed } — `update` is a $set-style object of only the fields that actually
// change (empty when nothing changes), and `changed` lists them for the import summary. It decides nothing about the
// database; the caller applies it. This keeps it pure and fully testable.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Contact / descriptive fields the file is allowed to overwrite (when the file's value is non-empty).
const OVERWRITABLE = ["name", "email", "source", "campaign", "businessName", "industry", "secondaryPhone", "normalizedSecondaryPhone", "leadgenId"];
// Fields the file may only FILL when the lead has none (never overwrite an existing value).
const FILL_ONLY = ["service", "services"];
// Never touched by an import, whatever the file says — these are the team's work.
const PROTECTED = new Set(["status", "temperature", "user", "assignedAdmin", "poolAdmins", "callHistory", "scheduledCalls", "recordings", "convertedAt", "dealValue", "revenueReceived", "isClosed", "previousAgents", "interestedBlastSentAt", "createdAt", "date"]);

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
// Generic placeholders the importer fills in when a column is empty — they must never overwrite a real stored value.
const GENERIC_SOURCE = new Set(["excel import", "csv import", "import", "imported"]);
const isPlaceholderSource = (v) => typeof v === "string" && GENERIC_SOURCE.has(v.trim().toLowerCase());
const norm = (v) => (typeof v === "string" ? v.trim() : v);
const sameValue = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
  return norm(a) === norm(b) || (isBlank(a) && isBlank(b));
};

/**
 * @param existing  the lead already in the database (plain object)
 * @param incoming  the fields parsed from the uploaded row (a would-be new lead doc)
 * @param opts      { appendRemark=true, now=Date }
 * @returns { skip, reason?, update, changed, remarkAppended }
 */
function buildLeadUpdate(existing, incoming, opts = {}) {
  const now = opts.now || new Date();
  const appendRemark = opts.appendRemark !== false;

  // A lead someone has already worked is left completely alone.
  if (Array.isArray(existing.callHistory) && existing.callHistory.length > 0) {
    return { skip: true, reason: "already worked (has call history)", update: {}, changed: [], remarkAppended: false };
  }

  const update = {};
  const changed = [];

  for (const f of OVERWRITABLE) {
    if (PROTECTED.has(f)) continue;
    let val = incoming[f];
    if (f === "source" && isPlaceholderSource(val)) continue;   // a generic "Excel Import" never overwrites a real source
    if (!isBlank(val) && !sameValue(val, existing[f])) { update[f] = norm(val); changed.push(f); }
  }
  // keep the phone's normalized form in step if the secondary changed
  if ("secondaryPhone" in update && isBlank(incoming.normalizedSecondaryPhone) && incoming.secondaryPhone) {
    // leave normalization to the caller if it didn't supply one
  }

  for (const f of FILL_ONLY) {
    const val = incoming[f];
    if (!isBlank(val) && isBlank(existing[f]) && !sameValue(val, existing[f])) { update[f] = val; changed.push(f); }
  }

  // Remark: never overwrite. Append the file's remark as a dated line if it adds anything new.
  let remarkAppended = false;
  const incRemark = norm(incoming.remark);
  const GENERIC = new Set(["imported via excel", "imported via csv", "imported"]);
  if (appendRemark && incRemark && !GENERIC.has(incRemark.toLowerCase())) {
    const prev = typeof existing.remark === "string" ? existing.remark : "";
    if (!prev.includes(incRemark)) {
      const stamp = now.toISOString().slice(0, 10);
      update.remark = prev ? `${prev}\n[re-import ${stamp}] ${incRemark}` : incRemark;
      changed.push("remark");
      remarkAppended = true;
    }
  }

  if (changed.length > 0) update.updatedAt = now;
  return { skip: false, update, changed, remarkAppended };
}

module.exports = { buildLeadUpdate, OVERWRITABLE, FILL_ONLY, PROTECTED };
