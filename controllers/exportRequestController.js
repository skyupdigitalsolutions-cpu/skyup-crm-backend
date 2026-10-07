// controllers/exportRequestController.js
// ─────────────────────────────────────────────────────────────────────────────
// Lead export with super-admin approval.
//
//   Admin:  request → (super admin approves) → export ONCE → request again
//   Super admin: exports any time; approves/rejects admin requests.
//
// An approval is single-use and expires at 23:59:59 IST on the day it was
// approved. The export is built on the SERVER and the approval is consumed
// atomically in the same step, so it can't be reused or raced.
//
//   GET  /api/lead/export-requests/mine          admin: current request state
//   POST /api/lead/export-requests               admin: ask for approval
//   GET  /api/lead/export-requests               super admin: list
//   POST /api/lead/export-requests/:id/approve   super admin
//   POST /api/lead/export-requests/:id/reject    super admin
//   POST /api/lead/admin/export                  admin (needs approval) / super admin
// All behind protectAdmin (admin + super_admin tokens → req.admin).
// ─────────────────────────────────────────────────────────────────────────────
const mongoose      = require("mongoose");
const Lead          = require("../models/Leads");
const Admin         = require("../models/Admin");
const ExportRequest = require("../models/ExportRequest");
const custSvc       = require("../services/customizationService");
const { getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");
const { logAuditEvent } = require("../utils/auditLogger");

const isSuper   = (req) => ["super_admin", "superadmin"].includes(req.admin?.role);
const companyOf = (req) => req.admin?.company?._id || req.admin?.company || null;
const oid       = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

// 23:59:59.999 in India (IST, UTC+5:30) on the current Indian date.
function endOfTodayIST(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now); // YYYY-MM-DD
  return new Date(`${ymd}T23:59:59.999+05:30`);
}

const emit = (room, event, payload) => { try { global._io?.to(room).emit(event, payload); } catch (_) { /* ignore */ } };

function publicRequest(r) {
  if (!r) return null;
  const expired = r.status === "approved" && r.expiresAt && new Date(r.expiresAt) <= new Date();
  return {
    _id: r._id, adminName: r.adminName, reason: r.reason,
    status: expired ? "expired" : r.status,
    decidedByName: r.decidedByName, decidedAt: r.decidedAt, rejectReason: r.rejectReason,
    expiresAt: r.expiresAt, usedAt: r.usedAt, rowCount: r.rowCount, createdAt: r.createdAt,
  };
}

