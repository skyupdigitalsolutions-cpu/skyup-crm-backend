// services/ai/leadDiagnosis.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Prepares the AI context including:
//   - All CRM activity (calls, follow-ups, meetings)
//   - Full WhatsApp conversation thread (real + screenshot-imported)
//   - All template sends with names and dates
//   - Screenshot-imported messages tagged separately so AI understands they
//     came from a different WhatsApp number
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const VALID_REASON_CODES = new Set([
  "POOR_FOLLOW_UP","DELAYED_RESPONSE","MISSED_FOLLOW_UP",
  "FAILED_TO_ADDRESS_OBJECTION","POOR_COMMUNICATION",
  "FAILED_MEETING_FOLLOW_UP","FAILED_NEXT_STEP","INCORRECT_INFORMATION",
  "INSUFFICIENT_CONTACT","EXCESSIVE_GENERIC_TEMPLATES",
  "PRICE_OBJECTION","CUSTOMER_UNRESPONSIVE","NOT_INTERESTED","BUDGET_ISSUE",
  "COMPETITOR_SELECTED","REQUIREMENT_CHANGED","DECISION_DELAYED",
  "DECISION_MAKER_UNAVAILABLE","TIMING_ISSUE",
  "PRODUCT_LIMITATION","MISSING_FEATURE","TECHNICAL_ISSUE",
  "PRICING_POLICY","SERVICE_ISSUE","IMPLEMENTATION_ISSUE",
  "DUPLICATE_LEAD","INVALID_LEAD","INSUFFICIENT_DATA","OTHER",
]);

const VALID_RESPONSIBLE_TYPES = new Set([
  "SALESPERSON","CUSTOMER","COMPANY_PRODUCT","SHARED","UNKNOWN",
]);

const VALID_OUTCOMES = new Set(["ACTIVE","CONVERTED","NOT_CONVERTED"]);
const VALID_HEALTH   = new Set(["HEALTHY","AT_RISK","CRITICAL","LOST"]);
const VALID_IMPACTS  = new Set(["HIGH","MEDIUM","LOW"]);

