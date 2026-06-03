// utils/telegramNotifier.js
// ─────────────────────────────────────────────────────────────────────────────
// Company-aware Telegram notifier.
//
// Every company stores its own bot token + admin chat ID in Company doc.
// Each user/admin can optionally store their personal Telegram chat ID.
//
// On every new lead:
//   1. Looks up the company to get telegramBotToken + telegramAdminChatId
//   2. Sends to the company admin chat (if configured)
//   3. Sends to the assigned employee's personal chat (if they have a telegramChatId)
//
// Falls back to global env vars (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) if no
// company-level config is found — preserving backward compatibility.
// ─────────────────────────────────────────────────────────────────────────────
const axios   = require("axios");
const Company = require("../models/Company");
const User    = require("../models/Users");
const Admin   = require("../models/Admin");

// ── Standard Meta fields already shown as dedicated lines ─────────────────────
const STANDARD_META_FIELDS = new Set([
  "full_name", "first_name", "last_name",
  "phone_number", "mobile",
  "email", "email_address",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Internal: send a single Telegram message
// ─────────────────────────────────────────────────────────────────────────────
const _sendMessage = async (botToken, chatId, text) => {
  await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    { chat_id: chatId, text, parse_mode: "HTML" }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Build the notification message body
// ─────────────────────────────────────────────────────────────────────────────
const _buildMessage = (lead, source, metaFields, assignedName, isEmployee) => {
  const time = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day:    "2-digit", month: "short", year: "numeric",
    hour:   "2-digit", minute: "2-digit",
  });

  const campaignLabel = lead.campaign || source || "N/A";
  const sourceLabel   = lead.source   || source || "N/A";

  const header = isEmployee
    ? `📋 <b>New Lead Assigned to You!</b>\n\n`
    : `🔔 <b>New Lead Alert!</b>\n\n`;

  let message =
    header +
    `👤 <b>Name:</b>     ${escapeHtml(lead.name)}\n` +
    `📱 <b>Mobile:</b>   ${escapeHtml(lead.mobile)}\n` +
    `📧 <b>Email:</b>    ${escapeHtml(lead.email || "N/A")}\n` +
    `📢 <b>Campaign:</b> ${escapeHtml(campaignLabel)}\n` +
    `🌐 <b>Source:</b>   ${escapeHtml(sourceLabel)}\n` +
    `💬 <b>Remark:</b>   ${escapeHtml(lead.remark || "N/A")}\n`;

  if (assignedName) {
    message += `👷 <b>Assigned To:</b> ${escapeHtml(assignedName)}\n`;
  }

  // Meta form Q&A block
  if (metaFields && typeof metaFields === "object") {
    const customEntries = Object.entries(metaFields).filter(
      ([key]) => !STANDARD_META_FIELDS.has(key.toLowerCase())
    );
    if (customEntries.length > 0) {
      message += `\n📋 <b>Form Responses:</b>\n`;
      for (const [question, answer] of customEntries) {
        message += `  • <b>${escapeHtml(formatQuestion(question))}:</b> ${escapeHtml(answer || "N/A")}\n`;
      }
    }
  }

  message += `\n🕐 <b>Time:</b>     ${time}`;
  return message;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export
//
// @param {Object} lead         - Lead document just saved in the CRM
// @param {string} source       - Human-readable source label
// @param {Object} [metaFields] - Raw parsed key-value object from Meta's field_data
// ─────────────────────────────────────────────────────────────────────────────
const notifyTelegram = async (lead, source = "", metaFields = null) => {
  try {
    // ── 1. Resolve bot token + admin chat ID (company-first, env fallback) ────
    let botToken      = null;
    let adminChatId   = null;
    let companyName   = "";

    const companyId = lead.company;

    if (companyId) {
      const company = await Company.findById(companyId)
        .select("telegramBotToken telegramAdminChatId name")
        .lean();

      if (company) {
        companyName = company.name || "";
        if (company.telegramBotToken && company.telegramAdminChatId) {
          botToken    = company.telegramBotToken;
          adminChatId = company.telegramAdminChatId;
        }
      }
    }

    // Fallback to global env vars (backward compat)
    if (!botToken || !adminChatId) {
      botToken    = process.env.TELEGRAM_BOT_TOKEN  || botToken;
      adminChatId = process.env.TELEGRAM_CHAT_ID    || adminChatId;
    }

    if (!botToken) {
      console.warn("⚠️  No Telegram bot token found for company — skipping notify");
      return;
    }

    // ── 2. Resolve assigned employee name + their Telegram chat ID ────────────
    let assignedName      = null;
    let employeeChatId    = null;

    if (lead.user) {
      // Try User model first
      const user = await User.findById(lead.user)
        .select("name telegramChatId")
        .lean();

      if (user) {
        assignedName   = user.name;
        employeeChatId = user.telegramChatId || null;
      } else {
        // Try Admin model (in case a lead was assigned to an admin)
        const admin = await Admin.findById(lead.user)
          .select("name telegramChatId")
          .lean();
        if (admin) {
          assignedName   = admin.name;
          employeeChatId = admin.telegramChatId || null;
        }
      }
    }

    const errors = [];

    // ── 3. Send to company admin chat ─────────────────────────────────────────
    if (adminChatId) {
      const adminMsg = _buildMessage(lead, source, metaFields, assignedName, false);
      try {
        await _sendMessage(botToken, adminChatId, adminMsg);
        console.log(`✅ Telegram admin alert sent — lead: "${lead.name}" (${lead.mobile}) company: "${companyName}"`);
      } catch (err) {
        errors.push(`Admin chat: ${err.response?.data?.description || err.message}`);
      }
    } else {
      console.warn(`⚠️  No Telegram admin chat ID for company "${companyName}" — skipping admin notify`);
    }

    // ── 4. Send to assigned employee ──────────────────────────────────────────
    if (employeeChatId && botToken) {
      const empMsg = _buildMessage(lead, source, metaFields, assignedName, true);
      try {
        await _sendMessage(botToken, employeeChatId, empMsg);
        console.log(`✅ Telegram employee alert sent — lead: "${lead.name}" assigned to "${assignedName}"`);
      } catch (err) {
        errors.push(`Employee chat (${assignedName}): ${err.response?.data?.description || err.message}`);
      }
    } else if (lead.user && !employeeChatId) {
      console.info(`ℹ️  Assigned employee "${assignedName}" has no telegramChatId — skipping personal notify`);
    }

    if (errors.length) {
      console.error("❌ Telegram partial failure (non-fatal):", errors.join(" | "));
    }
  } catch (err) {
    // Non-fatal — Telegram failure must never break lead creation
    console.error("❌ Telegram notify failed (non-fatal):", err.response?.data || err.message);
  }
};

/** Converts snake_case / question-style Meta field key into a readable label */
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
