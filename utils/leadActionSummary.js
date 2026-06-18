// utils/leadActionSummary.js
// ─────────────────────────────────────────────────────────────────────────────
// LEAD ACTION SUMMARY — powered by Grok (xAI)
//
// Builds an actionable summary for a lead so the employee knows the next best
// step, based on the history of REMARKS the team logged. On Pro/Advance plans
// the available call TRANSCRIPTS and per-call AI summaries are folded in for a
// richer result.
//
// Provider: Grok (xAI). The xAI API is OpenAI-compatible.
//   GROK_API_URL  (default https://api.x.ai/v1/chat/completions)
//   GROK_API_KEY  (required — no OpenAI fallback by design)
//   GROK_MODEL    (default grok-2-latest)
//
// To run Grok behind your own tunnel (e.g. ngrok → a self-hosted gateway),
// set GROK_API_URL to that tunnel URL; the request/response shape stays
// OpenAI-compatible.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── AI summary provider config ────────────────────────────────────────────────
// This feature now uses Groq (OpenAI-compatible chat API) so it can reuse the
// existing GROQ_API_KEY already set on the server. Everything is overridable via
// env, so you can still point this at xAI Grok or any OpenAI-compatible gateway
// without a code change:
//   AI_SUMMARY_API_KEY / GROQ_API_KEY / GROK_API_KEY  — first one set wins
//   AI_SUMMARY_API_URL  (default: Groq chat completions)
//   AI_SUMMARY_MODEL    (default: llama-3.3-70b-versatile)
// Legacy GROK_* names are still honoured so nothing else breaks.
const AI_SUMMARY_API_KEY =
  process.env.AI_SUMMARY_API_KEY ||
  process.env.GROQ_API_KEY ||
  process.env.GROK_API_KEY ||
  '';

const GROK_API_URL =
  process.env.AI_SUMMARY_API_URL ||
  process.env.GROK_API_URL ||
  'https://api.groq.com/openai/v1/chat/completions';

const GROK_MODEL =
  process.env.AI_SUMMARY_MODEL ||
  process.env.GROK_MODEL ||
  'llama-3.3-70b-versatile';

