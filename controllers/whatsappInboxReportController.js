// controllers/whatsappInboxReportController.js
//
// Daily WhatsApp inbox report — every message (received + sent) in a date
// range, built from the WhatsAppMessage collection that the webhook already
// fills. WhatsApp / MSG91 have no "export chat history" API, so the CRM's own
// copy is the only source for this.
//
//   GET /api/whatsapp/reports/inbox?from=YYYY-MM-DD&to=YYYY-MM-DD
//       → JSON: summary, per-agent breakdown, per-conversation list
//   GET /api/whatsapp/reports/inbox?from=...&to=...&format=csv
//       → CSV download, one row per message, grouped by conversation
//
// Scoping matches getConversations: admin / super_admin see the whole company,
// everyone else sees only conversations assigned to them.
// Day boundaries use the company's Daily Report timezone (default Asia/Kolkata).

const mongoose = require("mongoose");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const DailyReportConfig    = require("../models/DailyReportConfig");
const User                 = require("../models/Users");
const Admin                = require("../models/Admin");
const { getCompanyDayBounds, getTodayInTimezone } = require("../services/dailyReportService");

const MAX_RANGE_DAYS = 31;
const MAX_ROWS       = 100000;
const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;

// Same caller resolution as whatsappChatController.callerCtx (not exported there).
function callerCtx(req) {
  const u = req.user || {};
  const adminCompany = req.admin && (req.admin.company?._id || req.admin.company);
  return {
    companyId: u.companyId || u.company?._id || u.company || req.callerCompany || adminCompany || null,
    userId:    u.userId || u.id || u._id || (req.admin && req.admin._id) || null,
    role:      u.role || (req.admin && req.admin.role) || "user",
  };
}

const isCompanyWide = role => role === "admin" || role === "super_admin" || role === "superadmin";

