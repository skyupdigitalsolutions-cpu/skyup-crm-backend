// services/nonConversionService.js
// ─────────────────────────────────────────────────────────────────────────────
// NON-CONVERSION (LOST LEAD) ANALYSIS
//
// Builds an admin report of WHY leads didn't convert, WITHOUT asking agents to
// fill any extra form. It derives the reason from data already captured:
//   • lead.status            (e.g. "Not Interested", "Invalid", "Lost", closed)
//   • latest callHistory remark / lead.remark   (what the agent wrote)
//   • meetingRemarks                              (field-visit notes)
//   • MobileCallLog.summary                       (AI call summary, if available)
//
// It then:
//   1. Categorises each lost lead into a reason bucket via keyword heuristics.
//   2. Aggregates counts / % / by-source / by-agent.
//   3. Sends the aggregate to the LLM for root-cause patterns + concrete
//      improvement suggestions.
//
// Reuses the existing Groq client (callGrok) — same GROQ_API_KEY, no new creds.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose       = require("mongoose");
const Lead           = require("../models/Leads");
const MobileCallLog  = require("../models/MobileCallLog");
const { callGrok }   = require("../utils/leadActionSummary");

// Statuses that count as "did not convert". Matched case-insensitively; also
// includes isClosed leads. "Converted"/"Won" are explicitly excluded.
const LOST_STATUS_HINTS = [
  "not interested", "lost", "invalid", "rejected", "dead", "dropped",
  "closed", "unqualified", "spam", "do not contact",
];

// Reason buckets + keyword signals scanned across remark/summary text.
const REASON_RULES = [
  { reason: "Price / budget",          kw: ["price", "expensive", "costly", "budget", "afford", "too high", "cheap", "discount"] },
  { reason: "Bought from competitor",  kw: ["competitor", "already bought", "other vendor", "going with", "chose another", "someone else"] },
  { reason: "Not the right time",      kw: ["later", "next month", "next quarter", "not now", "timing", "future", "call back later", "postpone"] },
  { reason: "No response / unreachable", kw: ["no response", "not reachable", "not picking", "no answer", "switched off", "unreachable", "no reply", "not responding"] },
  { reason: "Wrong / invalid number",  kw: ["wrong number", "invalid", "incorrect number", "does not exist", "fake", "not in service"] },
  { reason: "Not decision maker",      kw: ["not decision", "decision maker", "will ask", "needs approval", "boss", "manager will decide"] },
  { reason: "Product / service mismatch", kw: ["not what", "different", "mismatch", "not suitable", "doesn't fit", "not relevant", "wrong product"] },
  { reason: "Lost interest",           kw: ["not interested", "no longer", "changed mind", "lost interest", "don't want", "not keen"] },
  { reason: "Duplicate / test lead",   kw: ["duplicate", "test", "by mistake", "accidental"] },
];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };

function isLostStatus(status = "", isClosed = false) {
  const s = String(status).toLowerCase();
  if (/^(converted|won|customer|closed won)$/.test(s)) return false;
  if (isClosed) return true;
  return LOST_STATUS_HINTS.some((h) => s.includes(h));
}

// Pick the most informative text for a lead: latest call remark → lead.remark →
// latest meeting remark → AI summary text.
function pickReasonText(lead, summaryText) {
  const ch = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  const lastRemark = ch.length ? (ch[ch.length - 1].remark || "") : "";
  const mr = Array.isArray(lead.meetingRemarks) ? lead.meetingRemarks : [];
  const lastMeeting = mr.length ? (mr[mr.length - 1].remark || "") : "";
  return [lastRemark, lead.remark, lastMeeting, summaryText]
    .filter(Boolean).join(" • ").trim();
}

function categorise(text, status) {
  const hay = `${text} ${status}`.toLowerCase();
  for (const rule of REASON_RULES) {
    if (rule.kw.some((k) => hay.includes(k))) return rule.reason;
  }
  return "Other / unspecified";
}

/**
 * Build the non-conversion analysis for a company over a date range.
 * @param {Object} opts
 * @param {string|ObjectId} opts.company
 * @param {string} [opts.from]  ISO date (defaults: 30 days ago)
 * @param {string} [opts.to]    ISO date (defaults: today)
 * @param {boolean} [opts.withAI=true]
 */
