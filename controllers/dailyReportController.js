// controllers/dailyReportController.js
// ─────────────────────────────────────────────────────────────────────────────
// REST API for Daily Telegram Report admin settings.
// All endpoints require protectAdmin (company admin or super_admin).
// Company isolation: every query includes the caller's companyId.
// Telegram bot tokens are NEVER returned in API responses — masked only.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const Company            = require('../models/Company');
const DailyReportConfig  = require('../models/DailyReportConfig');
const DailyReportHistory = require('../models/DailyReportHistory');
const {
  generateAndSend,
  buildReport,
  formatTelegramMessages,
  sendTelegramMessage,
} = require('../services/dailyReportService');

// ── Resolve company ID from admin token ──────────────────────────────────────
function getCompanyId(req) {
  return (
    req.companyId ||
    req.admin?.company?._id ||
    req.admin?.company ||
    null
  );
}

// ── GET /daily-report/settings ────────────────────────────────────────────────
// Returns config with bot token MASKED. Never exposes the real token.
const getSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const config = await DailyReportConfig.findOne({ company: companyId }).lean();

    if (!config) {
      // Return defaults — no config yet
      return res.json({
        enabled:         false,
        telegramBotToken:'',
        telegramChatId:  '',
        reportTime:      '19:00',
        timezone:        'Asia/Kolkata',
        sendEmptyReport: false,
        configured:      false,
      });
    }

    res.json({
      enabled:          config.enabled,
      // Never return real token — mask it
      telegramBotToken: config.telegramBotToken ? '••••••••••••••••' : '',
      telegramChatId:   config.telegramChatId || '',
      reportTime:       config.reportTime || '19:00',
      timezone:         config.timezone   || 'Asia/Kolkata',
      sendEmptyReport:  config.sendEmptyReport || false,
      configured:       !!(config.telegramBotToken && config.telegramChatId),
    });
  } catch (err) {
    console.error('[DailyReport] getSettings error:', err.message);
    res.status(500).json({ message: 'Failed to load settings' });
  }
};

// ── PUT /daily-report/settings ────────────────────────────────────────────────
// Saves config. If bot token field is "••••••••••••••••" (masked placeholder),
// leave the existing token unchanged — only update it when a real value is sent.
const saveSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const {
      enabled, telegramBotToken, telegramChatId,
      reportTime, timezone, sendEmptyReport,
    } = req.body;

    // Validate reportTime format "HH:MM"
    if (reportTime && !/^\d{2}:\d{2}$/.test(reportTime)) {
      return res.status(400).json({ message: 'reportTime must be HH:MM (e.g. "19:00")' });
    }

    // Validate timezone
    if (timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
      catch { return res.status(400).json({ message: `Invalid timezone: ${timezone}` }); }
    }

    // Build update — only update token if a real value (not masked placeholder) was sent
    const update = {};
    if (enabled         !== undefined) update.enabled         = !!enabled;
    if (telegramChatId  !== undefined) update.telegramChatId  = String(telegramChatId).trim();
    if (reportTime      !== undefined) update.reportTime      = reportTime;
    if (timezone        !== undefined) update.timezone        = timezone;
    if (sendEmptyReport !== undefined) update.sendEmptyReport = !!sendEmptyReport;

    const isMasked = typeof telegramBotToken === 'string' &&
      telegramBotToken.includes('•');
    if (telegramBotToken && !isMasked) {
      update.telegramBotToken = telegramBotToken.trim();
    }

    const config = await DailyReportConfig.findOneAndUpdate(
      { company: companyId },
      { $set: update },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    res.json({ message: 'Settings saved successfully', configured: !!(config.telegramBotToken && config.telegramChatId) });
  } catch (err) {
    console.error('[DailyReport] saveSettings error:', err.message);
    res.status(500).json({ message: 'Failed to save settings' });
  }
};

// ── POST /daily-report/test ───────────────────────────────────────────────────
// Validates token + chatId, generates current report, sends it.
// Rate-limited by a simple in-memory cooldown (1 per company per 30s).
const _testCooldown = new Map(); // companyId → timestamp

const sendTest = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    // Cooldown: prevent repeated clicks
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
// Immediately generates and sends today's report.
// Cooldown: 1 per company per 5 minutes.
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
// Returns last 30 report execution records for this company.
const getHistory = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company context required' });

    const history = await DailyReportHistory.find({ company: companyId })
      .sort({ generatedAt: -1 })
      .limit(30)
      .select('-telegramMessageIds') // no need to expose these
      .lean();

    res.json({ history });
  } catch (err) {
    console.error('[DailyReport] getHistory error:', err.message);
    res.status(500).json({ message: 'Failed to load history' });
  }
};

module.exports = { getSettings, saveSettings, sendTest, sendNow, getHistory };
