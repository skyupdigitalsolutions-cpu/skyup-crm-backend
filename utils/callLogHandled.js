// utils/callLogHandled.js
// ─────────────────────────────────────────────────────────────────────────────
// Mobile "Calls by Day" shows a call as "Remark pending" until its call-log row
// carries a real remark. Agents usually update the LEAD (status / remark /
// not-interested / invalid) from Lead Detail instead of the call-log remark
// box, so those calls stayed "Pending" forever.
//
// This middleware runs AFTER a successful lead update by an employee and
// stamps that employee's still-unremarked calls to the lead (last 7 days) with
// the remark they typed (or "Status → <status>"), then clears the company's
// cached /call-logs responses so the screen updates immediately.
// ─────────────────────────────────────────────────────────────────────────────
const MobileCallLog = require("../models/MobileCallLog");

const AUTO_REMARK = /^(outgoing|incoming|missed|rejected) call from mobile app/i;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function summarise(req, kind) {
  const b = req.body || {};
  const remark = typeof b.remark === "string" ? b.remark.trim() : "";
  if (remark) return remark.slice(0, 500);
  if (kind === "not-interested") return "Marked Not Interested";
  if (kind === "invalid") return "Marked Invalid";
  if (kind === "close") return "Closed (wrong entry)";
  if (kind === "cold") return "Marked Cold";
  if (b.status) return `Status → ${String(b.status).slice(0, 60)}`;
  if (b.outcome) return `Outcome → ${String(b.outcome).slice(0, 60)}`;
  return "";
}

async function stamp(req, kind) {
  const userId = req.user && (req.user._id || req.user.userId);
  const leadId = req.params && req.params.id;
  if (!userId || !leadId) return;
  const text = summarise(req, kind);
  if (!text) return; // nothing meaningful changed (e.g. only industry edited)

  const since = new Date(Date.now() - WINDOW_MS);
  const res = await MobileCallLog.updateMany(
    {
      user: userId,
      matchedLead: leadId,
      timestamp: { $gte: since, $lte: new Date() },
      $or: [
        { remark: { $exists: false } },
        { remark: null },
        { remark: "" },
        { remark: AUTO_REMARK },
      ],
    },
    { $set: { remark: text, ...(req.body && req.body.outcome ? { outcome: req.body.outcome } : {}) } }
  );

  // Always clear the cached call lists after a remark/status save — even when
  // the call itself hasn't reached the server yet (it will pick the remark up
  // on arrival), so Calls by Day never shows a 30-second-old "pending" copy.
  if (true) {
    try {
      const { deleteByPattern } = require("../middlewares/redisCache");
      const company = req.user.company || req.callerCompany;
      if (company) await deleteByPattern(`cache:${String(company._id || company)}:*`);
    } catch { /* cache is best-effort */ }
  }
}

/** Route middleware: markCallHandled("status" | "not-interested" | "invalid" | "close" | "cold") */
function markCallHandled(kind = "status") {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      // Employees only — admins don't own mobile call logs.
      if (req.admin) return;
      stamp(req, kind).catch((e) => console.warn("[callLogHandled]", e.message));
    });
    next();
  };
}

module.exports = { markCallHandled, _stamp: stamp };
