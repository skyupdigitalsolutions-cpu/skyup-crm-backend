// utils/telegramNotifier.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends a Telegram message to TELEGRAM_CHAT_ID whenever a new lead is saved.
// This is called from the CRM layer (leadController, webhookControllers, etc.)
// — NOT directly from any campaign integration.
//
// Required .env variables:
//   TELEGRAM_BOT_TOKEN  — from @BotFather  e.g.  7123456789:AAH...
//   TELEGRAM_CHAT_ID    — your personal / group chat ID  e.g.  -1001234567890
// ─────────────────────────────────────────────────────────────────────────────
const axios = require("axios");

// ── Standard Meta fields already shown as dedicated lines ─────────────────────
// Excluded from the "Form Q&A" block to avoid duplication.
const STANDARD_META_FIELDS = new Set([
  "full_name", "first_name", "last_name",
  "phone_number", "mobile",
  "email", "email_address",
]);

/**
 * notifyTelegram
 * @param {Object} lead         - Lead document (or plain object) just saved in the CRM
 * @param {string} source       - Human-readable source label ("Meta", "Google Ads", "Manual", etc.)
 * @param {Object} [metaFields] - Raw parsed key-value object from Meta's field_data
 *                                (all questions + answers submitted on the lead form).
 *                                Only pass this for Meta leads.
 */
const notifyTelegram = async (lead, source = "", metaFields = null) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.warn("⚠️  Telegram env vars missing (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — skipping notify");
      return;
    }

    // Format timestamp in IST
    const time = new Date().toLocaleString("en-IN", {
      timeZone:  "Asia/Kolkata",
      day:       "2-digit",
      month:     "short",
      year:      "numeric",
      hour:      "2-digit",
      minute:    "2-digit",
    });

    const campaignLabel = lead.campaign || source || "N/A";
    const sourceLabel   = lead.source   || source || "N/A";

    // ── Core lead fields ──────────────────────────────────────────────────────
    let message =
      `🔔 <b>New Lead Alert!</b>\n\n` +
      `👤 <b>Name:</b>     ${escapeHtml(lead.name)}\n` +
      `📱 <b>Mobile:</b>   ${escapeHtml(lead.mobile)}\n` +
      `📧 <b>Email:</b>    ${escapeHtml(lead.email || "N/A")}\n` +
      `📢 <b>Campaign:</b> ${escapeHtml(campaignLabel)}\n` +
      `🌐 <b>Source:</b>   ${escapeHtml(sourceLabel)}\n` +
      `🕐 <b>Time:</b>     ${time}`;

    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id:    chatId,
        text:       message,
        parse_mode: "HTML",
      }
    );

    console.log(`✅ Telegram alert sent for lead: "${lead.name}" (${lead.mobile})`);
  } catch (err) {
    // Non-fatal — a Telegram failure must never break lead creation
    console.error(
      "❌ Telegram notify failed (non-fatal):",
      err.response?.data || err.message
    );
  }
};

/**
 * Converts a snake_case / question-style Meta field key into a readable label.
 * e.g. "what_is_your_monthly_marketing_budget?" → "What Is Your Monthly Marketing Budget"
 */
function formatQuestion(key) {
  return key
    .replace(/[_?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Minimal HTML-safe escaping for Telegram HTML parse mode */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { notifyTelegram };