// ── Low-level chat call (OpenAI-compatible: works for Groq or xAI Grok) ───────
async function callGrok(systemPrompt, userContent, maxTokens = 700) {
  if (!AI_SUMMARY_API_KEY) {
    const err = new Error('No AI summary key set. Add GROQ_API_KEY (or AI_SUMMARY_API_KEY) to your environment to enable AI summaries.');
    err.code = 'GROK_NOT_CONFIGURED';
    throw err;
  }

  const { data } = await axios.post(
    GROK_API_URL,
    {
      model:       GROK_MODEL,
      max_tokens:  maxTokens,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${AI_SUMMARY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    },
  );

  // OpenAI-compatible response shape
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ── Build the text block from a lead's remarks + (optional) transcripts ───────
// Returns { text, hasTranscripts, remarkCount }.
function buildContext(lead, { includeTranscripts } = {}) {
  const lines = [];
  let remarkCount = 0;
  let hasTranscripts = false;

  // 1. Call-history remarks (the core signal on every plan)
  const callHistory = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  const sortedCalls = [...callHistory].sort(
    (a, b) => new Date(a.calledAt || 0) - new Date(b.calledAt || 0),
  );
  for (const c of sortedCalls) {
    const date = c.calledAt ? new Date(c.calledAt).toLocaleDateString('en-IN') : '';
    const parts = [
      `[Remark ${date}]`,
      c.outcome ? `Outcome: ${c.outcome}` : '',
      c.remark  ? `Note: ${c.remark}`     : '',
    ].filter(Boolean);
    if (c.remark || c.outcome) { lines.push(parts.join(' | ')); remarkCount++; }
  }

  // 2. Meeting remarks (field visits / demos)
  const meetingRemarks = Array.isArray(lead.meetingRemarks) ? lead.meetingRemarks : [];
  for (const m of meetingRemarks) {
    const date = m.metAt ? new Date(m.metAt).toLocaleDateString('en-IN') : '';
    const parts = [
      `[Meeting ${date}]`,
      m.meetingType ? `Type: ${m.meetingType}` : '',
      m.outcome     ? `Outcome: ${m.outcome}`  : '',
      m.remark      ? `Note: ${m.remark}`      : '',
    ].filter(Boolean);
    if (m.remark || m.outcome) { lines.push(parts.join(' | ')); remarkCount++; }
  }

  // 3. Pro/Advance only — call transcripts + per-call AI summaries
  if (includeTranscripts && Array.isArray(lead._callRecordings)) {
    for (const rec of lead._callRecordings) {
      if (rec.transcript && rec.transcript.trim()) {
        hasTranscripts = true;
        const t = rec.transcript.trim().slice(0, 2000); // keep prompt bounded
        lines.push(`[Call Transcript]\n${t}`);
      }
      if (rec.summary && rec.summary.summary) {
        hasTranscripts = true;
        lines.push(`[Call AI Summary] ${rec.summary.summary}${rec.summary.nextAction ? ` (Next: ${rec.summary.nextAction})` : ''}`);
      }
    }
  }

  return { text: lines.join('\n\n'), hasTranscripts, remarkCount };
}

// ── Main: generate an action summary for a lead ───────────────────────────────
// @param lead — a lead doc (lean or hydrated). For Pro/Advance, attach
//   lead._callRecordings = [{ transcript, summary }] before calling.
// @param opts.includeTranscripts — true on Pro/Advance
// @returns { summary, nextAction, keyPoints[], sentiment, suggestedTemp, basedOn, model }
async function generateLeadActionSummary(lead, opts = {}) {
  const includeTranscripts = !!opts.includeTranscripts;
  const contactName = lead.name || 'the customer';

  const { text, hasTranscripts, remarkCount } = buildContext(lead, { includeTranscripts });

  if (!text || remarkCount === 0 && !hasTranscripts) {
    return {
      summary:       'No remarks or call history yet for this lead.',
      nextAction:    'Make first contact and log a remark.',
      keyPoints:     [],
      sentiment:     'Neutral',
      suggestedTemp: null,
      basedOn:       includeTranscripts ? 'remarks+calls' : 'remarks',
      model:         GROK_MODEL,
    };
  }

  const basedOn = (includeTranscripts && hasTranscripts) ? 'remarks+calls' : 'remarks';

  const systemPrompt =
    'You are a CRM sales assistant. You read the history of a single lead and help ' +
    'the salesperson decide the next best action. Always respond with valid JSON only — ' +
    'no markdown, no preamble.';

  const userContent =
    `Lead name: "${contactName}".\n` +
    `Below is the chronological history of interactions${basedOn === 'remarks+calls' ? ' (remarks + call transcripts/summaries)' : ' (remarks logged by the team)'}:\n\n` +
    `"""\n${text}\n"""\n\n` +
    `Based on everything above, respond ONLY with this JSON:\n` +
    `{\n` +
    `  "summary": "3-4 sentence summary of where this lead stands and what has happened",\n` +
    `  "keyPoints": ["short bullet 1", "short bullet 2", "short bullet 3"],\n` +
    `  "sentiment": "Positive" | "Neutral" | "Negative",\n` +
    `  "nextAction": "the single most useful next step the salesperson should take",\n` +
    `  "suggestedTemp": "Hot" | "Warm" | "Cold" | null\n` +
    `}`;

  const raw = await callGrok(systemPrompt, userContent, 800);
  const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Model returned prose — degrade gracefully rather than failing the request.
    return {
      summary:       clean.slice(0, 500) || 'Could not parse summary.',
      nextAction:    'Review the lead history manually.',
      keyPoints:     [],
      sentiment:     'Neutral',
      suggestedTemp: null,
      basedOn,
      model:         GROK_MODEL,
    };
  }

  return {
    summary:       parsed.summary    || '',
    nextAction:    parsed.nextAction || '',
    keyPoints:     Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
    sentiment:     ['Positive', 'Neutral', 'Negative'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral',
    suggestedTemp: ['Hot', 'Warm', 'Cold'].includes(parsed.suggestedTemp) ? parsed.suggestedTemp : null,
    basedOn,
    model:         GROK_MODEL,
  };
}

// ── Signature of the inputs — used to cache & detect staleness ────────────────
// Cheap fingerprint: counts + latest timestamps of remarks/meetings/recordings.
// If this string changes, the cached summary is regenerated.
function computeSummarySignature(lead, includeTranscripts) {
  const ch = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  const mr = Array.isArray(lead.meetingRemarks) ? lead.meetingRemarks : [];
  const recs = includeTranscripts && Array.isArray(lead._callRecordings) ? lead._callRecordings : [];

  const latest = (arr, key) =>
    arr.reduce((m, x) => Math.max(m, new Date(x[key] || 0).getTime() || 0), 0);

  const transcriptChars = recs.reduce((n, r) => n + (r.transcript ? r.transcript.length : 0), 0);

  return [
    includeTranscripts ? 'rc' : 'r',
    ch.length, latest(ch, 'calledAt'),
    mr.length, latest(mr, 'metAt'),
    recs.length, transcriptChars,
  ].join(':');
}

module.exports = {
  generateLeadActionSummary,
  computeSummarySignature,
  GROK_MODEL,
};
