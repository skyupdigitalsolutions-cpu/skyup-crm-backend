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

/**
 * notifyTelegram
 * @param {Object} lead   - Lead document (or plain object) just saved in the CRM
 * @param {string} source - Human-readable source label ("Meta", "Google Ads", "Manual", etc.)
 */
const notifyTelegram = async (lead, source = "") => {
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

    // Build the message (Telegram supports MarkdownV2 — we use plain HTML instead
    // so we don't have to escape every special character)
    const campaignLabel = lead.campaign || source || "N/A";
    const sourceLabel   = lead.source   || source || "N/A";

    const message =
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

/** Minimal HTML-safe escaping for Telegram HTML parse mode */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { notifyTelegram };