// ── GET /export-requests/mine ───────────────────────────────────────────────
const getMyExportRequest = async (req, res) => {
  try {
    if (isSuper(req)) return res.json({ canExportDirectly: true, request: null });
    const latest = await ExportRequest.findOne({ company: companyOf(req), admin: req.admin._id })
      .sort({ createdAt: -1 }).lean();
    res.json({ canExportDirectly: false, request: publicRequest(latest) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /export-requests  { reason } ───────────────────────────────────────
const createExportRequest = async (req, res) => {
  try {
    if (isSuper(req)) return res.status(400).json({ message: "Super admins can export without approval." });
    const company = companyOf(req);
    const now = new Date();
    const open = await ExportRequest.findOne({
      company, admin: req.admin._id,
      $or: [{ status: "pending" }, { status: "approved", expiresAt: { $gt: now } }],
    }).lean();
    if (open) {
      return res.status(409).json({
        message: open.status === "pending" ? "You already have a request waiting for approval." : "You already have an approved export. Use it first.",
        request: publicRequest(open),
      });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 300);
    const created = await ExportRequest.create({ company, admin: req.admin._id, adminName: req.admin.name || "", reason });

    const supers = await Admin.find({ company, role: "super_admin" }).select("_id").lean();
    const payload = {
      requestId: String(created._id), adminName: created.adminName, reason, timestamp: created.createdAt,
    };
    supers.forEach((s) => emit(`superadmin:${s._id}`, "export_request", payload));

    logAuditEvent({
      action: "export_request", resourceType: "Lead", req,
      actorId: req.admin._id, actorModel: "Admin", actorEmail: req.admin.email, actorRole: "admin",
      company, resourceId: created._id, statusCode: 201, metadata: { reason },
    });
    res.status(201).json({ request: publicRequest(created.toObject()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /export-requests  (super admin) ─────────────────────────────────────
// Pending first, then the last 30 days of decisions.
const listExportRequests = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can view export requests." });
    const company = companyOf(req);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [pending, recent] = await Promise.all([
      ExportRequest.find({ company, status: "pending" }).sort({ createdAt: 1 }).lean(),
      ExportRequest.find({ company, status: { $ne: "pending" }, createdAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(100).lean(),
    ]);
    res.json({ pending: pending.map(publicRequest), recent: recent.map(publicRequest) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

async function decide(req, res, approve) {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can decide export requests." });
    if (!oid(req.params.id)) return res.status(400).json({ message: "Invalid request." });
    const company = companyOf(req);
    const set = {
      status: approve ? "approved" : "rejected",
      decidedBy: req.admin._id, decidedByName: req.admin.name || "", decidedAt: new Date(),
    };
    if (approve) set.expiresAt = endOfTodayIST();
    else set.rejectReason = String(req.body?.reason || "").trim().slice(0, 300);

    // Only a still-pending request can be decided (no double approvals).
    const r = await ExportRequest.findOneAndUpdate(
      { _id: req.params.id, company, status: "pending" }, { $set: set }, { new: true }
    ).lean();
    if (!r) return res.status(409).json({ message: "This request was already decided or no longer exists." });

    emit(`admin:${r.admin}`, "export_request_decided", {
      requestId: String(r._id), status: r.status, decidedByName: r.decidedByName,
      expiresAt: r.expiresAt, rejectReason: r.rejectReason, timestamp: r.decidedAt,
    });
    logAuditEvent({
      action: approve ? "export_approved" : "export_rejected", resourceType: "Lead", req,
      actorId: req.admin._id, actorModel: "Admin", actorEmail: req.admin.email, actorRole: "super_admin",
      company, resourceId: r._id, statusCode: 200, metadata: { forAdmin: r.adminName },
    });
    res.json({ request: publicRequest(r) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
const approveExportRequest = (req, res) => decide(req, res, true);
const rejectExportRequest  = (req, res) => decide(req, res, false);

// ── CSV helpers ──────────────────────────────────────────────────────────────
// Prefix cells that start with = + - @ so spreadsheets don't run them as
// formulas (CSV injection), then quote as needed.
function csvCell(v) {
  let s = String(v ?? "");
  // Phone numbers like "+919876543210" are allowed through untouched.
  const isPlainNumber = /^[+\-]?[\d\s()]+$/.test(s);
  if (!isPlainNumber && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  s = s.replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");

// ── POST /admin/export ──────────────────────────────────────────────────────
// Builds a CSV of every lead the caller can access. For an admin this
// consumes their approval first (atomic); if building the file fails, the
// approval is given back.
const exportLeads = async (req, res) => {
  const company = companyOf(req);
  let consumed = null;
  try {
    if (!isSuper(req)) {
      consumed = await ExportRequest.findOneAndUpdate(
        { company, admin: req.admin._id, status: "approved", expiresAt: { $gt: new Date() } },
        { $set: { status: "used", usedAt: new Date() } },
        { new: true, sort: { decidedAt: -1 } }
      );
      if (!consumed) {
        return res.status(403).json({ message: "Export needs super admin approval. Request it from the Leads page.", code: "EXPORT_APPROVAL_REQUIRED" });
      }
    }

    const scope = await getAdminLeadScope(req, company);
    const query = mergeLeadScope({ company, mergedInto: null }, scope);
    const cust  = await custSvc.getCustomization(company);
    const statusLabel = (key) => (custSvc.findStatus(cust, key) || {}).label || key || "";

    const headers = ["Name", "Phone", "Email", "Employee", "Source", "Campaign", "Date", "Status", "Quality",
      "Lead Score", "Max Score", "Qualification %", "Lead Category", "Calls", "Last Outcome", "Last Called", "Remark"];
    const lines = [headers.join(",")];
    let count = 0;

    const cursor = Lead.find(query)
      .select("name mobile email user source campaign date createdAt status leadScore maxScore qualificationPercentage leadCategory callHistory.outcome callHistory.calledAt remark")
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .lean()
      .cursor();
    for await (const l of cursor) {
      const calls = l.callHistory || [];
      const last  = calls.length ? calls[calls.length - 1] : null;
      const pct = l.qualificationPercentage != null ? l.qualificationPercentage
        : (l.maxScore && l.leadScore != null) ? Math.round((l.leadScore / l.maxScore) * 10000) / 100 : "";
      lines.push([
        l.name, l.mobile, l.email, l.user?.name || "Unassigned", l.source, l.campaign,
        fmtDate(l.date || l.createdAt), statusLabel(l.status),
        l.leadCategory || "", l.leadScore ?? "", l.maxScore ?? "", pct === "" ? "" : `${pct}%`,
        l.leadCategory || "", calls.length, last?.outcome || "", fmtDate(last?.calledAt), l.remark || "",
      ].map(csvCell).join(","));
      count++;
    }

    if (consumed) await ExportRequest.updateOne({ _id: consumed._id }, { $set: { rowCount: count } });
    logAuditEvent({
      action: "export", resourceType: "Lead", req,
      actorId: req.admin._id, actorModel: "Admin", actorEmail: req.admin.email,
      actorRole: isSuper(req) ? "super_admin" : "admin", company, statusCode: 200,
      metadata: { rows: count, approvalId: consumed ? String(consumed._id) : null },
    });

    const file = `leads_${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send("\uFEFF" + lines.join("\r\n")); // BOM so Excel reads UTF-8 names correctly
  } catch (err) {
    // Give the approval back if the file couldn't be built.
    if (consumed) {
      await ExportRequest.updateOne({ _id: consumed._id, status: "used" }, { $set: { status: "approved", usedAt: null } }).catch(() => {});
    }
    if (!res.headersSent) res.status(500).json({ message: "Export failed. Your approval is still valid — please try again." });
  }
};
module.exports = {
  getMyExportRequest, createExportRequest, listExportRequests,
  approveExportRequest, rejectExportRequest, exportLeads,
  endOfTodayIST, csvCell,
};
