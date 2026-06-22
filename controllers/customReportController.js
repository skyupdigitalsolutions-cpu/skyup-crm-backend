// controllers/customReportController.js
// Super-admin custom financial reports (per company, free-form fields).
//
// Endpoints (all super-admin protected, mounted under /api/superadmin):
//   POST   /custom-reports                  create a report
//   GET    /custom-reports?company=:id       list a company's reports (newest first)
//   GET    /custom-reports/:id               get one report
//   PUT    /custom-reports/:id               update a report
//   DELETE /custom-reports/:id               delete a report
//   GET    /custom-reports/:id/trends        period-over-period trend vs prior reports
//   POST   /custom-reports/:id/analyze       generate AI suggestions + improvement notes
const CustomReport = require("../models/CustomReport");
const Company      = require("../models/Company");
const Lead         = require("../models/Leads");
const { callGroq } = require("../utils/leadActionSummary");

// ── Helpers ───────────────────────────────────────────────────────────────────
const FIELD_TYPES = ["revenue", "cost", "profit", "other"];
const sanitizeFields = (fields) =>
  (Array.isArray(fields) ? fields : [])
    .map((f) => ({
      name:  String(f?.name ?? "").trim(),
      value: Number(f?.value) || 0,
      type:  FIELD_TYPES.includes(f?.type) ? f.type : "other",
      note:  String(f?.note ?? "").trim(),
    }))
    .filter((f) => f.name.length > 0);

const superAdminId = (req) =>
  req.superAdmin?._id || req.user?._id || req.admin?._id || null;

