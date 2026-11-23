// controllers/quotationController.js — quotations for the web app. Scoped per company, numbered sequentially
// (per company, per year), supports a built quotation or an uploaded PDF. Reuses the CRM's auth/company scoping.
"use strict";
const mongoose = require("mongoose");
const Quotation = require("../models/Quotation");
const Lead = require("../models/Leads");
const { nextQuotationNumber } = require("../services/quotationNumberService");
const fin = require("../services/financeService");

// Keep the lead's finance invoice in step with its quotation. Never blocks or
// fails the quotation request itself.
async function syncFinance(company, q) {
  try { await fin.applyQuotationToInvoice(company, q); }
  catch (e) { console.error("[quotation→finance]", e.message); }
}
const cloudinary = require("cloudinary").v2;
const { resolveCompanyConfig, companyFolder } = require("../services/cloudinaryService");

// Stream an uploaded quotation file to the company's Cloudinary (its own
// account if configured, else the platform one) under <root>/<company>/quotations.
// Credentials go per call so concurrent tenants never share the global config.
async function uploadQuotationFile(company, file) {
  const { config } = await resolveCompanyConfig(company);
  const folder = await companyFolder(company, "quotations");
  const name = String(file.originalname || "quotation");
  const isPdf = /\.pdf$/i.test(name);
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "quotation";
  const public_id = `${Date.now()}_${base}${isPdf ? ".pdf" : ""}`;   // raw files keep their extension
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { ...config, folder, public_id, resource_type: isPdf ? "raw" : "image", overwrite: false },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(file.buffer);
  });
}

// Multipart fields arrive as strings; arrays may come JSON-encoded.
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return v ? [String(v)] : [];
};

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const companyIdOf = (req) =>
  req.user?.companyId || req.user?.company?._id || req.user?.company ||
  req.callerCompany ||
  req.admin?.company?._id || req.admin?.company ||
  (req.developer && isId(req.params?.companyId) ? req.params.companyId : null) || null;
const actorOf = (req) => ({
  id: req.user?._id || req.user?.id || req.admin?._id || null,
  name: req.user?.name || req.admin?.name || "User",
});
const fail = (res, c, m) => res.status(c).json({ success: false, message: m });

// Employees (protectAny sets req.user, no req.admin) only see quotations on
// leads assigned to them, or ones they created. Admins see the whole company.
const isEmployee = (req) => !req.admin && !!req.user;
const uidOf = (req) => req.user?._id || req.user?.id || null;

// Lead must be in the caller's company — and, for employees, assigned to them.
async function canUseLead(req, company, leadId) {
  if (!isId(leadId)) return true;   // no lead link → nothing to check
  const filter = { _id: leadId, company };
  if (isEmployee(req)) filter.user = uidOf(req);
  return !!(await Lead.exists(filter));
}

async function canUseQuotation(req, company, q) {
  if (!isEmployee(req)) return true;
  const uid = String(uidOf(req));
  if (q.createdBy && String(q.createdBy) === uid) return true;
  if (q.handledByUser && String(q.handledByUser) === uid) return true;
  return q.lead ? canUseLead(req, company, q.lead) : false;
}

// Build the client snapshot + optional lead link from the request.
function clientFrom(b) {
  return {
    lead: isId(b.leadId) ? b.leadId : null,
    clientName: b.clientName || "", clientEmail: b.clientEmail || "", clientPhone: b.clientPhone || "",
    clientCompany: b.clientCompany || "", clientGSTIN: b.clientGSTIN || "", clientAddress: b.clientAddress || "",
  };
}

// ── Letterhead / print settings (per company) ────────────────────────────────
const QuotationSettings = require("../models/QuotationSettings");
const SETTINGS_PUBLIC = "letterheadUrl letterheadName marginTopMm marginBottomMm marginSideMm hideBuiltInHeader updatedAt updatedByName";
const isAdminCaller = (req) => !!req.admin;   // protectAny: admins / super admins set req.admin

const settingsDTO = (st) => ({
  letterheadUrl: st?.letterheadUrl || "", letterheadName: st?.letterheadName || "",
  marginTopMm: st?.marginTopMm ?? 40, marginBottomMm: st?.marginBottomMm ?? 25, marginSideMm: st?.marginSideMm ?? 15,
  hideBuiltInHeader: st?.hideBuiltInHeader ?? true,
  updatedAt: st?.updatedAt || null, updatedByName: st?.updatedByName || "",
});