// ── Build AI context ──────────────────────────────────────────────────────────
function buildAIContext(lead, timeline, metrics, rawData) {
  const employee = lead.user
    ? { id: String(lead.user._id), name: lead.user.name }
    : null;
  const admin = lead.assignedAdmin
    ? { id: String(lead.assignedAdmin._id), name: lead.assignedAdmin.name }
    : null;

  // ── 1. Call summaries (prefer AI transcript over raw remark) ──────────────
  const callSummaries = [];
  for (const c of timeline.filter(t => t.type === "CALL_TRANSCRIPT").slice(-5)) {
    callSummaries.push({
      date:       c.date,
      summary:    (c.summary || "").slice(0, 300),
      sentiment:  c.sentiment  || null,
      keyPoints:  (c.keyPoints || []).slice(0, 3),
      nextAction: c.nextAction || null,
      duration:   c.duration   || null,
    });
  }
  for (const c of timeline.filter(t => t.type === "CALL").slice(-8)) {
    callSummaries.push({
      date:     c.date,
      outcome:  c.outcome   || "",
      remark:   (c.summary || "").slice(0, 200),
      employee: c.employeeName || "",
    });
  }

  // ── 2. WhatsApp — split real vs screenshot-imported ───────────────────────
  const waAll         = timeline.filter(t => t.type === "WHATSAPP");
  const waReal        = waAll.filter(m => !m.isScreenshotImport);
  const waScreenshot  = waAll.filter(m => m.isScreenshotImport);

  const waSamples = [];
  // Last 6 inbound (most revealing of customer sentiment)
  for (const m of waReal.filter(m => m.direction === "INCOMING").slice(-6)) {
    waSamples.push({ dir: "IN",  date: m.date, text: (m.message || "").slice(0, 250), status: m.status });
  }
  // Last 4 outbound
  for (const m of waReal.filter(m => m.direction === "OUTGOING").slice(-4)) {
    waSamples.push({ dir: "OUT", date: m.date, text: (m.message || "").slice(0, 200) });
  }
  waSamples.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Screenshot-imported messages (from different WA number — label clearly for AI)
  const screenshotMessages = [];
  for (const m of waScreenshot.slice(-10)) {
    screenshotMessages.push({
      dir:  m.direction === "INCOMING" ? "CUSTOMER" : "AGENT",
      date: m.date,
      text: (m.message || "").slice(0, 250),
      note: "Imported from screenshot — different WhatsApp number/device",
    });
  }

  // ── 3. Template sends ─────────────────────────────────────────────────────
  const templateSends = (rawData.templateHistory || []).map(th => ({
    name:    th.templateName,
    sentAt:  th.sentAt,
    channel: th.channel || "whatsapp",
    status:  th.status  || "sent",
  }));

  // Check for excessive generic templates (same template sent many times)
  const templateFrequency = {};
  for (const t of templateSends) {
    templateFrequency[t.name] = (templateFrequency[t.name] || 0) + 1;
  }
  const repeatedTemplates = Object.entries(templateFrequency)
    .filter(([, count]) => count > 2)
    .map(([name, count]) => ({ name, count }));

  // ── 4. Follow-up details ──────────────────────────────────────────────────
  const followupDetails = (rawData.scheduledCalls || []).map(sc => ({
    scheduled: sc.scheduledAt,
    done:      sc.done,
    doneAt:    sc.doneAt || null,
    status:    sc.done
      ? (sc.doneAt && sc.scheduledAt
          ? ((new Date(sc.doneAt) - new Date(sc.scheduledAt)) / 86400000 > 1 ? "COMPLETED_LATE" : "COMPLETED_ON_TIME")
          : "COMPLETED")
      : (sc.scheduledAt && new Date(sc.scheduledAt) < new Date() ? "OVERDUE" : "SCHEDULED"),
    delayDays: sc.done && sc.doneAt && sc.scheduledAt
      ? +((new Date(sc.doneAt) - new Date(sc.scheduledAt)) / 86400000).toFixed(1)
      : null,
  }));

  // ── 5. Meeting summary ────────────────────────────────────────────────────
  const meetingSummary = (rawData.meetingRemarks || []).map(m => ({
    date:     m.metAt,
    type:     m.meetingType || "In-Person",
    outcome:  (m.outcome || "").slice(0, 200),
    remark:   (m.remark  || "").slice(0, 200),
    followUp: m.followUpDate || null,
  }));

  return {
    lead: {
      id:          String(lead._id),
      name:        lead.name,
      source:      lead.source   || "",
      campaign:    lead.campaign || "",
      industry:    lead.industry || "",
      service:     lead.service  || "",
      status:      lead.status,
      remark:      (lead.remark || "").slice(0, 300),
      temperature: lead.temperature || null,
      isClosed:    lead.isClosed    || false,
      createdAt:   lead.date,
      qualificationPercentage: lead.qualificationPercentage || null,
    },
    employee,
    admin,
    metrics,
    calls: callSummaries,

    whatsapp: {
      realConversation: {
        samples: waSamples,
        totalInbound:  metrics.whatsappReceived,
        totalOutbound: metrics.whatsappSent,
        responseRate:  metrics.whatsappResponseRate,
        daysSinceLastReply: metrics.daysSinceLastCustomerResponse,
      },
      // Screenshot-imported messages from a different WA number/device
      // AI should treat these as additional context, not the primary channel
      screenshotImported: {
        count:    screenshotMessages.length,
        messages: screenshotMessages,
        note: screenshotMessages.length > 0
          ? "These messages were manually imported from a WhatsApp screenshot (different number/device) and may not be in the CRM's primary conversation thread."
          : null,
      },
      templates: {
        totalSent:        templateSends.length,
        sends:            templateSends.slice(-15), // last 15 sends
        repeatedTemplates,  // templates sent more than 2x — sign of over-automation
        note: repeatedTemplates.length > 0
          ? `Warning: ${repeatedTemplates.map(t => `"${t.name}" sent ${t.count}x`).join(", ")} — may indicate excessive generic template use.`
          : null,
      },
    },

    followups:   followupDetails,
    meetings:    meetingSummary,
    stageChanges:(lead.activityTimeline || [])
      .filter(a => a.action === "status_changed")
      .slice(-5)
      .map(a => ({ date: a.timestamp, note: a.note })),
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an AI Lead Outcome Intelligence system for a Sales CRM.

Analyze the lead's complete activity history and determine:
- Why the lead is at its current stage
- Who is responsible (with evidence)
- What should happen next

DATA SOURCES EXPLAINED:
- whatsapp.realConversation: actual WhatsApp thread in the CRM
- whatsapp.screenshotImported: messages from a DIFFERENT WhatsApp number, manually uploaded as screenshots — treat as supplementary context showing customer engagement outside the primary channel
- whatsapp.templates: auto-templates sent by the nurture system — if repeatedTemplates is non-empty, the salesperson may be over-relying on automation instead of personal outreach
- followups: scheduled calls — COMPLETED_LATE means delay in following through on promises

RULES:
1. Return ONLY valid JSON matching the schema. No markdown, no prose.
2. Never blame the salesperson without concrete evidence (missed follow-ups with dates, delayed responses with measured delay in days, etc.)
3. If evidence is insufficient → responsibleType: "UNKNOWN"
4. responsibleUserId must be exactly as provided in context. Never invent IDs.
5. Consider screenshot-imported messages as evidence of customer interest/objections even if they came from a different number.
6. Repeated template sends (same template 3+ times) is evidence for EXCESSIVE_GENERIC_TEMPLATES.
7. conversionProbability 0-100. leadHealth: HEALTHY, AT_RISK, CRITICAL, or LOST.
8. Keep explanation under 200 words. Each evidence finding under 60 words. Max 2 secondary reasons.

APPROVED REASON CODES:
Salesperson: POOR_FOLLOW_UP, DELAYED_RESPONSE, MISSED_FOLLOW_UP, FAILED_TO_ADDRESS_OBJECTION, POOR_COMMUNICATION, FAILED_MEETING_FOLLOW_UP, FAILED_NEXT_STEP, INCORRECT_INFORMATION, INSUFFICIENT_CONTACT, EXCESSIVE_GENERIC_TEMPLATES
Customer: PRICE_OBJECTION, CUSTOMER_UNRESPONSIVE, NOT_INTERESTED, BUDGET_ISSUE, COMPETITOR_SELECTED, REQUIREMENT_CHANGED, DECISION_DELAYED, DECISION_MAKER_UNAVAILABLE, TIMING_ISSUE
Product: PRODUCT_LIMITATION, MISSING_FEATURE, TECHNICAL_ISSUE, PRICING_POLICY, SERVICE_ISSUE, IMPLEMENTATION_ISSUE
Other: DUPLICATE_LEAD, INVALID_LEAD, INSUFFICIENT_DATA, OTHER`;

function buildUserPrompt(context) {
  return `Analyze this lead and return JSON in the exact schema below.

LEAD DATA:
${JSON.stringify(context, null, 2)}

REQUIRED JSON SCHEMA:
{
  "outcome": "ACTIVE | CONVERTED | NOT_CONVERTED",
  "currentStage": "string",
  "leadHealth": "HEALTHY | AT_RISK | CRITICAL | LOST",
  "conversionProbability": 0-100,
  "primaryReason": {
    "code": "approved code",
    "label": "human readable label",
    "responsibleType": "SALESPERSON | CUSTOMER | COMPANY_PRODUCT | SHARED | UNKNOWN",
    "responsibleUserId": "exact _id from context or null",
    "responsibleName": "name or null",
    "responsibilityPercentage": 0-100,
    "confidence": 0-100
  },
  "secondaryReasons": [
    {
      "code": "...", "label": "...", "responsibleType": "...",
      "responsibleUserId": null, "responsibleName": null,
      "responsibilityPercentage": 0-100, "impact": "HIGH | MEDIUM | LOW"
    }
  ],
  "explanation": "max 200 words",
  "evidence": [
    {
      "type": "CALL | WHATSAPP | FOLLOW_UP | MEETING | TEMPLATE | STAGE_CHANGE",
      "referenceId": "string or null",
      "finding": "max 60 words",
      "impact": "HIGH | MEDIUM | LOW",
      "date": "ISO date or null"
    }
  ],
  "communicationAnalysis": {
    "customerSentiment": "string describing sentiment arc",
    "purchaseIntent": 0-100,
    "mainObjection": "string or null",
    "hasUnrepliedMessages": true or false,
    "hasExternalConversation": true or false
  },
  "recommendedActions": ["action1", "action2", "action3"]
}`;
}

// ── Validate AI response ──────────────────────────────────────────────────────
function validateAIResponse(raw, context) {
  if (!raw || typeof raw !== "object") throw new Error("AI returned non-object");

  if (!VALID_OUTCOMES.has(raw.outcome)) raw.outcome = "ACTIVE";
  if (!VALID_HEALTH.has(raw.leadHealth)) raw.leadHealth = "AT_RISK";
  raw.conversionProbability = Math.min(100, Math.max(0, Number(raw.conversionProbability) || 0));

  if (raw.primaryReason) {
    const pr = raw.primaryReason;
    if (!VALID_REASON_CODES.has(pr.code))         pr.code            = "INSUFFICIENT_DATA";
    if (!VALID_RESPONSIBLE_TYPES.has(pr.responsibleType)) pr.responsibleType = "UNKNOWN";
    pr.responsibilityPercentage = Math.min(100, Math.max(0, Number(pr.responsibilityPercentage) || 0));
    pr.confidence               = Math.min(100, Math.max(0, Number(pr.confidence) || 0));

    // Security: verify userId belongs to this lead's company
    if (pr.responsibleUserId) {
      const validIds = [context.employee?.id, context.admin?.id].filter(Boolean);
      if (!validIds.includes(String(pr.responsibleUserId))) {
        pr.responsibleUserId = null;
        pr.responsibleName   = null;
      }
    }
  } else {
    raw.primaryReason = {
      code: "INSUFFICIENT_DATA", label: "Insufficient Data",
      responsibleType: "UNKNOWN", responsibleUserId: null, responsibleName: null,
      responsibilityPercentage: 0, confidence: 0,
    };
  }

  raw.secondaryReasons = (Array.isArray(raw.secondaryReasons) ? raw.secondaryReasons : [])
    .slice(0, 2)
    .map(sr => {
      if (!VALID_REASON_CODES.has(sr.code))         sr.code = "OTHER";
      if (!VALID_RESPONSIBLE_TYPES.has(sr.responsibleType)) sr.responsibleType = "UNKNOWN";
      if (!VALID_IMPACTS.has(sr.impact))            sr.impact = "MEDIUM";
      sr.responsibleUserId = null;
      sr.responsibleName   = null;
      sr.responsibilityPercentage = Math.min(100, Math.max(0, Number(sr.responsibilityPercentage) || 0));
      return sr;
    });

  raw.evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .slice(0, 8)
    .map(e => ({
      type:        e.type        || "REMARK",
      referenceId: e.referenceId ? String(e.referenceId) : null,
      finding:     (e.finding    || "").slice(0, 300),
      impact:      VALID_IMPACTS.has(e.impact) ? e.impact : "MEDIUM",
      date:        e.date        || null,
    }));

  raw.explanation = (raw.explanation || "").slice(0, 800);
  raw.currentStage = (raw.currentStage || "").slice(0, 100);
  raw.recommendedActions = (Array.isArray(raw.recommendedActions) ? raw.recommendedActions : [])
    .slice(0, 5)
    .map(a => String(a).slice(0, 200));

  raw.communicationAnalysis = {
    customerSentiment:       raw.communicationAnalysis?.customerSentiment || null,
    purchaseIntent:          Math.min(100, Math.max(0, Number(raw.communicationAnalysis?.purchaseIntent) || 0)),
    mainObjection:           raw.communicationAnalysis?.mainObjection || null,
    hasUnrepliedMessages:    !!raw.communicationAnalysis?.hasUnrepliedMessages,
    hasExternalConversation: !!raw.communicationAnalysis?.hasExternalConversation,
  };

  return raw;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function diagnoseLead({ lead, timeline, metrics, rawData }) {
  const context    = buildAIContext(lead, timeline, metrics, rawData);
  const userPrompt = buildUserPrompt(context);
  const apiKey     = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  let aiRaw;
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model:           process.env.AI_ANALYSIS_MODEL || "gpt-4o-mini",
      max_tokens:      1500,
      temperature:     0.1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      response_format: { type: "json_object" },
    },
    {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 30000,
    }
  );

  const content = response.data?.choices?.[0]?.message?.content || "";
  try {
    aiRaw = JSON.parse(content);
  } catch {
    aiRaw = JSON.parse(content.replace(/```json?|```/g, "").trim());
  }

  const validated = validateAIResponse(aiRaw, context);
  return { ...validated, model: process.env.AI_ANALYSIS_MODEL || "gpt-4o-mini" };
}

module.exports = { diagnoseLead, buildAIContext };