// ── Create ──────────────────────────────────────────────────────────────────
const createCustomReport = async (req, res) => {
  try {
    const { company, title, periodStart, periodEnd, currency, fields } = req.body;

    if (!company)  return res.status(400).json({ message: "company is required" });
    if (!title || !String(title).trim())
      return res.status(400).json({ message: "title is required" });
    if (!periodStart || !periodEnd)
      return res.status(400).json({ message: "periodStart and periodEnd are required" });
    if (new Date(periodStart) > new Date(periodEnd))
      return res.status(400).json({ message: "periodStart must be on or before periodEnd" });

    const companyDoc = await Company.findById(company).select("_id");
    if (!companyDoc) return res.status(404).json({ message: "Company not found" });

    const cleanFields = sanitizeFields(fields);
    if (cleanFields.length === 0)
      return res.status(400).json({ message: "At least one field (name + value) is required" });

    const report = await CustomReport.create({
      company,
      title:       String(title).trim(),
      periodStart: new Date(periodStart),
      periodEnd:   new Date(periodEnd),
      currency:    currency ? String(currency).trim() : "₹",
      fields:      cleanFields,
      createdBy:   superAdminId(req),
    });

    res.status(201).json(report);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── List (per company) ────────────────────────────────────────────────────────
const listCustomReports = async (req, res) => {
  try {
    const { company } = req.query;
    const q = {};
    if (company) q.company = company;
    const reports = await CustomReport.find(q)
      .sort({ periodEnd: -1, createdAt: -1 })
      .lean();
    res.json(reports);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Get one ─────────────────────────────────────────────────────────────────
const getCustomReport = async (req, res) => {
  try {
    const report = await CustomReport.findById(req.params.id).lean();
    if (!report) return res.status(404).json({ message: "Report not found" });
    res.json(report);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Update ──────────────────────────────────────────────────────────────────
const updateCustomReport = async (req, res) => {
  try {
    const report = await CustomReport.findById(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    const { title, periodStart, periodEnd, currency, fields } = req.body;
    if (title !== undefined)       report.title       = String(title).trim();
    if (periodStart !== undefined) report.periodStart = new Date(periodStart);
    if (periodEnd !== undefined)   report.periodEnd   = new Date(periodEnd);
    if (currency !== undefined)    report.currency    = String(currency).trim() || "₹";
    if (fields !== undefined) {
      const cleanFields = sanitizeFields(fields);
      if (cleanFields.length === 0)
        return res.status(400).json({ message: "At least one field (name + value) is required" });
      report.fields = cleanFields;
      // Edited figures invalidate any previously generated AI output.
      report.ai = { summary: "", suggestions: [], generatedAt: null };
    }
    if (report.periodStart > report.periodEnd)
      return res.status(400).json({ message: "periodStart must be on or before periodEnd" });

    await report.save(); // pre-validate recomputes analytics
    res.json(report);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Delete ──────────────────────────────────────────────────────────────────
const deleteCustomReport = async (req, res) => {
  try {
    const deleted = await CustomReport.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Report not found" });
    res.json({ message: "Report deleted" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Trends: this report vs the company's prior reports ────────────────────────
// Compares each field's value in THIS report against the company's immediately
// preceding report (by periodEnd), and also returns the total over time so the
// frontend can chart it.
const getCustomReportTrends = async (req, res) => {
  try {
    const current = await CustomReport.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ message: "Report not found" });

    // All reports for this company, oldest → newest, for the time series.
    const series = await CustomReport.find({ company: current.company })
      .sort({ periodEnd: 1, createdAt: 1 })
      .select("title periodStart periodEnd analytics.total currency")
      .lean();

    // The report immediately before the current one (by periodEnd).
    const prior = await CustomReport.find({
      company:   current.company,
      periodEnd: { $lt: current.periodEnd },
    })
      .sort({ periodEnd: -1 })
      .limit(1)
      .lean();
    const previous = prior[0] || null;

    // Per-field period-over-period change vs the previous report.
    const prevMap = {};
    if (previous) (previous.fields || []).forEach((f) => { prevMap[f.name.toLowerCase()] = Number(f.value) || 0; });

    const fieldChanges = (current.fields || []).map((f) => {
      const cur = Number(f.value) || 0;
      const has = previous && Object.prototype.hasOwnProperty.call(prevMap, f.name.toLowerCase());
      const prev = has ? prevMap[f.name.toLowerCase()] : null;
      let changePct = null;
      if (has && prev !== 0) changePct = Math.round(((cur - prev) / Math.abs(prev)) * 10000) / 100;
      return { name: f.name, current: cur, previous: prev, changeAbs: has ? Math.round((cur - prev) * 100) / 100 : null, changePct };
    });

    const totalNow  = current.analytics?.total ?? 0;
    const totalPrev = previous?.analytics?.total ?? null;
    const totalChangePct =
      totalPrev !== null && totalPrev !== 0
        ? Math.round(((totalNow - totalPrev) / Math.abs(totalPrev)) * 10000) / 100
        : null;

    res.json({
      current:    { id: current._id, title: current.title, total: totalNow },
      previous:   previous ? { id: previous._id, title: previous.title, total: totalPrev } : null,
      totalChangePct,
      fieldChanges,
      series: series.map((s) => ({
        id:          s._id,
        title:       s.title,
        periodStart: s.periodStart,
        periodEnd:   s.periodEnd,
        total:       s.analytics?.total ?? 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── GET /custom-reports/:id/lead-metrics ──────────────────────────────────────
// Auto-pulls REAL lead generation + conversion from the CRM for this report's
// company over its date range, and computes spend-vs-results ratios. "Total
// spent" = the report's total of all fields (analytics.total). Counts are not
// entered by the user — they come straight from the leads collection, so the
// ratios reflect actual performance.
const CONVERTED_RE = /^(converted|won|customer|closed won|closed-won|complete[d]?)$/i;

const getCustomReportLeadMetrics = async (req, res) => {
  try {
    const report = await CustomReport.findById(req.params.id).lean();
    if (!report) return res.status(404).json({ message: "Report not found" });

    const start = new Date(report.periodStart);
    const end   = new Date(report.periodEnd);
    end.setHours(23, 59, 59, 999); // include the whole end day

    // Leads GENERATED in the period (created within the range, for this company).
    const generated = await Lead.countDocuments({
      company:   report.company,
      createdAt: { $gte: start, $lte: end },
    });

    // Leads CONVERTED in the period. We match a converted-type status; since
    // there isn't a dedicated convertedAt field, we attribute by createdAt in
    // range (same basis as generated) so the ratio is consistent.
    const convertedStatuses = await Lead.find({
      company:   report.company,
      createdAt: { $gte: start, $lte: end },
    }).select("status").lean();
    const converted = convertedStatuses.filter(l => CONVERTED_RE.test(String(l.status || "").trim())).length;

    const spend = Number(report.analytics?.total) || 0;
    const cur   = report.currency || "₹";
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    // All computable ratios (null when the denominator is zero).
    const a = report.analytics || {};
    const metrics = {
      currency:            cur,
      totalSpent:          r2(spend),
      leadsGenerated:      generated,
      leadsConverted:      converted,
      // conversion rate %
      conversionRatePct:   generated > 0 ? r2((converted / generated) * 100) : null,
      // cost efficiency
      costPerLead:         generated > 0 ? r2(spend / generated) : null,
      costPerConversion:   converted > 0 ? r2(spend / converted) : null,
      // revenue-side (uses tagged revenue if present)
      revenue:             r2(a.totalRevenue || 0),
      revenuePerLead:      generated > 0 && a.totalRevenue ? r2(a.totalRevenue / generated) : null,
      revenuePerConversion:converted > 0 && a.totalRevenue ? r2(a.totalRevenue / converted) : null,
      // ROI on total spend
      roiPct:              spend > 0 && a.totalRevenue ? r2(((a.totalRevenue - spend) / spend) * 100) : null,
      netProfit:           a.totalRevenue ? r2(a.totalRevenue - spend) : null,
    };

    res.json(metrics);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
// callGroq rethrows the axios error, so we catch status 429 here, wait
// (honoring Retry-After when present), and try again with exponential backoff.
async function callGrokWithRetry(systemPrompt, userContent, maxTokens, maxRetries = 2) {
  let attempt = 0;
  for (;;) {
    try {
      return await callGroq(systemPrompt, userContent, maxTokens);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = Number(e?.response?.headers?.["retry-after"]);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1500 * Math.pow(2, attempt); // 1.5s, 3s
        await new Promise(r => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

const analyzeCustomReport = async (req, res) => {
  try {
    const report = await CustomReport.findById(req.params.id).lean();
    if (!report) return res.status(404).json({ message: "Report not found" });

    const prior = await CustomReport.find({
      company:   report.company,
      periodEnd: { $lt: report.periodEnd },
    }).sort({ periodEnd: -1 }).limit(1).lean();
    const previous = prior[0] || null;

    const cur = report.currency || "₹";
    const a   = report.analytics || {};
    const fieldLines = (report.fields || [])
      .map((f) => `- ${f.name} [${f.type || "other"}]: ${cur}${f.value}${f.note ? ` (${f.note})` : ""}`)
      .join("\n");
    const prevLines = previous
      ? (previous.fields || []).map((f) => `- ${f.name} [${f.type || "other"}]: ${cur}${f.value}`).join("\n")
      : "(no prior report)";

    // Computed metrics give the AI hard numbers instead of making it guess.
    const metricLines =
      `Computed: revenue=${cur}${a.totalRevenue ?? 0}, cost=${cur}${a.totalCost ?? 0}, ` +
      `net=${cur}${a.netProfit ?? 0}, margin=${a.marginPct ?? "n/a"}%, roi=${a.roiPct ?? "n/a"}%, ` +
      `verdict=${a.verdict ?? "insufficient"}`;

    const systemPrompt =
      "You are a financial analyst reviewing a company's financial report. Each field has a " +
      "type tag [revenue|cost|profit|other]. Use the provided computed metrics as ground truth. " +
      "Give a one-line verdict, a short assessment, the biggest cost/risk areas, any concerning " +
      "trend vs the previous period, and specific practical improvement suggestions. Be concise. " +
      "Respond ONLY with valid JSON, no markdown, exactly: " +
      '{"verdict":"one line","summary":"2-4 sentences","suggestions":["...","..."]}. ' +
      "Provide 3 to 6 suggestions.";

    const userContent =
      `Report: ${report.title}\n` +
      `Period: ${new Date(report.periodStart).toISOString().slice(0,10)} to ${new Date(report.periodEnd).toISOString().slice(0,10)}\n` +
      `${metricLines}\n\nCurrent fields:\n${fieldLines}\n\nPrevious period fields:\n${prevLines}`;

    let aiRaw;
    try {
      aiRaw = await callGrokWithRetry(systemPrompt, userContent, 800);
    } catch (e) {
      if (e.code === "GROK_NOT_CONFIGURED")
        return res.status(503).json({ message: "AI is not configured on the server (missing API key)." });
      if (e?.response?.status === 429)
        return res.status(429).json({ message: "AI is busy right now (rate limited). Please try again in a moment." });
      if (e.code === "GROK_PAYLOAD_TOO_LARGE")
        return res.status(413).json({ message: "Report is too large for AI analysis." });
      return res.status(502).json({ message: "AI analysis failed. Please try again." });
    }

    let parsed = { verdict: "", summary: "", suggestions: [] };
    try {
      const clean = String(aiRaw).replace(/```json|```/g, "").trim();
      const obj = JSON.parse(clean);
      parsed.verdict     = String(obj.verdict || "").trim();
      parsed.summary     = String(obj.summary || "").trim();
      parsed.suggestions = Array.isArray(obj.suggestions)
        ? obj.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
        : [];
    } catch {
      parsed.summary = String(aiRaw || "").trim();
    }

    const generatedAt = new Date();
    await CustomReport.findByIdAndUpdate(report._id, {
      ai: { verdict: parsed.verdict, summary: parsed.summary, suggestions: parsed.suggestions, generatedAt },
    });

    res.json({ ...parsed, generatedAt });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  createCustomReport,
  listCustomReports,
  getCustomReport,
  updateCustomReport,
  deleteCustomReport,
  getCustomReportTrends,
  getCustomReportLeadMetrics,
  analyzeCustomReport,
};
