// controllers/dailyReportController.js
// ─────────────────────────────────────────────────────────────────────────────
// REST API for Daily Telegram Report admin settings.
//
// Company ID resolution (in priority order):
//   1. req.params.companyId  — developer route (/developer/companies/:companyId/daily-report/*)
//   2. req.admin.company     — admin token (protectAdmin)
//   3. x-company-id header   — developer panel fallback
//
// Telegram bot tokens are NEVER returned in API responses — masked only.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Company            = require('../models/Company');
const DailyReportConfig  = require('../models/DailyReportConfig');
const DailyReportHistory = require('../models/DailyReportHistory');
const {
  generateAndSend,
} = require('../services/dailyReportService');

// ── Resolve company ID from request ──────────────────────────────────────────
function getCompanyId(req) {
  return (
    req.params?.companyId                    ||  // developer route param
    req.companyId                            ||  // set by some middlewares
    req.admin?.company?._id                  ||  // admin token (populated)
    req.admin?.company                       ||  // admin token (raw id)
    req.headers?.['x-company-id']            ||  // explicit header (developer panel)
    null
  );
}

// ── GET /daily-report/settings ────────────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const config = await DailyReportConfig.findOne({ company: companyId }).lean();

    if (!config) {
      return res.json({
        enabled: false, telegramBotToken: '', telegramChatId: '',
        reportTime: '19:00', timezone: 'Asia/Kolkata', sendEmptyReport: false,
        configured: false,
      });
    }

    res.json({
      enabled:          config.enabled,
      telegramBotToken: config.telegramBotToken ? '••••••••••••••••' : '',
      telegramChatId:   config.telegramChatId   || '',
      reportTime:       config.reportTime        || '19:00',
      timezone:         config.timezone          || 'Asia/Kolkata',
      sendEmptyReport:  config.sendEmptyReport   || false,
      configured:       !!(config.telegramBotToken && config.telegramChatId),
    });
  } catch (err) {
    console.error('[DailyReport] getSettings error:', err.message);
    res.status(500).json({ message: 'Failed to load settings' });
  }
};

// ── PUT /daily-report/settings ────────────────────────────────────────────────
// IMPORTANT: this must go through a Mongoose *document* (load + .save()),
// NOT findOneAndUpdate(). The model's pre('save') hook is what encrypts
// telegramBotToken at rest — findOneAndUpdate() bypasses document middleware
// entirely, so tokens saved that way were being written to Mongo in PLAIN
// TEXT. Loading the doc first and calling .save() restores encryption.
const saveSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const {
      enabled, telegramBotToken, telegramChatId,
      reportTime, timezone, sendEmptyReport,
    } = req.body;

    if (reportTime && !/^\d{2}:\d{2}$/.test(reportTime)) {
      return res.status(400).json({ message: 'reportTime must be HH:MM (e.g. "19:00")' });
    }
    if (timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
      catch { return res.status(400).json({ message: `Invalid timezone: ${timezone}` }); }
    }

    // ── Load existing doc, or build a new one (upsert semantics) ──────────────
    let config = await DailyReportConfig.findOne({ company: companyId });
    if (!config) {
      config = new DailyReportConfig({ company: companyId });
    }

    if (enabled         !== undefined) config.enabled         = !!enabled;
    if (telegramChatId  !== undefined) config.telegramChatId  = String(telegramChatId).trim();
    if (reportTime      !== undefined) config.reportTime      = reportTime;
    if (timezone        !== undefined) config.timezone        = timezone;
    if (sendEmptyReport !== undefined) config.sendEmptyReport = !!sendEmptyReport;

    const isMasked = typeof telegramBotToken === 'string' && telegramBotToken.includes('•');
    if (telegramBotToken && !isMasked) {
      // Setting this field marks it "modified" so the pre('save') hook
      // below will re-encrypt it. Plain findOneAndUpdate() never triggered
      // that hook at all.
      config.telegramBotToken = telegramBotToken.trim();
    }

    await config.save();

    res.json({
      message:    'Settings saved successfully',
      configured: !!(config.telegramBotToken && config.telegramChatId),
    });
  } catch (err) {
    console.error('[DailyReport] saveSettings error:', err.message);
    res.status(500).json({ message: 'Failed to save settings' });
  }
};

// ── POST /daily-report/test ───────────────────────────────────────────────────
const _testCooldown = new Map();

const sendTest = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const last = _testCooldown.get(String(companyId));
    if (last && Date.now() - last < 30000) {
      return res.status(429).json({ message: 'Please wait 30 seconds before sending another test' });
    }
    _testCooldown.set(String(companyId), Date.now());

    const config = await DailyReportConfig.findOne({ company: companyId });
    if (!config?.telegramBotToken || !config?.telegramChatId) {
      return res.status(400).json({ message: 'Configure Bot Token and Chat ID first' });
    }

    const company = await Company.findById(companyId).select('name').lean();
    const result  = await generateAndSend(config, company?.name || 'Company', null, 'test');

    if (result.error) {
      return res.status(502).json({ message: `Telegram error: ${result.error}` });
    }

    res.json({ message: 'Test report sent successfully', ...result });
  } catch (err) {
    console.error('[DailyReport] sendTest error:', err.message);
    res.status(500).json({ message: err.message || 'Failed to send test report' });
  }
};

// ── POST /daily-report/send-now ───────────────────────────────────────────────
const _sendNowCooldown = new Map();

const sendNow = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const last = _sendNowCooldown.get(String(companyId));
    if (last && Date.now() - last < 5 * 60 * 1000) {
      return res.status(429).json({ message: 'Please wait 5 minutes before sending again' });
    }
    _sendNowCooldown.set(String(companyId), Date.now());

    const config = await DailyReportConfig.findOne({ company: companyId });
    if (!config?.enabled) {
      return res.status(400).json({ message: 'Daily Report is not enabled' });
    }
    if (!config?.telegramBotToken || !config?.telegramChatId) {
      return res.status(400).json({ message: 'Configure Bot Token and Chat ID first' });
    }

    const company = await Company.findById(companyId).select('name').lean();
    const result  = await generateAndSend(config, company?.name || 'Company', null, 'manual');

    if (result.skipped) {
      return res.json({ message: 'Report already sent for today', skipped: true });
    }
    if (result.error) {
      return res.status(502).json({ message: `Telegram error: ${result.error}` });
    }

    res.json({ message: 'Report sent successfully', ...result });
  } catch (err) {
    console.error('[DailyReport] sendNow error:', err.message);
    res.status(500).json({ message: err.message || 'Failed to send report' });
  }
};

// ── GET /daily-report/history ─────────────────────────────────────────────────
const getHistory = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const history = await DailyReportHistory.find({ company: companyId })
      .sort({ generatedAt: -1 })
      .limit(30)
      .select('-telegramMessageIds')
      .lean();

    res.json({ history });
  } catch (err) {
    console.error('[DailyReport] getHistory error:', err.message);
    res.status(500).json({ message: 'Failed to load history' });
  }
};

module.exports = { getSettings, saveSettings, sendTest, sendNow, getHistory };
