// backend/controllers/reportController.js
// ─────────────────────────────────────────────────────────────────────────────
// All report endpoints now delegate to reportService.js so that admin panel,
// user dashboard, and mobile app always compute numbers identically.
//
// FIX: Removed duplicate filtering / aggregation that previously existed
// inside each controller, causing mismatched counts between dashboards.
// ─────────────────────────────────────────────────────────────────────────────

const {
  getDailyReport,
  getEmployeeReport,
  getCampaignReport,
  getDailyOutcomesReport,
} = require('../services/reportService');
const { getNonConversionReport } = require('../services/nonConversionService');
const { getLeadInsights } = require('../services/leadInsightsService');
const { getAdminLeadScope } = require('../utils/adminLeadScope');

// ── GET /api/reports/daily ────────────────────────────────────────────────────
// Works for both admin (req.admin) and user (req.user) tokens.
// Admins see all employees; users see only their own leads.
const dailyReport = async (req, res) => {
  try {
    // Resolve caller identity — protectAny sets either req.admin or req.user
    const isAdmin   = !!req.admin;
    const company   = req.callerCompany || req.admin?.company?._id || req.user?.company;
    const userId    = isAdmin ? (req.query.userId || null) : String(req.user._id);
    const date      = req.query.date      || null;
    const campaign  = req.query.campaign  || null;
    const status    = req.query.status    || null;

    if (!company) return res.status(400).json({ message: 'Company not resolved from token' });

    const leadScope = await getAdminLeadScope(req, company);
    const report = await getDailyReport({ company, date, userId, campaign, status,
      excludeClosed: !isAdmin,  // employees must not see closed leads
      leadScope,
    });

    // Mask phone numbers for non-superadmin admins
    if (isAdmin && req.admin?.role !== 'superadmin') {
      report.leads = report.leads.map(l => ({
        ...l,
        mobile: maskPhone(l.mobile),
        email:  maskEmail(l.email),
      }));
      report.followUps = report.followUps.map(f => ({
        ...f,
        mobile: maskPhone(f.mobile),
        email:  maskEmail(f.email),
      }));
      report.missingFollowUps = report.missingFollowUps.map(f => ({
        ...f,
        mobile: maskPhone(f.mobile),
      }));
    }

    res.json({ success: true, ...report });
  } catch (err) {
    console.error('[reportController.dailyReport]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/reports/lead-insights ────────────────────────────────────────────
// Daily Report → Lead Insights. Works for both admin and user tokens, same
// caller-resolution pattern as dailyReport above. Employees get the same
// per-admin/own-leads scoping as every other lead-list endpoint via
// getAdminLeadScope — nothing new is exposed that the caller couldn't already
// see through the existing Leads page.
const leadInsights = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.admin?.company?._id || req.user?.company;
    if (!company) return res.status(400).json({ message: 'Company not resolved from token' });

    const leadScope = await getAdminLeadScope(req, company);
    const report = await getLeadInsights({
      company,
      date:        req.query.date || null,
      agentId:     isAdmin ? (req.query.agentId || null) : String(req.user._id),
      source:      req.query.source || null,
      status:      req.query.status || '',
      temperature: req.query.temperature || null,
      search:      req.query.search || null,
      page:        req.query.page  ? Number(req.query.page)  : 1,
      limit:       req.query.limit ? Number(req.query.limit) : 25,
      leadScope,
    });

    // NOTE: deliberately NOT masking phone/email here, unlike dailyReport
    // above. Row clicks open LeadJourneyDrawer (reused as-is from
    // AdminLeadsPage), which does its OWN masking internally based on
    // isSuperAdmin and expects the RAW value — pre-masking here would get
    // masked twice, corrupting the display. Masking for the table itself
    // (rows the user isn't drilling into) happens client-side in
    // LeadInsights.jsx, the same way AdminLeadsPage already masks its own
    // table — consistent with the pattern LeadJourneyDrawer was built for.

    res.json({ success: true, ...report });
  } catch (err) {
    console.error('[reportController.leadInsights]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/reports/employee ─────────────────────────────────────────────────
// Admin-only: per-employee breakdown for a date range.
const employeeReport = async (req, res) => {
  try {
    const company  = req.callerCompany || req.admin?.company?._id;
    if (!company) return res.status(400).json({ message: 'Company not resolved' });

    const { fromDate, toDate, userId } = req.query;
    const leadScope = await getAdminLeadScope(req, company);
    const report = await getEmployeeReport({ company, fromDate, toDate, userId, leadScope });

    res.json({ success: true, ...report });
  } catch (err) {
    console.error('[reportController.employeeReport]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/reports/campaign ─────────────────────────────────────────────────
const campaignReport = async (req, res) => {
  try {
    const company = req.callerCompany || req.admin?.company?._id || req.user?.company;
    if (!company) return res.status(400).json({ message: 'Company not resolved' });

    const { fromDate, toDate } = req.query;
    const leadScope = await getAdminLeadScope(req, company);
    const report = await getCampaignReport({ company, fromDate, toDate, leadScope });

    res.json({ success: true, ...report });
  } catch (err) {
    console.error('[reportController.campaignReport]', err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── Utility ───────────────────────────────────────────────────────────────────
function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  if (s.length <= 2) return '••••••••';
  return '•'.repeat(s.length - 2) + s.slice(-2);
}

function maskEmail(email) {
  if (!email) return undefined;
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return '•'.repeat(8);
  const local  = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  let maskedLocal;
  if (local.length <= 2) {
    maskedLocal = '•'.repeat(local.length);
  } else {
    const mid = Math.max(1, local.length - 4);
    maskedLocal = local.slice(0, 2) + '•'.repeat(mid) + local.slice(-2);
  }
  const dotIdx = domain.lastIndexOf('.');
  const maskedDomain = dotIdx > 0
    ? '•'.repeat(dotIdx) + domain.slice(dotIdx)
    : '•'.repeat(domain.length);
  return `${maskedLocal}@${maskedDomain}`;
}

// ── GET /api/reports/non-conversion ───────────────────────────────────────────
// Admin-only. Analyses WHY leads didn't convert (derived from status + remarks
// + call summaries) and returns reason breakdown + AI improvement suggestions.
const nonConversionReport = async (req, res) => {
  try {
    const company = req.callerCompany || req.admin?.company?._id || req.user?.company;
    if (!company) return res.status(400).json({ message: 'Company not resolved' });

    const from   = req.query.from || null;
    const to     = req.query.to   || null;
    const withAI = req.query.ai !== 'false';   // ai=false → skip AI (fast, charts only)

    const leadScope = await getAdminLeadScope(req, company);
    const report = await getNonConversionReport({ company, from, to, withAI, leadScope });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/reports/daily-outcomes ───────────────────────────────────────────
// Answered / Not Answered / Busy / etc. breakdown for a given day — counts
// CALLS MADE that day (callHistory.calledAt), not leads created that day.
// Works for both admin (req.admin) and user (req.user) tokens, same as
// dailyReport above.
const dailyOutcomesReport = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const company = req.callerCompany || req.admin?.company?._id || req.user?.company;
    const userId  = isAdmin ? (req.query.userId || null) : String(req.user._id);
    const date    = req.query.date || null;

    if (!company) return res.status(400).json({ message: 'Company not resolved from token' });

    const leadScope = await getAdminLeadScope(req, company);
    const report = await getDailyOutcomesReport({
      company,
      date,
      userId,
      leadScope,
      // ── New filters (all optional) ──────────────────────────────────────────
      source:         req.query.source || null,
      status:         req.query.status || null,
      campaign:       req.query.campaign || null,
      minDurationSec: req.query.minDurationSec ? Number(req.query.minDurationSec) : 5,
      dataSource:     req.query.dataSource || 'auto', // 'auto' | 'device' | 'manual'
    });

    // Mask phone numbers for non-superadmin admins, same rule as dailyReport
    if (isAdmin && req.admin?.role !== 'superadmin') {
      report.calls = report.calls.map(c => ({ ...c, mobile: maskPhone(c.mobile) }));
    }

    res.json({ success: true, ...report });
  } catch (err) {
    console.error('[reportController.dailyOutcomesReport]', err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { dailyReport, employeeReport, campaignReport, nonConversionReport, dailyOutcomesReport, leadInsights };
