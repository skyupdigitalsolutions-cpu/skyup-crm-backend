// services/telegramService.js
// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN-ONLY TELEGRAM NOTIFICATION SERVICE
//
// Business rule: Telegram notifications are sent EXCLUSIVELY for leads
// generated through campaign sources (Meta, Google Ads, Website, etc.).
// Manual entries, CSV imports, bulk uploads — never notified.
//
// Campaign sources (lead.source values that qualify):
//   "Meta"       → Facebook / Instagram Lead Ads (metaWebhookController)
//   "Google Ads" → Google Lead Form Extension (googleAdsHelper)
//   "Website"    → Landing page / website form (websiteWebhookController)
//
// Usage:
//   const { notifyCampaignLead } = require('../services/telegramService');
//   await notifyCampaignLead(lead, companyId);   // only fires for campaign sources
//
// Config stored on Company document:
//   telegramBotToken    — Telegram Bot API token (stored encrypted-at-rest in DB)
//   telegramChatId      — Group chat ID or personal chat ID for notifications
//   telegramEnabled     — master on/off switch
// ─────────────────────────────────────────────────────────────────────────────

const https    = require('https');
const Company  = require('../models/Company');
const User     = require('../models/Users');

// ── Campaign source whitelist ─────────────────────────────────────────────────
// These are the ONLY lead.source values that trigger Telegram notifications.
// All other sources (Web Form, Excel Import, CSV Import, etc.) are silently skipped.
const CAMPAIGN_SOURCES = new Set([
  'Meta',          // Facebook + Instagram Lead Ads (metaWebhookController)
  'Google Ads',    // Google Lead Form Extension (googleAdsHelper)
  'Website',       // Landing page / website tracking (websiteWebhookController)
]);

// ── Platform label for notification message ───────────────────────────────────
function platformLabel(source) {
  if (source === 'Meta')       return 'Meta (Facebook/Instagram)';
  if (source === 'Google Ads') return 'Google Ads';
  if (source === 'Website')    return 'Website/Landing Page';
  return source;
}

// ── Check if a lead qualifies for Telegram notification ──────────────────────
// Performance optimization: returns false early for non-campaign leads
// so we never even fetch the Telegram config from DB.
function isCampaignLead(lead) {
  if (!lead) return false;
  // Explicit sourceType field (future-proof)
  if (lead.sourceType === 'campaign') return true;
  // Source value check (current system)
  if (lead.source && CAMPAIGN_SOURCES.has(lead.source)) return true;
  return false;
}

// ── Low-level: send a message via Telegram Bot API ───────────────────────────
// Returns { ok: true } on success, throws on failure.
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    });

    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || JSON.stringify(parsed)}`));
          }
        } catch {
          reject(new Error(`Invalid Telegram response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Telegram request timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Build the notification message ───────────────────────────────────────────
async function buildMessage(lead, companyName) {
  // Resolve assigned employee name
  let assignedTo = 'Unassigned';
  if (lead.user) {
    try {
      const userId = lead.user?._id || lead.user;
      const user   = await User.findById(userId).select('name').lean();
      if (user?.name) assignedTo = user.name;
    } catch { /* non-fatal */ }
  }

  const now = new Date().toLocaleString('en-IN', {
    timeZone:   'Asia/Kolkata',
    day:        '2-digit',
    month:      'short',
    year:       'numeric',
    hour:       '2-digit',
    minute:     '2-digit',
    hour12:     true,
  });

  const phone    = lead.primaryPhone || lead.mobile || '—';
  const campaign = lead.campaign     || '—';
  const platform = platformLabel(lead.source);

  return (
    `🆕 <b>New Campaign Lead</b>\n\n` +
    `🏢 <b>Company:</b> ${escapeHtml(companyName)}\n` +
    `👤 <b>Lead Name:</b> ${escapeHtml(lead.name || 'Unknown')}\n` +
    `📞 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
    `📣 <b>Campaign:</b> ${escapeHtml(campaign)}\n` +
    `🌐 <b>Platform:</b> ${escapeHtml(platform)}\n` +
    `📋 <b>Source:</b> ${escapeHtml(lead.source || '—')}\n` +
    `👷 <b>Assigned To:</b> ${escapeHtml(assignedTo)}\n` +
    `🕐 <b>Time:</b> ${now}`
  );
}

// Minimal HTML escaping to avoid Telegram parse errors
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Main exported function: notify for campaign leads only ───────────────────
// This is the ONLY entry point other modules should use.
//
// Workflow:
//   1. isCampaignLead?     → No  → return immediately (no DB hit)
//   2. Fetch company config → no token or disabled → return
//   3. Build message
//   4. Send to Telegram
//
// Always resolves (never rejects) — errors are logged, never propagated
// to avoid disrupting lead creation flow.
async function notifyCampaignLead(lead, companyId) {
  // ── Step 1: Campaign filter — exit fast for non-campaign leads ────────────
  if (!isCampaignLead(lead)) return;

  try {
    // ── Step 2: Fetch Telegram config for this company ────────────────────
    if (!companyId) {
      console.warn('[Telegram] notifyCampaignLead: no companyId provided');
      return;
    }

    const company = await Company
      .findById(companyId)
      .select('name telegramBotToken telegramChatId telegramEnabled')
      .lean();

    if (!company) {
      console.warn(`[Telegram] Company ${companyId} not found`);
      return;
    }

    if (!company.telegramEnabled) return;
    if (!company.telegramBotToken || !company.telegramChatId) {
      console.debug(`[Telegram] Skipping — token or chatId not configured for "${company.name}"`);
      return;
    }

    // ── Step 3: Build message ─────────────────────────────────────────────
    const text = await buildMessage(lead, company.name);

    // ── Step 4: Send ──────────────────────────────────────────────────────
    await sendTelegramMessage(company.telegramBotToken, company.telegramChatId, text);
    console.log(`[Telegram] ✅ Campaign lead notification sent for "${lead.name}" → company "${company.name}"`);

  } catch (err) {
    // Never crash lead creation because of a notification failure
    console.error('[Telegram] notifyCampaignLead error:', err.message);
  }
}

// ── Test: send a test message (called from admin settings) ───────────────────
// Resolves with { ok: true } or rejects with a user-friendly error.
async function sendTestNotification(botToken, chatId, companyName) {
  const text =
    `✅ <b>Telegram Connected!</b>\n\n` +
    `Your Telegram notifications are now active for <b>${escapeHtml(companyName)}</b>.\n\n` +
    `Campaign leads (Meta, Google Ads, Website) will be sent to this chat.`;

  await sendTelegramMessage(botToken, chatId, text);
  return { ok: true };
}

module.exports = {
  notifyCampaignLead,
  sendTestNotification,
  isCampaignLead,
  CAMPAIGN_SOURCES,
};
