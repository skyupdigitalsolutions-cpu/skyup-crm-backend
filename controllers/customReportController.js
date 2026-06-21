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
const { callGrok } = require("../utils/leadActionSummary");

// ── Helpers ───────────────────────────────────────────────────────────────────
const sanitizeFields = (fields) =>
  (Array.isArray(fields) ? fields : [])
    .map((f) => ({
      name:  String(f?.name ?? "").trim(),
      value: Number(f?.value) || 0,
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

// ── AI analysis: suggestions + improvement notes ──────────────────────────────
const analyzeCustomReport = async (req, res) => {
  try {
    const report = await CustomReport.findById(req.params.id).lean();
    if (!report) return res.status(404).json({ message: "Report not found" });

    // Build prior-period context (helps the AI comment on trend).
    const prior = await CustomReport.find({
      company:   report.company,
      periodEnd: { $lt: report.periodEnd },
    })
      .sort({ periodEnd: -1 })
      .limit(1)
      .lean();
    const previous = prior[0] || null;

    const cur = report.currency || "₹";
    const fieldLines = (report.fields || [])
      .map((f) => `- ${f.name}: ${cur}${f.value}${f.note ? ` (${f.note})` : ""}`)
      .join("\n");
    const prevLines = previous
      ? (previous.fields || []).map((f) => `- ${f.name}: ${cur}${f.value}`).join("\n")
      : "(no prior report)";

    const systemPrompt =
      "You are a financial analyst reviewing a company's custom financial report. " +
      "The fields are free-form (the user named them), so infer their financial meaning " +
      "from the names. Identify whether the company appears profitable or loss-making, " +
      "call out the biggest cost/risk areas, note any concerning trend vs the previous " +
      "period, and give specific, practical improvement suggestions. Be concise and concrete. " +
      "Respond ONLY with valid JSON, no markdown, in this exact shape: " +
      '{"summary": "2-4 sentence assessment", "suggestions": ["actionable suggestion", "..."]}. ' +
      "Provide 3 to 6 suggestions.";

    const userContent =
      `Report: ${report.title}\n` +
      `Period: ${new Date(report.periodStart).toISOString().slice(0, 10)} to ${new Date(report.periodEnd).toISOString().slice(0, 10)}\n` +
      `Total of all fields: ${cur}${report.analytics?.total ?? 0}\n\n` +
      `Current fields:\n${fieldLines}\n\n` +
      `Previous period fields:\n${prevLines}`;

    let aiRaw;
    try {
      aiRaw = await callGrok(systemPrompt, userContent, 700);
    } catch (e) {
      if (e.code === "GROK_NOT_CONFIGURED")
        return res.status(503).json({ message: "AI is not configured on the server (missing API key)." });
      throw e;
    }

    // Parse the model's JSON defensively (strip code fences if present).
    let parsed = { summary: "", suggestions: [] };
    try {
      const clean = String(aiRaw).replace(/```json|```/g, "").trim();
      const obj = JSON.parse(clean);
      parsed.summary     = String(obj.summary || "").trim();
      parsed.suggestions = Array.isArray(obj.suggestions)
        ? obj.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
        : [];
    } catch {
      // If the model didn't return clean JSON, fall back to the raw text as the
      // summary so the feature still returns something useful.
      parsed.summary = String(aiRaw || "").trim();
    }

    // Cache onto the report.
    await CustomReport.findByIdAndUpdate(report._id, {
      ai: { summary: parsed.summary, suggestions: parsed.suggestions, generatedAt: new Date() },
    });

    res.json({ summary: parsed.summary, suggestions: parsed.suggestions, generatedAt: new Date() });
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
  analyzeCustomReport,
};
