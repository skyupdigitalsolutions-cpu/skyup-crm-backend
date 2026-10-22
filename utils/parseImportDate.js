// utils/parseImportDate.js
// ─────────────────────────────────────────────────────────────────────────────
// Read the "date" column of an uploaded leads file into a real Date, so an imported lead keeps the date it was
// actually created (in the file) instead of the moment it was imported. Used by both import paths in leadController.
//
// Accepts, in this order:
//   • a real Date, or an Excel serial number (what xlsx gives for a date cell, e.g. 45843 = 2025-07-04)
//   • ISO-like text: 2026-07-04, 2026-07-04 15:30, 2026/07/04, 2026.07.04
//   • day-first or month-first text: 04-07-2026, 04/07/2026, 4 Jul 2026, Jul 4 2026, 04-Jul-2026
// A 4-digit group tells us which part is the year. For an all-numeric date with no 4-digit year (03/04/2026 style),
// dayFirst decides (default true — day/month/year, the common form in India). An unreadable or out-of-range value
// returns null, and the caller falls back to "now".
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MIN_YEAR = 2000;

function clampValid(y, m, d, hh = 0, mm = 0, ss = 0) {
  if (!(y >= MIN_YEAR && y <= 2100) || m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(y, m, d, hh, mm, ss, 0);
  // reject roll-overs like 31 Feb (JS would turn it into early March)
  if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) return null;
  const now = Date.now();
  if (dt.getTime() > now + 2 * 86400000) return null;        // not in the future (2-day grace for time zones)
  if (dt.getTime() < Date.UTC(MIN_YEAR, 0, 1)) return null;
  return dt;
}

/** Excel stores a date as days since 1899-12-30 (its own epoch, including the famous 1900 leap-year bug offset). */
function fromExcelSerial(n) {
  if (!(n > 0) || n > 60000) return null;                    // 60000 ≈ year 2064, well past anything real
  const ms = Math.round((n - 25569) * 86400000);             // 25569 = days from 1970-01-01 to the Excel epoch
  const dt = new Date(ms);
  return clampValid(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours(), dt.getUTCMinutes());
}

function parseImportDate(value, { dayFirst = true } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : clampValid(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds());
  if (typeof value === "number") return fromExcelSerial(value);

  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return fromExcelSerial(Number(s));     // a serial number arriving as text

  // split into a time part and a date part
  const timeMatch = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hh = timeMatch ? Number(timeMatch[1]) : 0, mm = timeMatch ? Number(timeMatch[2]) : 0, ss = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const datePart = s.replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?/i, "").trim();

  // a named month anywhere: "4 Jul 2026", "Jul 4, 2026", "04-Jul-2026"
  const mon = datePart.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  if (mon) {
    const nums = datePart.match(/\d+/g) || [];
    const year = nums.find((n) => n.length === 4);
    const day = nums.find((n) => n !== year && Number(n) >= 1 && Number(n) <= 31);
    if (year && day) return clampValid(Number(year), MONTHS[mon[1]], Number(day), hh, mm, ss);
    return null;
  }

  const parts = datePart.split(/[-/.]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  let [a, b, c] = parts.map(Number);

  if (parts[0].length === 4) return clampValid(a, b - 1, c, hh, mm, ss);          // YYYY-MM-DD
  if (parts[2].length === 4) {                                                    // DD-MM-YYYY or MM-DD-YYYY
    const [d, m] = dayFirst ? [a, b] : [b, a];
    const byChosen = clampValid(c, m - 1, d, hh, mm, ss);
    if (byChosen) return byChosen;
    // if the chosen order is impossible (e.g. 13 as a month), try the other order before giving up
    const [d2, m2] = dayFirst ? [b, a] : [a, b];
    return clampValid(c, m2 - 1, d2, hh, mm, ss);
  }
  return null;                                                                    // ambiguous 2-digit year — don't guess
}

module.exports = { parseImportDate };
