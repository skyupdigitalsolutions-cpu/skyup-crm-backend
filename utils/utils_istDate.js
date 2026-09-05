// utils/istDate.js
//
// Small shared helpers for working with India/IST calendar days, independent
// of the server's own timezone. Same approach already used locally inside
// jobs/followUpReminderJob.js — pulled out here so the FestivalCampaign model
// (which stamps `sendDateKey` on save) and jobs/festivalCampaignJob.js (which
// asks "what's today's IST key?") can't drift out of sync with each other.

"use strict";

const IST_TIMEZONE = "Asia/Kolkata";

// ── IST calendar-day key, e.g. "2026-11-08" — for exact same-day matching ───
// Accepts a Date (or anything Date() can parse) in any timezone and returns
// the zero-padded calendar day it falls on when viewed from IST, so it can be
// compared directly against "YYYY-MM-DD" strings (e.g. the dates in
// utils/festivalTemplateCatalog.js) without any extra parsing.
function istDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

module.exports = { IST_TIMEZONE, istDayKey };