async function companyTimezone(companyId) {
  try {
    const cfg = await DailyReportConfig.findOne({ company: companyId }).select("timezone").lean();
    return cfg?.timezone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

function fmtInTz(date, tz) {
  if (!date) return { day: "", time: "" };
  const d = new Date(date);
  return {
    day:  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d),
  };
}

// What the customer actually saw. Edits only change the CRM copy, so prefer originalBody.
function messageText(m) {
  const text = m.originalBody || m.body || "";
  if (text) return text;
  if (m.mediaCaption) return m.mediaCaption;
  if (m.isTemplate && m.templateName) return `[Template: ${m.templateName}]`;
  if (m.messageType && m.messageType !== "text") return `[${m.messageType}]`;
  return "";
}

// Digits only, so safe from formula injection. The space stops Excel turning
// the number into 9.19876E+11.
function fmtPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+ ${d}`;
}

function csvCell(v, { raw = false } = {}) {
  let s = v == null ? "" : String(v);
  // Block spreadsheet formula injection from customer-typed text.
  if (!raw && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const getInboxReport = async (req, res, next) => {
  try {
    const { companyId, userId, role } = callerCtx(req);
    if (!companyId) return res.status(400).json({ error: "No company context" });

    const tz = await companyTimezone(companyId);
    const from = DATE_RE.test(req.query.from || "") ? req.query.from : getTodayInTimezone(tz);
    const to   = DATE_RE.test(req.query.to   || "") ? req.query.to   : from;
    if (to < from) return res.status(400).json({ error: "'to' must be on or after 'from'" });

    const { dayStart } = getCompanyDayBounds(tz, from);
    const { dayEnd }   = getCompanyDayBounds(tz, to);
    if ((dayEnd - dayStart) / 86400000 > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `Range too long — maximum ${MAX_RANGE_DAYS} days` });
    }

    // ── Conversations in scope ──────────────────────────────────────────────
    const convFilter = { company: new mongoose.Types.ObjectId(String(companyId)) };
    if (!isCompanyWide(role)) convFilter.assignedAgent = userId;

    const conversations = await WhatsAppConversation.find(convFilter)
      .select("waPhone contactName lead assignedAgent status createdAt")
      .populate("lead", "name status")
      .populate("assignedAgent", "name")
      .lean();
    const convById = new Map(conversations.map(c => [String(c._id), c]));

    // ── Messages in range ───────────────────────────────────────────────────
    const messages = conversations.length
      ? await WhatsAppMessage.find({
          conversation: { $in: conversations.map(c => c._id) },
          waTimestamp:  { $gte: dayStart, $lte: dayEnd },
        })
          .select("conversation direction body originalBody editedAt messageType mediaUrl mediaCaption sentBy status waTimestamp isTemplate templateName")
          .sort({ waTimestamp: 1, _id: 1 })
          .limit(MAX_ROWS + 1)
          .lean()
      : [];

    if (messages.length > MAX_ROWS) {
      return res.status(413).json({ error: `More than ${MAX_ROWS} messages in this range — choose a shorter range` });
    }

    // sentBy can point at a User (employee) or an Admin, so resolve both.
    const senderIds = [...new Set(messages.filter(m => m.sentBy).map(m => String(m.sentBy)))];
    const senderName = new Map();
    if (senderIds.length) {
      const [users, admins] = await Promise.all([
        User.find({ _id: { $in: senderIds } }).select("name").lean(),
        Admin.find({ _id: { $in: senderIds } }).select("name").lean(),
      ]);
      for (const p of [...admins, ...users]) senderName.set(String(p._id), p.name);
    }
    const nameOfSender = m =>
      m.direction === "inbound" ? "" : m.sentBy ? (senderName.get(String(m.sentBy)) || "Unknown user") : "System / Automation";

    // ── Group by conversation (first activity first) ────────────────────────
    const groups = new Map();
    for (const m of messages) {
      const key = String(m.conversation);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    const contactOf = c => c?.contactName || c?.lead?.name || "";

    // ── Summary ─────────────────────────────────────────────────────────────
    const summary = {
      from, to, timezone: tz,
      totalMessages: messages.length,
      received: 0, sent: 0, failed: 0, templates: 0,
      activeChats: groups.size,
      newChats: conversations.filter(c => c.createdAt >= dayStart && c.createdAt <= dayEnd).length,
      unanswered: 0,
    };
    const agents = new Map();
    const convRows = [];

    for (const [key, msgs] of groups) {
      const c = convById.get(key);
      let inbound = 0, outbound = 0;
      for (const m of msgs) {
        if (m.direction === "inbound") { inbound++; summary.received++; continue; }
        outbound++; summary.sent++;
        if (m.status === "failed") summary.failed++;
        if (m.isTemplate) summary.templates++;
        const name = nameOfSender(m);
        if (!agents.has(name)) agents.set(name, { agent: name, messagesSent: 0, chats: new Set() });
        const a = agents.get(name);
        a.messagesSent++;
        a.chats.add(key);
      }
      const last = msgs[msgs.length - 1];
      const unanswered = last.direction === "inbound";
      if (unanswered) summary.unanswered++;
      convRows.push({
        conversationId: key,
        contact: contactOf(c),
        phone: c?.waPhone || "",
        assignedAgent: c?.assignedAgent?.name || "",
        received: inbound,
        sent: outbound,
        lastMessage: messageText(last).slice(0, 140),
        lastMessageAt: last.waTimestamp,
        unanswered,
      });
    }
    convRows.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    const byAgent = [...agents.values()]
      .map(a => ({ agent: a.agent, messagesSent: a.messagesSent, chatsHandled: a.chats.size }))
      .sort((a, b) => b.messagesSent - a.messagesSent);

    // ── JSON ────────────────────────────────────────────────────────────────
    if (req.query.format !== "csv") {
      return res.json({ success: true, summary, byAgent, conversations: convRows });
    }

    // ── CSV ─────────────────────────────────────────────────────────────────
    const header = [
      "Date", "Time", "Contact Name", "Phone", "Assigned Agent", "Direction", "Sent By",
      "Type", "Message", "Template", "Media URL", "Status", "Edited in CRM", "Conversation ID",
    ];
    const PHONE_COL = header.indexOf("Phone");
    const lines = [header.map(v => csvCell(v)).join(",")];
    for (const [key, msgs] of groups) {
      const c = convById.get(key);
      const phoneCell = csvCell(fmtPhone(c?.waPhone), { raw: true });
      for (const m of msgs) {
        const { day, time } = fmtInTz(m.waTimestamp, tz);
        lines.push([
          day, time, contactOf(c), null,
          c?.assignedAgent?.name || "",
          m.direction === "inbound" ? "Received" : "Sent",
          nameOfSender(m), m.messageType || "text", messageText(m),
          m.templateName || "", m.mediaUrl || "",
          m.direction === "inbound" ? "" : (m.status || ""),
          m.editedAt ? "Yes" : "", key,
        ].map((v, i) => (i === PHONE_COL ? phoneCell : csvCell(v))).join(","));
      }
    }

    const filename = from === to ? `whatsapp-inbox-${from}.csv` : `whatsapp-inbox-${from}_to_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    // BOM so Excel opens Malayalam / Hindi / emoji text correctly.
    return res.send("\uFEFF" + lines.join("\r\n"));
  } catch (err) {
    console.error("getInboxReport error:", err.message);
    next(err);
  }
};

module.exports = { getInboxReport };