async function getNonConversionReport({ company, from, to, withAI = true }) {
  const toDate   = to   ? endOfDay(new Date(to))   : endOfDay(new Date());
  const fromDate = from ? startOfDay(new Date(from)) : startOfDay(new Date(Date.now() - 30 * 86400000));

  // Lost leads in range (by close time or last update).
  const leads = await Lead.find({
    company,
    mergedInto: null,
    $or: [
      { closedAt: { $gte: fromDate, $lte: toDate } },
      { updatedAt: { $gte: fromDate, $lte: toDate } },
    ],
  })
    .select("name status isClosed remark callHistory meetingRemarks source campaign user primaryPhone mobile phone value closedAt updatedAt")
    .populate("user", "name")
    .lean();

  const lost = leads.filter((l) => isLostStatus(l.status, l.isClosed));

  // Pull AI call summaries for these leads (joined by normalizedPhone).
  const phones = lost
    .map((l) => (l.primaryPhone || l.mobile || l.phone || "").replace(/\D/g, "").slice(-10))
    .filter(Boolean);

  const summaryByPhone = {};
  if (phones.length) {
    const logs = await MobileCallLog.find({
      company,
      normalizedPhone: { $in: phones },
      summary: { $ne: null },
    }).select("normalizedPhone summary").lean();
    for (const lg of logs) {
      const key = (lg.normalizedPhone || "").slice(-10);
      if (key && lg.summary && lg.summary.summary && !summaryByPhone[key]) {
        summaryByPhone[key] = lg.summary.summary;
      }
    }
  }

  // Categorise each lost lead.
  const byReason = {};
  const bySource = {};
  const byAgent  = {};
  const samples  = {};   // a few example remarks per reason for the AI

  for (const l of lost) {
    const phoneKey = (l.primaryPhone || l.mobile || l.phone || "").replace(/\D/g, "").slice(-10);
    const summaryText = summaryByPhone[phoneKey] || "";
    const text   = pickReasonText(l, summaryText);
    const reason = categorise(text, l.status);

    byReason[reason] = (byReason[reason] || 0) + 1;

    const src = l.source || l.campaign || "Unknown";
    bySource[src] = bySource[src] || {};
    bySource[src][reason] = (bySource[src][reason] || 0) + 1;

    const agent = l.user?.name || "Unassigned";
    byAgent[agent] = (byAgent[agent] || 0) + 1;

    if (!samples[reason]) samples[reason] = [];
    if (samples[reason].length < 5 && text) samples[reason].push(text.slice(0, 200));
  }

  const total = lost.length;
  const reasonBreakdown = Object.entries(byReason)
    .map(([reason, count]) => ({ reason, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  const result = {
    range: { from: fromDate, to: toDate },
    totalLost: total,
    reasonBreakdown,
    bySource,
    byAgent: Object.entries(byAgent).map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count),
    aiAnalysis: null,
  };

  // ── AI analysis ────────────────────────────────────────────────────────────
  if (withAI && total > 0) {
    try {
      result.aiAnalysis = await runAIAnalysis(reasonBreakdown, samples, result.bySource, total);
    } catch (e) {
      result.aiAnalysisError = e.code === "GROK_PAYLOAD_TOO_LARGE"
        ? "Too much data to analyse at once — narrow the date range."
        : (e.message || "AI analysis unavailable right now.");
    }
  }

  return result;
}

async function runAIAnalysis(reasonBreakdown, samples, bySource, total) {
  const systemPrompt =
    "You are a sales operations analyst. You are given an aggregate breakdown of " +
    "why leads did NOT convert (lost leads), with counts, percentages, and a few " +
    "example agent remarks per reason. Analyse the patterns and respond in strict " +
    "JSON only (no markdown), with this shape:\n" +
    "{\n" +
    '  "summary": "2-3 sentence overview of the biggest non-conversion drivers",\n' +
    '  "topReasons": [{"reason": "...", "insight": "why this is happening"}],\n' +
    '  "suggestions": ["concrete, specific improvement actions"],\n' +
    '  "dataQualityNote": "note if many reasons are Other/unspecified (poor remark hygiene)"\n' +
    "}\n" +
    "Be specific and practical. Tie suggestions to the actual reasons. If a large " +
    "share is 'Other / unspecified', call out that agents should log clearer remarks.";

  const lines = [`Total lost leads: ${total}`, "", "Reason breakdown:"];
  for (const r of reasonBreakdown) {
    lines.push(`- ${r.reason}: ${r.count} (${r.percent}%)`);
    if (samples[r.reason]?.length) {
      lines.push(`   examples: ${samples[r.reason].map((s) => `"${s}"`).join("; ")}`);
    }
  }
  lines.push("", "Lost-by-source:");
  for (const [src, reasons] of Object.entries(bySource)) {
    const parts = Object.entries(reasons).map(([rs, c]) => `${rs}=${c}`).join(", ");
    lines.push(`- ${src}: ${parts}`);
  }

  const raw = await callGrok(systemPrompt, lines.join("\n"), 900);

  // Tolerate code fences / stray text around the JSON.
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // If the model didn't return clean JSON, hand back the text as the summary.
    return { summary: cleaned, topReasons: [], suggestions: [], dataQualityNote: "" };
  }
}

module.exports = { getNonConversionReport };
