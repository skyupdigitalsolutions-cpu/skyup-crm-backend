// controllers/quotationController.js — quotations for the web app. Scoped per company, numbered sequentially
// (per company, per year), supports a built quotation or an uploaded PDF. Reuses the CRM's auth/company scoping.
"use strict";
const mongoose = require("mongoose");
const Quotation = require("../models/Quotation");
const Lead = require("../models/Leads");
const { nextQuotationNumber } = require("../services/quotationNumberService");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const companyIdOf = (req) =>
  req.user?.companyId || req.user?.company?._id || req.user?.company ||
  req.admin?.company?._id || req.admin?.company ||
  (req.developer && isId(req.params?.companyId) ? req.params.companyId : null) || null;
const actorOf = (req) => ({
  id: req.user?._id || req.user?.id || req.admin?._id || null,
  name: req.user?.name || req.admin?.name || "User",
});
const fail = (res, c, m) => res.status(c).json({ success: false, message: m });

// Build the client snapshot + optional lead link from the request.
function clientFrom(b) {
  return {
    lead: isId(b.leadId) ? b.leadId : null,
    clientName: b.clientName || "", clientEmail: b.clientEmail || "", clientPhone: b.clientPhone || "",
    clientCompany: b.clientCompany || "", clientGSTIN: b.clientGSTIN || "", clientAddress: b.clientAddress || "",
  };
}

// POST /api/quotations  — create a BUILT quotation (line items), assigns the next number.
async function createQuotation(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const a = actorOf(req); const b = req.body || {};
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
    if (!b.fileUrl) return fail(res, 400, "fileUrl is required for an uploaded quotation.");
    const { number, seq, year } = await nextQuotationNumber(company, { prefix: b.prefix || "SKY" });
    const q = await Quotation.create({
      company, number, seq, year, source: "uploaded",
      fileUrl: b.fileUrl, fileName: b.fileName || "quotation.pdf",
      ...clientFrom(b),
      title: b.title || "", optedServices: Array.isArray(b.optedServices) ? b.optedServices : [],
      discountedBy: b.discountedBy || "", handledBy: b.handledBy || a.name, handledByUser: a.id,
      remark: b.remark || "", status: b.status || "sent",
      createdBy: a.id, createdByName: a.name,
    });
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
    if (isId(req.query.leadId)) q.lead = req.query.leadId;
    const items = await Quotation.find(q).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, quotations: items });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

async function getQuotation(req, res) {
  try {
    const company = companyIdOf(req);
    const q = await Quotation.findOne({ _id: req.params.id, company }).lean();
    if (!q) return fail(res, 404, "Quotation not found.");
    res.json({ success: true, quotation: q });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// PUT /api/quotations/:id  — edit a built quotation (recomputes money). Number never changes.
async function updateQuotation(req, res) {
  try {
    const company = companyIdOf(req); const b = req.body || {};
    const q = await Quotation.findOne({ _id: req.params.id, company });
    if (!q) return fail(res, 404, "Quotation not found.");
    const fields = ["title", "lineItems", "optedServices", "currency", "discountType", "discountValue", "discountedBy",
      "gstPercent", "handledBy", "remark", "status", "clientName", "clientEmail", "clientPhone", "clientCompany", "clientGSTIN", "clientAddress"];
    for (const k of fields) if (k in b) q[k] = b[k];
    q.recalc();
    await q.save();
    res.json({ success: true, quotation: q.toObject() });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

async function deleteQuotation(req, res) {
  try {
    const company = companyIdOf(req);
    const r = await Quotation.deleteOne({ _id: req.params.id, company });
    if (!r.deletedCount) return fail(res, 404, "Quotation not found.");
    res.json({ success: true, deleted: true });   // number is retired, never reused
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

module.exports = { createQuotation, uploadQuotation, listQuotations, getQuotation, updateQuotation, deleteQuotation };
