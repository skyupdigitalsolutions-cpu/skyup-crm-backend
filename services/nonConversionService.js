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
//   2. Classifies each lead's ACCOUNTABILITY — is the blocker an agent
//      follow-up gap, or something lead-side / external (price, fit, etc.)?
//   3. Aggregates counts / % / by-source / by-agent / by-accountability.
//   4. Sends the aggregate to the LLM for root-cause patterns + concrete
//      improvement suggestions.
//
// Reuses the existing Groq client (callGrok) — same GROQ_API_KEY, no new creds.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose       = require("mongoose");
const Lead           = require("../models/Leads");
const MobileCallLog  = require("../models/MobileCallLog");
const { callGrok }   = require("../utils/leadActionSummary");
const { mergeLeadScope } = require("../utils/adminLeadScope");

// Retry the AI call on transient rate limits (HTTP 429), honoring Retry-After
// and backing off, so a 429 doesn't surface as a raw error in the
// Non-Conversion Analysis panel.
async function callGrokWithRetry(systemPrompt, userContent, maxTokens, maxRetries = 2) {
  let attempt = 0;
  for (;;) {
    try {
      return await callGrok(systemPrompt, userContent, maxTokens);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = Number(e?.response?.headers?.["retry-after"]);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

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

// Canonical accountability buckets (must match frontend ACCT_STYLE keys).
const ACCOUNTABILITY_LABELS = [
  "Agent follow-up gap",
  "Awaiting next step",
  "Lead not interested",
  "Price/budget",
  "Bad lead data",
  "Product/fit",
  "No data",
];

// Quick heuristic fallback (used before/if the AI pass doesn't override it),
// derived from the keyword-bucketed reason.
const REASON_TO_ACCOUNTABILITY = {
  "Price / budget":                "Price/budget",
  "Bought from competitor":        "Lead not interested",
  "Not the right time":            "Awaiting next step",
  "No response / unreachable":     "Awaiting next step",
  "Wrong / invalid number":        "Bad lead data",
  "Not decision maker":            "Awaiting next step",
  "Product / service mismatch":    "Product/fit",
  "Lost interest":                 "Lead not interested",
  "Duplicate / test lead":         "Bad lead data",
  "Other / unspecified":           "No data",
};
function defaultAccountability(reason) {
  return REASON_TO_ACCOUNTABILITY[reason] || "No data";
}

const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };

// "Did not convert" = any lead whose status is NOT a converted/won state.
// This intentionally includes New / In Progress / Verification / Not Interested
// / Invalid / Lost etc. — everything that hasn't been won yet — so the report
// covers ALL non-converted leads, not just explicitly "lost" ones.
function isNonConverted(status = "", isClosed = false) {
  const s = String(status).toLowerCase().trim();
  // Converted / won states are the ONLY thing excluded.
  if (/^(converted|won|customer|closed won|closed-won|complete[d]?)$/.test(s)) return false;
  return true;
}

// Pick the most informative text for a lead: latest call remark → lead.remark →
// latest meeting remark → AI summary text.
function pickReasonText(lead, summaryText) {
  const ch = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  // Use the last few call remarks (not just the latest) so the AI sees the
  // progression — e.g. "interested" → "asked for callback" → "no response".
  const recentRemarks = ch
    .slice(-4)
    .map((c) => (c && c.remark ? String(c.remark).trim() : ""))
    .filter(Boolean);

  const mr = Array.isArray(lead.meetingRemarks) ? lead.meetingRemarks : [];
  const lastMeeting = mr.length ? (mr[mr.length - 1].remark || "") : "";

  return [...recentRemarks, lead.remark, lastMeeting, summaryText]
    .filter(Boolean)
    .join(" • ")
    .trim();
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
async function getNonConversionReport({ company, from, to, withAI = true, leadScope = {} }) {
  const toDate   = to   ? endOfDay(new Date(to))   : endOfDay(new Date());
  const fromDate = from ? startOfDay(new Date(from)) : startOfDay(new Date(Date.now() - 30 * 86400000));

  // Candidate leads in range (created, last-updated, or closed within range).
  const leads = await Lead.find(mergeLeadScope({
    company,
    mergedInto: null,
    $or: [
      { createdAt: { $gte: fromDate, $lte: toDate } },
      { closedAt:  { $gte: fromDate, $lte: toDate } },
      { updatedAt: { $gte: fromDate, $lte: toDate } },
    ],
  }, leadScope))
    .select("name status isClosed remark callHistory meetingRemarks source campaign user primaryPhone mobile phone value temperature closedAt updatedAt createdAt leadScore maxScore qualificationPercentage leadCategory qualificationBreakdown")
    .populate("user", "name")
    .lean();

  // All NON-CONVERTED leads (everything except Converted/Won).
  const lost = leads.filter((l) => isNonConverted(l.status, l.isClosed));

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
      const s = lg.summary;
      if (key && s && !summaryByPhone[key]) {
        // Combine the richer parts of the AI call summary, not just the headline:
        // the summary text + key points + recommended next action + sentiment.
        const parts = [];
        if (s.summary)    parts.push(s.summary);
        if (Array.isArray(s.keyPoints) && s.keyPoints.length) parts.push("Key points: " + s.keyPoints.join("; "));
        if (s.nextAction) parts.push("Suggested next action: " + s.nextAction);
        if (s.sentiment)  parts.push("Sentiment: " + s.sentiment);
        const combined = parts.filter(Boolean).join(" • ").trim();
        if (combined) summaryByPhone[key] = combined;
      }
    }
  }

  // Categorise each non-converted lead + build a per-lead detail list.
  const byReason = {};
  const byAccountability = {};
  const bySource = {};
  const byAgent  = {};
  const samples  = {};   // a few example remarks per reason for the AI
  const leadDetails = []; // per-lead: name, status, reason, accountability, improvement, etc.

  for (const l of lost) {
    const phoneKey = (l.primaryPhone || l.mobile || l.phone || "").replace(/\D/g, "").slice(-10);
    const summaryText = summaryByPhone[phoneKey] || "";
    const text   = pickReasonText(l, summaryText);
    // Keyword bucket is the FAST FALLBACK; the AI pass (below) overrides reason
    // + accountability + adds an improvement for each lead when available.
    const reason = categorise(text, l.status);

    const src = l.source || l.campaign || "Unknown";
    const agent = l.user?.name || "Unassigned";

    // Use qualification score to improve accountability classification.
    // A Cold-qualified lead (low score) is likely a lead-quality issue, not
    // an agent follow-up gap — override the default accountability accordingly.
    let accountability = defaultAccountability(reason);
    if (l.leadCategory === "Cold" && l.qualificationPercentage != null) {
      // Clearly unqualified leads shouldn't be classified as agent failures
      if (accountability === "Agent follow-up gap") {
        accountability = "Lead not interested";
      }
    }

    leadDetails.push({
      leadId:  l._id,
      name:    l.name || "Unknown",
      status:  l.status || "—",
      temperature: l.leadCategory || l.temperature || null,
      reason,                               // may be overridden by AI
      accountability,                       // may be overridden by AI
      improvement: "",                      // filled by AI
      source:  src,
      agent,
      detail:  text ? text.slice(0, 240) : "",        // short text for the table
      _aiText: text ? text.slice(0, 700) : "",        // fuller context for the AI (not sent to client)
      updatedAt: l.updatedAt || l.closedAt || l.createdAt || null,
      // Qualification fields — used in the AI prompt and returned in lead details
      leadScore:               l.leadScore               ?? null,
      maxScore:                l.maxScore                ?? null,
      qualificationPercentage: l.qualificationPercentage ?? null,
      leadCategory:            l.leadCategory            ?? null,
    });
  }

  // ── Per-lead AI reasoning ───────────────────────────────────────────────────
  // Analyse each lead's remark + status + temperature + call summary to produce
  // a SPECIFIC reason (what's blocking conversion / the mistake), an
  // accountability bucket, and a concrete improvement action. Batched into
  // chunks to stay within token limits.
  if (withAI && leadDetails.length > 0) {
    try {
      await runPerLeadAnalysis(leadDetails);
    } catch (e) {
      // Non-fatal: keep keyword reasons, leave improvement blank.
      console.error("[nonConversion] per-lead AI failed:", e.message);
    }
  }

  // Recompute aggregates AFTER AI so the breakdown reflects the refined reasons.
  for (const d of leadDetails) {
    byReason[d.reason] = (byReason[d.reason] || 0) + 1;
    byAccountability[d.accountability] = (byAccountability[d.accountability] || 0) + 1;
    bySource[d.source] = bySource[d.source] || {};
    bySource[d.source][d.reason] = (bySource[d.source][d.reason] || 0) + 1;
    byAgent[d.agent] = (byAgent[d.agent] || 0) + 1;
    if (!samples[d.reason]) samples[d.reason] = [];
    if (samples[d.reason].length < 5 && d.detail) samples[d.reason].push(d.detail.slice(0, 200));
  }

  // Most-recently-touched first.
  leadDetails.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const total = lost.length;
  const reasonBreakdown = Object.entries(byReason)
    .map(([reason, count]) => ({ reason, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  const accountabilityBreakdown = Object.entries(byAccountability)
    .map(([label, count]) => ({ label, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  const result = {
    range: { from: fromDate, to: toDate },
    totalLost: total,
    reasonBreakdown,
    accountabilityBreakdown,
    bySource,
    byAgent: Object.entries(byAgent).map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count),
    leadDetails: leadDetails.map(({ _aiText, ...rest }) => rest),
    aiAnalysis: null,
  };

  // ── AI analysis ────────────────────────────────────────────────────────────
  if (withAI && total > 0) {
    try {
      result.aiAnalysis = await runAIAnalysis(reasonBreakdown, samples, result.bySource, total);
    } catch (e) {
      result.aiAnalysisError = e.code === "GROK_PAYLOAD_TOO_LARGE"
        ? "Too much data to analyse at once — narrow the date range."
        : (e?.response?.status === 429
            ? "AI is busy right now (rate limited). Please try again in a moment."
            : (e.message || "AI analysis unavailable right now."));
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

  const raw = await callGrokWithRetry(systemPrompt, lines.join("\n"), 900);

  // Tolerate code fences / stray text around the JSON.
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // If the model didn't return clean JSON, hand back the text as the summary.
    return { summary: cleaned, topReasons: [], suggestions: [], dataQualityNote: "" };
  }
}

// ── Per-lead AI: reason + accountability + improvement for each lead ─────────
// Batches leads to keep each request small. For each lead the model gets the
// name, status, temperature and the remark/call-summary text, and returns a
// concise reason (what's blocking conversion / the mistake), an accountability
// bucket (is this on the agent, or lead-side / external?), plus a concrete
// improvement action. Writes results back onto the leadDetails objects in place.
async function runPerLeadAnalysis(leadDetails) {
  const BATCH = 25;

  const systemPrompt =
    "You are a sales coach reviewing CRM leads that have NOT converted yet. " +
    "For EACH lead you get its name, status, temperature (Hot/Warm/Cold or null), " +
    "qualification score (score/maxScore, percentage — if available), " +
    "and the latest agent remark / call-summary text. Infer, from that text and " +
    "status, the most likely REASON the lead hasn't converted (what is blocking " +
    "it or the mistake being made — e.g. 'Demo scheduled but not yet completed', " +
    "'Awaiting callback — follow-up not done', 'Price concern not addressed', " +
    "'Needs WhatsApp/email automation info', 'No follow-up after first call'), " +
    "an ACCOUNTABILITY bucket — exactly one of: 'Agent follow-up gap' (the team " +
    "should have acted and didn't — e.g. a hot lead with no recent activity, a " +
    "promised callback that never happened, a scheduled demo never completed), " +
    "'Awaiting next step' (ball is genuinely in the lead's court, or a step is " +
    "pending that isn't yet overdue), 'Lead not interested' (lead explicitly " +
    "declined or went cold on their own), 'Price/budget' (cost was the blocker), " +
    "'Bad lead data' (wrong number, duplicate, invalid, unreachable), or " +
    "'Product/fit' (the offering didn't match their need) — and a short, " +
    "concrete IMPROVEMENT action the agent should take next. " +
    "IMPORTANT: If the qualification score is Cold (low %), it is more likely a " +
    "lead-quality issue than an agent failure — prefer 'Lead not interested' or " +
    "'Product/fit' over 'Agent follow-up gap' in those cases unless notes " +
    "clearly show the agent missed a follow-up on a genuinely interested lead. " +
    "Base it ONLY on the given text; if there's genuinely no info, use reason " +
    "'No remark logged', accountability 'No data', and improvement 'Log call " +
    "notes and set a follow-up'. " +
    "Respond with STRICT JSON only — an array, one object per lead, in the same " +
    "order, shape: [{\"reason\":\"...\",\"accountability\":\"...\",\"improvement\":\"...\"}]. " +
    "Keep reason and improvement under 90 characters each.";

  for (let i = 0; i < leadDetails.length; i += BATCH) {
    const chunk = leadDetails.slice(i, i + BATCH);
    const lines = chunk.map((d, idx) => {
      const scoreStr = d.qualificationPercentage != null
        ? ` score=${d.leadScore}/${d.maxScore}(${d.qualificationPercentage}%,${d.leadCategory || "?"})`
        : "";
      return `${idx + 1}. name="${d.name}" status="${d.status}" temp="${d.temperature || "n/a"}"${scoreStr} notes="${(d._aiText || d.detail || "").replace(/"/g, "'").slice(0, 600) || "none"}"`;
    });

    let raw;
    try {
      raw = await callGrokWithRetry(systemPrompt, lines.join("\n"), 1200);
    } catch (e) {
      // Leave this chunk on keyword reasons; continue with the next.
      continue;
    }

    const cleaned = (raw || "").replace(/```json|```/g, "").trim();
    let arr;
    try {
      arr = JSON.parse(cleaned);
    } catch {
      continue; // keep fallbacks for this chunk
    }
    if (!Array.isArray(arr)) continue;

    arr.forEach((item, idx) => {
      const d = chunk[idx];
      if (!d || !item) return;
      if (item.reason)      d.reason = String(item.reason).slice(0, 120);
      if (item.improvement) d.improvement = String(item.improvement).slice(0, 120);
      // Only accept a known accountability label; otherwise keep the
      // keyword-derived default rather than letting the model invent labels
      // the frontend doesn't know how to color.
      if (item.accountability && ACCOUNTABILITY_LABELS.includes(item.accountability)) {
        d.accountability = item.accountability;
      }
    });
  }
}

module.exports = { getNonConversionReport, REASON_RULES, categorise, pickReasonText, defaultAccountability };