// GET /api/quotations/settings — everyone (employees need it to print).
async function getSettings(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const st = await QuotationSettings.findOne({ company }).select(SETTINGS_PUBLIC).lean();
    res.json({ success: true, settings: settingsDTO(st), canEdit: isAdminCaller(req) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// PUT /api/quotations/settings — admins: margins / header toggle / remove letterhead.
async function updateSettings(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can change the quotation letterhead.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const b = req.body || {};
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
    const $set = { updatedByName: actorOf(req).name };
    if (b.marginTopMm !== undefined && Number.isFinite(Number(b.marginTopMm)))       $set.marginTopMm    = clamp(b.marginTopMm, 0, 150);
    if (b.marginBottomMm !== undefined && Number.isFinite(Number(b.marginBottomMm))) $set.marginBottomMm = clamp(b.marginBottomMm, 0, 150);
    if (b.marginSideMm !== undefined && Number.isFinite(Number(b.marginSideMm)))     $set.marginSideMm   = clamp(b.marginSideMm, 5, 60);
    if (b.hideBuiltInHeader !== undefined) $set.hideBuiltInHeader = !!b.hideBuiltInHeader;
    if (b.removeLetterhead) { $set.letterheadUrl = ""; $set.letterheadName = ""; }
    const st = await QuotationSettings.findOneAndUpdate({ company }, { $set, $setOnInsert: { company } }, { new: true, upsert: true }).lean();
    res.json({ success: true, settings: settingsDTO(st) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// POST /api/quotations/settings/letterhead — admins: upload the letterhead image.
async function uploadLetterhead(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can change the quotation letterhead.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    if (!req.file) return fail(res, 400, "Choose the letterhead image (PNG, JPG or WEBP).");
    const { config } = await resolveCompanyConfig(company);
    const folder = await companyFolder(company, "letterheads");
    let up;
    try {
      up = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { ...config, folder, public_id: `letterhead_${Date.now()}`, resource_type: "image", overwrite: false },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
        stream.end(req.file.buffer);
      });
    } catch (e) {
      console.error("[letterhead upload] cloudinary:", e.message);
      return fail(res, 502, "Couldn't store the letterhead. Try again.");
    }
    const st = await QuotationSettings.findOneAndUpdate(
      { company },
      { $set: { letterheadUrl: up.secure_url, letterheadName: req.file.originalname || "letterhead", updatedByName: actorOf(req).name },
        $setOnInsert: { company } },
      { new: true, upsert: true }
    ).lean();
    res.json({ success: true, settings: settingsDTO(st), size: { width: up.width, height: up.height } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// POST /api/quotations  — create a BUILT quotation (line items), assigns the next number.
async function createQuotation(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const a = actorOf(req); const b = req.body || {};
    if (!(await canUseLead(req, company, b.leadId))) return fail(res, 403, "You can't create a quotation for this lead.");
    const { number, seq, year } = await nextQuotationNumber(company, { prefix: b.prefix || "SKY" });
    const q = new Quotation({
      company, number, seq, year, source: "created",
      ...clientFrom(b),
      title: b.title || "", lineItems: Array.isArray(b.lineItems) ? b.lineItems : [],
      optedServices: Array.isArray(b.optedServices) ? b.optedServices : [],
      currency: b.currency || "INR",
      discountType: b.discountType || "none", discountValue: Number(b.discountValue) || 0, discountedBy: b.discountedBy || "",
      gstPercent: Number(b.gstPercent) || 0,
      handledBy: b.handledBy || a.name, handledByUser: a.id,
      remark: b.remark || "", status: b.status || "draft",
      createdBy: a.id, createdByName: a.name,
    });
    q.recalc();
    await q.save();
    await syncFinance(company, q);
    res.json({ success: true, quotation: q.toObject() });
  } catch (e) {
    if (e && e.code === 11000) return fail(res, 409, "Quotation number collision, please retry.");
    res.status(500).json({ success: false, message: e.message });
  }
}

// POST /api/quotations/upload  — register an UPLOADED quotation (PDF already uploaded to Cloudinary by the client
// or via a prior upload step). Still assigns the next sequential number.
async function uploadQuotation(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const a = actorOf(req); const b = req.body || {};
    if (!req.file && !/^https:\/\//i.test(String(b.fileUrl || ""))) return fail(res, 400, "Choose a PDF or image to upload.");
    // Check access BEFORE uploading so a refused request leaves no orphan file.
    if (!(await canUseLead(req, company, b.leadId))) return fail(res, 403, "You can't create a quotation for this lead.");

    let fileUrl = b.fileUrl, fileName = b.fileName || "quotation.pdf";
    if (req.file) {
      try {
        const up = await uploadQuotationFile(company, req.file);
        fileUrl = up.secure_url;
        fileName = req.file.originalname || fileName;
      } catch (e) {
        console.error("[quotation upload] cloudinary:", e.message);
        return fail(res, 502, "Couldn't store the file. Try again.");
      }
    }

    const amount = Math.max(0, Number(b.amount) || 0);
    const { number, seq, year } = await nextQuotationNumber(company, { prefix: b.prefix || "SKY" });
    const q = await Quotation.create({
      company, number, seq, year, source: "uploaded",
      fileUrl, fileName,
      ...clientFrom(b),
      grandTotal: amount,   // total typed by the user; the file itself is the source of truth
      currency: b.currency || "INR",
      title: b.title || "", optedServices: asArray(b.optedServices),
      discountedBy: b.discountedBy || "", handledBy: b.handledBy || a.name, handledByUser: a.id,
      remark: b.remark || "", status: b.status || "sent",
      createdBy: a.id, createdByName: a.name,
    });
    await syncFinance(company, q);
    res.json({ success: true, quotation: q.toObject() });
  } catch (e) {
    if (e && e.code === 11000) return fail(res, 409, "Quotation number collision, please retry.");
    res.status(500).json({ success: false, message: e.message });
  }
}

// GET /api/quotations  — list (optionally by lead)
async function listQuotations(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const q = { company };
    if (isId(req.query.leadId)) {
      if (!(await canUseLead(req, company, req.query.leadId))) return fail(res, 403, "You don't have access to this lead.");
      q.lead = req.query.leadId;
    } else if (isEmployee(req)) {
      q.$or = [{ createdBy: uidOf(req) }, { handledByUser: uidOf(req) }];
    }
    const items = await Quotation.find(q).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, quotations: items });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

async function getQuotation(req, res) {
  try {
    const company = companyIdOf(req);
    const q = await Quotation.findOne({ _id: req.params.id, company }).lean();
    if (!q || !(await canUseQuotation(req, company, q))) return fail(res, 404, "Quotation not found.");
    res.json({ success: true, quotation: q });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// PUT /api/quotations/:id  — edit a built quotation (recomputes money). Number never changes.
async function updateQuotation(req, res) {
  try {
    const company = companyIdOf(req); const b = req.body || {};
    const q = await Quotation.findOne({ _id: req.params.id, company });
    if (!q || !(await canUseQuotation(req, company, q))) return fail(res, 404, "Quotation not found.");
    const fields = ["title", "lineItems", "optedServices", "currency", "discountType", "discountValue", "discountedBy",
      "gstPercent", "handledBy", "remark", "status", "clientName", "clientEmail", "clientPhone", "clientCompany", "clientGSTIN", "clientAddress"];
    for (const k of fields) if (k in b) q[k] = b[k];
    if (q.source !== "uploaded") q.recalc();   // uploaded: keep the typed total
    await q.save();
    await syncFinance(company, q);
    res.json({ success: true, quotation: q.toObject() });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

async function deleteQuotation(req, res) {
  try {
    const company = companyIdOf(req);
    const existing = await Quotation.findOne({ _id: req.params.id, company }).select("createdBy handledByUser lead").lean();
    if (!existing || !(await canUseQuotation(req, company, existing))) return fail(res, 404, "Quotation not found.");
    const r = await Quotation.deleteOne({ _id: req.params.id, company });
    if (!r.deletedCount) return fail(res, 404, "Quotation not found.");
    res.json({ success: true, deleted: true });   // number is retired, never reused
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

module.exports = { createQuotation, uploadQuotation, listQuotations, getQuotation, updateQuotation, deleteQuotation,
  getSettings, updateSettings, uploadLetterhead };
