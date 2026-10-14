// utils/followUpRemarks.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// What the EMPLOYEE actually wrote about a follow-up — vs text the system fills in.
//
// A follow-up (lead.scheduledCalls entry) only stores a date and a `note`, and that note is usually written by
// the system, not the employee:
//     Follow-up after status "In Progress" — outcome: Call Back      ← employee updated the lead (system text)
//     Auto follow-up after Not Interested / 7-day verification call  ← a workflow created it (automatic)
// What the employee typed is saved separately, as the remark on the lead's call history (callHistory[].remark).
//
// So for each follow-up we return:
//   origin          'employee' (set by an employee) | 'auto' (created by a workflow / verification)
//   employeeRemark  the latest remark an employee really typed on that lead { text, by, at } (null if none)
//   customNote      the follow-up's own note ONLY when a person wrote it (system text is dropped)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// An auto-generated call remark ("Outgoing call … from mobile app") is NOT something the employee wrote.
// Same rule the call-log screens already use (controllers/mobileCallLogController.js).
const AUTO_REMARK_RX = /^(outgoing|incoming|missed|rejected|voicemail|blocked|unknown)?\s*call\b.*from mobile app/i;
const isRealRemark = (r) => !!(r && String(r).trim() && !AUTO_REMARK_RX.test(String(r).trim()));

const norm = (s) => String(s || "").trim().toLowerCase();

// System text written when an employee updates a lead and a follow-up is scheduled with it
const EMPLOYEE_SYSTEM_NOTE_RX = /^follow-up after status\b/i;
// Notes workflows write when THEY create follow-ups
const AUTO_NOTE_RX = /^auto follow-up|verification call\s*$/i;

// Every follow-up note the company's workflows can create (Customize CRM → Workflows), so a custom wording is
// still recognised as automatic.
function collectAutoNotes(cust) {
  const set = new Set();
  const wf = (cust && cust.workflows) || {};
  for (const flow of Object.values(wf)) {
    for (const f of (flow && Array.isArray(flow.followUps) ? flow.followUps : [])) {
      if (f && f.note) set.add(norm(f.note));
    }
  }
  return set;
}

function classifyFollowUp(row, autoNotes) {
  if (!row) return "employee";
  if (row.type === "verification") return "auto";
  const n = String(row.note || "").trim();
  if (AUTO_NOTE_RX.test(n)) return "auto";
  if (n && autoNotes && autoNotes.has(norm(n))) return "auto";
  return "employee";
}

const MAX = 500;
const clip = (t) => String(t).trim().slice(0, MAX);

// The latest remark an employee really typed. `recentRemarks` = the lead's last few callHistory entries
// (oldest → newest); falls back to the lead's own `remark` field when it is real text.
function pickEmployeeRemark(row) {
  const hist = Array.isArray(row && row.recentRemarks) ? row.recentRemarks : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h && isRealRemark(h.remark)) {
      return { text: clip(h.remark), by: h.userName || null, at: h.calledAt || null };
    }
  }
  if (row && isRealRemark(row.remark)) return { text: clip(row.remark), by: null, at: null };
  return null;
}

// Adds origin / employeeRemark / customNote and drops the bulky helper field.
function enrichFollowUp(row, autoNotes) {
  const origin = classifyFollowUp(row, autoNotes);
  const note = String(row.note || "").trim();
  const isSystem = !note || origin === "auto" || EMPLOYEE_SYSTEM_NOTE_RX.test(note);
  const { recentRemarks, ...rest } = row;           // eslint-disable-line no-unused-vars
  return {
    ...rest,
    origin,
    employeeRemark: pickEmployeeRemark(row),
    customNote: isSystem ? "" : note,
  };
}

module.exports = { AUTO_REMARK_RX, isRealRemark, collectAutoNotes, classifyFollowUp, pickEmployeeRemark, enrichFollowUp };
