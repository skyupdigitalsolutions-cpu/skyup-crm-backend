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

// ── Quotation content (extra sections) — cleaned before saving ──────────────
const BILLINGS = ["one_time", "monthly", "quarterly", "half_yearly", "yearly"];
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const num = (v, lo = 0, hi = 1e12) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

const cleanLine = (li) => ({
  description: str(li?.description, 300), details: str(li?.details, 3000), module: str(li?.module, 80), priceLabel: str(li?.priceLabel, 80), chargeNote: str(li?.chargeNote, 120),
  quantity: num(li?.quantity), unitPrice: num(li?.unitPrice),
  billing: BILLINGS.includes(li?.billing) ? li.billing : "one_time",
});

// Only keys present in the body are returned, so updates stay partial.
function contentFrom(b) {
  const out = {};
  if ("lineItems" in b)       out.lineItems = arr(b.lineItems, 200).map(cleanLine).filter((x) => x.description);
  if ("optionalItems" in b)   out.optionalItems = arr(b.optionalItems, 50).map(cleanLine).filter((x) => x.description)
                                .map(({ module, ...rest }) => rest);
  if ("timeline" in b)        out.timeline = arr(b.timeline, 30).map((t) => ({ phase: str(t?.phase, 150), duration: str(t?.duration, 60), details: str(t?.details, 600) })).filter((t) => t.phase);
  if ("paymentSchedule" in b) out.paymentSchedule = arr(b.paymentSchedule, 30).map((p) => ({ label: str(p?.label, 150), percent: num(p?.percent, 0, 100), amount: num(p?.amount), due: str(p?.due, 80) })).filter((p) => p.label);
  if ("customBlocks" in b)    out.customBlocks = arr(b.customBlocks, 10).map((c) => ({ title: str(c?.title, 120), body: str(c?.body, 5000) })).filter((c) => c.title);
  for (const [k, max] of [["scopeOfWork", 8000], ["serviceInfo", 8000], ["suggestions", 5000], ["terms", 10000], ["paymentTerms", 5000]]) {
    if (k in b) out[k] = str(b[k], max);
  }
  for (const [k, max] of [["introduction", 8000], ["aboutUs", 5000], ["coverSubtitle", 300]]) if (k in b) out[k] = str(b[k], max);
  if ("designId" in b) out.designId = isId(b.designId) ? b.designId : null;
  if ("coverPage" in b)  out.coverPage = !!b.coverPage;
  if ("showTotals" in b) out.showTotals = b.showTotals !== false;
  if ("highlights" in b) out.highlights = arr(b.highlights, 4).map((h) => ({ label: str(h?.label, 40), value: str(h?.value, 40), note: str(h?.note, 60) })).filter((h) => h.label);
  if ("customTables" in b) {
    out.customTables = arr(b.customTables, 10).map((t) => {
      const columns = arr(t?.columns, 6).map((c) => str(c, 60));
      const width = Math.max(1, columns.length);
      const rows = arr(t?.rows, 60).map((r) => ({ cells: arr(Array.isArray(r) ? r : r?.cells, width).map((c) => str(c, 600)) }))
        .filter((r) => r.cells.some((c) => c));
      return { title: str(t?.title, 120), note: str(t?.note, 1000), columns, rows };
    }).filter((t) => t.title || t.rows.length);
  }
  if ("validUntil" in b) { const d = b.validUntil ? new Date(b.validUntil) : null; out.validUntil = d && !isNaN(d) ? d : null; }
  return out;
}

const STATUSES = ["draft", "sent", "accepted", "rejected"];
const cleanStatus = (v, dflt) => (STATUSES.includes(v) ? v : dflt);

// Validate the whole quotation BEFORE taking a number, so a quotation that
// can't be saved never uses one up (the sequence only gets gaps from deletes).
// Returns a readable message for the person, or "" when it's fine.
async function validationProblem(doc) {
  try { await doc.validate(); return ""; }
  catch (e) {
    const first = e?.errors && Object.values(e.errors)[0];
    if (first?.kind === "maxlength") return `"${first.path}" is too long.`;
    if (first?.kind === "enum") return `"${first.value}" isn't a valid ${first.path}.`;
    return first?.message || "Some details aren't valid.";
  }
}

const cleanPrefix = (p) => String(p || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12) || "SKY";

// ── Letterhead / print settings (per company) ────────────────────────────────
const QuotationSettings = require("../models/QuotationSettings");
const isAdminCaller = (req) => !!req.admin;   // protectAny: admins / super admins set req.admin

const SECTION_KEYS = ["client", "subject", "introduction", "aboutUs", "highlights", "scope", "items", "totals", "optionalItems",
  "customTables", "paymentSchedule", "timeline", "serviceInfo", "suggestions", "customBlocks", "paymentTerms", "terms",
  "bankDetails", "notes", "signature"];
const COLUMN_KEYS = ["index", "description", "billing", "qty", "unitPrice", "amount"];
const LAYOUTS = ["classic", "modern", "minimal"];
const FONTS = ["arial", "helvetica", "georgia", "times", "verdana", "trebuchet", "segoe"];

function cleanColumns(c) {
  const out = {};
  for (const k of COLUMN_KEYS) {
    const v = c && typeof c === "object" ? c[k] : null;
    if (!v || typeof v !== "object") continue;
    out[k] = { show: k === "description" || k === "amount" ? true : v.show !== false, label: str(v.label, 40) };
  }
  return out;
}
function cleanSections(list) {
  const seen = new Set(); const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || !SECTION_KEYS.includes(v.key) || seen.has(v.key)) continue;
    seen.add(v.key);
    out.push({ key: v.key, label: str(v.label, 60), show: v.key === "items" || v.key === "totals" ? true : v.show !== false });
  }
  return out;   // missing keys are filled with defaults by the frontend, in default position
}

// One design's look, cleaned with the same rules as the top-level (Standard) one.
const httpsUrl = (v) => (/^https:\/\//i.test(String(v || "")) ? String(v).slice(0, 600) : "");
function cleanLook(l = {}) {
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  return {
    documentTitle: str(l.documentTitle, 40) || "Quotation",
    layoutStyle: LAYOUTS.includes(l.layoutStyle) ? l.layoutStyle : "classic",
    accentColor: /^#[0-9a-fA-F]{6}$/.test(String(l.accentColor || "")) ? l.accentColor : "#1F3A8A",
    fontFamily: FONTS.includes(l.fontFamily) ? l.fontFamily : "arial",
    columns: cleanColumns(l.columns), sections: cleanSections(l.sections),
    letterheadUrl: httpsUrl(l.letterheadUrl), letterheadName: str(l.letterheadName, 120),
    marginTopMm: clamp(l.marginTopMm, 0, 150, 40), marginBottomMm: clamp(l.marginBottomMm, 0, 150, 25), marginSideMm: clamp(l.marginSideMm, 5, 60, 15),
    hideBuiltInHeader: l.hideBuiltInHeader !== false,
    stampUrl: httpsUrl(l.stampUrl), signatoryName: str(l.signatoryName, 80), signatoryTitle: str(l.signatoryTitle, 80),
    showFooterBar: l.showFooterBar !== false, numberedHeadings: !!l.numberedHeadings, clientSignature: l.clientSignature !== false,
    showGstSuffix: !!l.showGstSuffix, coverPageDefault: !!l.coverPageDefault,
  };
}

const settingsDTO = (st) => ({
  letterheadUrl: st?.letterheadUrl || "", letterheadName: st?.letterheadName || "",
  marginTopMm: st?.marginTopMm ?? 40, marginBottomMm: st?.marginBottomMm ?? 25, marginSideMm: st?.marginSideMm ?? 15,
  hideBuiltInHeader: st?.hideBuiltInHeader ?? true,
  documentTitle: st?.documentTitle || "Quotation", numberPrefix: st?.numberPrefix || "SKY",
  currency: st?.currency || "INR", defaultGstPercent: st?.defaultGstPercent ?? 18, validityDays: st?.validityDays ?? 15,
  defaultTerms: st?.defaultTerms || "", defaultPaymentTerms: st?.defaultPaymentTerms || "", defaultServiceInfo: st?.defaultServiceInfo || "",
  layoutStyle: st?.layoutStyle || "classic", accentColor: st?.accentColor || "#1F3A8A", fontFamily: st?.fontFamily || "arial",
  columns: cleanColumns(st?.columns), sections: cleanSections(st?.sections),
  stampUrl: st?.stampUrl || "", signatoryName: st?.signatoryName || "", signatoryTitle: st?.signatoryTitle || "",
  companyName: st?.companyName || "", companyAddress: st?.companyAddress || "", companyGstin: st?.companyGstin || "",
  companyPhone: st?.companyPhone || "", companyEmail: st?.companyEmail || "", companyWebsite: st?.companyWebsite || "",
  defaultAboutUs: st?.defaultAboutUs || "", bankDetails: st?.bankDetails || "", qrUrl: st?.qrUrl || "", qrCaption: st?.qrCaption || "",
  showFooterBar: st?.showFooterBar ?? true, numberedHeadings: st?.numberedHeadings ?? false, clientSignature: st?.clientSignature ?? true,
  showGstSuffix: st?.showGstSuffix ?? false, coverPageDefault: st?.coverPageDefault ?? false,
  standardDesignName: st?.standardDesignName || "Standard",
  designs: (st?.designs || []).map((d) => ({ _id: d._id, name: d.name, look: cleanLook(d.look || {}) })),
  catalog: (st?.catalog || []).map((c) => ({ _id: c._id, name: c.name, details: c.details || "", unitPrice: c.unitPrice || 0, billing: c.billing || "one_time",
    module: c.module || "", category: c.category || "", note: c.note || "" })),
  updatedAt: st?.updatedAt || null, updatedByName: st?.updatedByName || "",
});

// GET /api/quotations/settings — everyone (employees need it to print).
async function getSettings(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const st = await QuotationSettings.findOne({ company }).lean();
    res.json({ success: true, settings: settingsDTO(st), canEdit: isAdminCaller(req) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// PUT /api/quotations/settings — admins: margins / header toggle / remove letterhead.
async function updateSettings(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can change quotation settings.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const b = req.body || {};
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
    const $set = { updatedByName: actorOf(req).name };
    if (b.marginTopMm !== undefined && Number.isFinite(Number(b.marginTopMm)))       $set.marginTopMm    = clamp(b.marginTopMm, 0, 150);
    if (b.marginBottomMm !== undefined && Number.isFinite(Number(b.marginBottomMm))) $set.marginBottomMm = clamp(b.marginBottomMm, 0, 150);
    if (b.marginSideMm !== undefined && Number.isFinite(Number(b.marginSideMm)))     $set.marginSideMm   = clamp(b.marginSideMm, 5, 60);
    if (b.hideBuiltInHeader !== undefined) $set.hideBuiltInHeader = !!b.hideBuiltInHeader;
    if (b.removeLetterhead) { $set.letterheadUrl = ""; $set.letterheadName = ""; }
    if (b.removeStamp) $set.stampUrl = "";
    if (b.removeQr) $set.qrUrl = "";
    for (const [k, max] of [["companyName", 120], ["companyAddress", 400], ["companyPhone", 40], ["companyEmail", 120], ["companyWebsite", 120],
                            ["defaultAboutUs", 5000], ["bankDetails", 1000], ["qrCaption", 80]]) {
      if (b[k] !== undefined) $set[k] = str(b[k], max);
    }
    if (b.companyGstin !== undefined) $set.companyGstin = str(b.companyGstin, 20).toUpperCase();
    for (const k of ["showFooterBar", "numberedHeadings", "clientSignature", "showGstSuffix", "coverPageDefault"]) {
      if (b[k] !== undefined) $set[k] = !!b[k];
    }

    if (b.documentTitle !== undefined) $set.documentTitle = str(b.documentTitle, 40) || "Quotation";
    if (b.numberPrefix !== undefined)  $set.numberPrefix = cleanPrefix(b.numberPrefix);
    if (b.currency !== undefined)      $set.currency = (str(b.currency, 3).toUpperCase().replace(/[^A-Z]/g, "") || "INR");
    if (b.defaultGstPercent !== undefined) $set.defaultGstPercent = num(b.defaultGstPercent, 0, 100);
    if (b.validityDays !== undefined)      $set.validityDays = Math.round(num(b.validityDays, 0, 365));
    for (const [k, max] of [["defaultTerms", 10000], ["defaultPaymentTerms", 5000], ["defaultServiceInfo", 8000], ["signatoryName", 80], ["signatoryTitle", 80]]) {
      if (b[k] !== undefined) $set[k] = str(b[k], max);
    }
    if (b.layoutStyle !== undefined && LAYOUTS.includes(b.layoutStyle)) $set.layoutStyle = b.layoutStyle;
    if (b.fontFamily !== undefined && FONTS.includes(b.fontFamily))     $set.fontFamily = b.fontFamily;
    if (b.accentColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(b.accentColor))) $set.accentColor = String(b.accentColor);
    if (b.columns !== undefined)  $set.columns = cleanColumns(b.columns);
    if (b.sections !== undefined) $set.sections = cleanSections(b.sections);
    if (b.standardDesignName !== undefined) $set.standardDesignName = str(b.standardDesignName, 40) || "Standard";
    if (b.designs !== undefined) {
      $set.designs = arr(b.designs, 10)
        .map((d) => ({ ...(isId(d?._id) ? { _id: d._id } : {}), name: str(d?.name, 40), look: cleanLook(d?.look || {}) }))
        .filter((d) => d.name);
    }
    if (b.catalog !== undefined) {
      $set.catalog = arr(b.catalog, 200).map((c) => ({
        name: str(c?.name, 300), details: str(c?.details, 3000), unitPrice: num(c?.unitPrice),
        billing: BILLINGS.includes(c?.billing) ? c.billing : "one_time", module: str(c?.module, 80),
        category: str(c?.category, 60), note: str(c?.note, 120),
      })).filter((c) => c.name);
    }
    const st = await QuotationSettings.findOneAndUpdate({ company }, { $set, $setOnInsert: { company } }, { new: true, upsert: true }).lean();
    res.json({ success: true, settings: settingsDTO(st) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// POST /api/quotations/settings/letterhead — admins: upload the letterhead image.
async function uploadLetterhead(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can change quotation settings.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const kind = ["stamp", "qr"].includes(req.params.kind) ? req.params.kind : "letterhead";
    if (!req.file) return fail(res, 400, `Choose the ${{ stamp: "signature / stamp", qr: "payment QR" }[kind] || "letterhead"} image (PNG, JPG or WEBP).`);
    const designId = isId(req.query?.design) ? String(req.query.design) : null;
    if (designId && kind === "qr") return fail(res, 400, "The payment QR is shared by all designs.");
    if (designId && !(await QuotationSettings.exists({ company, "designs._id": designId }))) return fail(res, 404, "Design not found — save it first.");
    const { config } = await resolveCompanyConfig(company);
    const folder = await companyFolder(company, "letterheads");
    let up;
    try {
      up = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { ...config, folder, public_id: `${kind}_${Date.now()}`, resource_type: "image", overwrite: false },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
        stream.end(req.file.buffer);
      });
    } catch (e) {
      console.error(`[${kind} upload] cloudinary:`, e.message);
      return fail(res, 502, "Couldn't store the image. Try again.");
    }
    if (designId) {   // this design's own letterhead / stamp
      const field = kind === "stamp" ? "stampUrl" : "letterheadUrl";
      const st = await QuotationSettings.findOneAndUpdate(
        { company, "designs._id": designId },
        { $set: { [`designs.$.look.${field}`]: up.secure_url, ...(kind === "letterhead" ? { "designs.$.look.letterheadName": req.file.originalname || "letterhead" } : {}), updatedByName: actorOf(req).name } },
        { new: true }
      ).lean();
      return res.json({ success: true, settings: settingsDTO(st), size: { width: up.width, height: up.height } });
    }
    const st = await QuotationSettings.findOneAndUpdate(
      { company },
      { $set: kind === "stamp" ? { stampUrl: up.secure_url, updatedByName: actorOf(req).name }
          : kind === "qr"     ? { qrUrl: up.secure_url, updatedByName: actorOf(req).name }
          : { letterheadUrl: up.secure_url, letterheadName: req.file.originalname || "letterhead", updatedByName: actorOf(req).name },
        $setOnInsert: { company } },
      { new: true, upsert: true }
    ).lean();
    res.json({ success: true, settings: settingsDTO(st), size: { width: up.width, height: up.height } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// ── Content templates: GET/POST /templates, PUT/DELETE /templates/:id ───────
// Everyone can list and use them; admins create, rename, overwrite and delete.
const QuotationTemplate = require("../models/QuotationTemplate");
const TEMPLATE_KEYS = ["lineItems", "optionalItems", "timeline", "paymentSchedule", "customBlocks", "scopeOfWork", "serviceInfo", "suggestions",
  "terms", "paymentTerms", "introduction", "aboutUs", "highlights", "customTables", "coverPage", "coverSubtitle", "showTotals", "designId"];
function templateContentFrom(b = {}) {
  const src = {};
  for (const k of TEMPLATE_KEYS) if (k in b) src[k] = b[k];
  const c = contentFrom(src);
  if ("title" in b) c.title = str(b.title, 300);
  if ("remark" in b) c.remark = str(b.remark, 3000);
  if ("currency" in b) c.currency = str(b.currency, 3).toUpperCase();
  if ("discountType" in b) c.discountType = ["none", "percent", "amount"].includes(b.discountType) ? b.discountType : "none";
  if ("discountValue" in b) c.discountValue = num(b.discountValue);
  if ("gstPercent" in b) c.gstPercent = num(b.gstPercent, 0, 100);
  return c;   // never any client details, lead, number, status or dates
}
async function listTemplates(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const list = await QuotationTemplate.find({ company }).sort({ name: 1 }).lean();
    res.json({ success: true, templates: list.map((t) => ({ _id: t._id, name: t.name, description: t.description, content: t.content, updatedAt: t.updatedAt, updatedByName: t.updatedByName || t.createdByName })), canEdit: isAdminCaller(req) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}
async function saveTemplate(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can save templates.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const b = req.body || {};
    const name = str(b.name, 80); if (!name) return fail(res, 400, "Give the template a name.");
    const content = templateContentFrom(b.content || {});
    if (!(content.lineItems || []).length) return fail(res, 400, "A template needs at least one item.");
    const who = actorOf(req).name;
    const id = req.params?.id;
    if (id) {
      if (!isId(id)) return fail(res, 400, "Invalid template.");
      const t = await QuotationTemplate.findOneAndUpdate({ _id: id, company },
        { $set: { name, description: str(b.description, 300), ...(b.content ? { content } : {}), updatedByName: who } }, { new: true }).lean();
      if (!t) return fail(res, 404, "Template not found.");
      return res.json({ success: true, template: t });
    }
    const t = await QuotationTemplate.create({ company, name, description: str(b.description, 300), content, createdByName: who, updatedByName: who });
    res.json({ success: true, template: t.toObject() });
  } catch (e) {
    if (e && e.code === 11000) return fail(res, 409, "A template with this name already exists — pick it to overwrite, or choose another name.");
    res.status(500).json({ success: false, message: e.message });
  }
}
async function renameTemplate(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can change templates.");
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid template.");
    const b = req.body || {};
    const $set = { updatedByName: actorOf(req).name };
    if (b.name !== undefined) { $set.name = str(b.name, 80); if (!$set.name) return fail(res, 400, "Give the template a name."); }
    if (b.description !== undefined) $set.description = str(b.description, 300);
    if (b.content !== undefined) {
      $set.content = templateContentFrom(b.content);
      if (!($set.content.lineItems || []).length) return fail(res, 400, "A template needs at least one item.");
    }
    const t = await QuotationTemplate.findOneAndUpdate({ _id: req.params.id, company }, { $set }, { new: true }).lean();
    if (!t) return fail(res, 404, "Template not found.");
    res.json({ success: true, template: t });
  } catch (e) {
    if (e && e.code === 11000) return fail(res, 409, "A template with this name already exists.");
    res.status(500).json({ success: false, message: e.message });
  }
}
async function deleteTemplate(req, res) {
  try {
    if (!isAdminCaller(req)) return fail(res, 403, "Only admins can delete templates.");
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid template.");
    const r = await QuotationTemplate.deleteOne({ _id: req.params.id, company });
    if (!r.deletedCount) return fail(res, 404, "Template not found.");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// ── GET /api/quotations/match-lead?phone=&email=&name=&company= ─────────────
// Finds the lead a quotation belongs to from the client details typed on it.
// Phone → normalizedPhone / normalizedSecondaryPhone (same 10-digit rule the
// CRM uses for duplicate checks); email → exact (case-insensitive); name /
// company → contains. Employees only ever see leads assigned to them.
const { normalizePhone } = require("../utils/normalizePhone");
const escRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const maskTail = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 4 ? `••••••${d.slice(-4)}` : ""; };
async function matchLead(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const scope = { company };
    if (isEmployee(req)) scope.user = uidOf(req);
    const phone = normalizePhone(req.query.phone);
    const email = String(req.query.email || "").trim().toLowerCase();
    const name = String(req.query.name || "").trim();
    const biz = String(req.query.company || "").trim();
    const found = new Map();
    const add = (list, match, strength) => list.forEach((l) => {
      const k = String(l._id);
      if (!found.has(k) || found.get(k).strength < strength) found.set(k, { lead: l, match, strength });
    });
    const sel = "name businessName email primaryPhone mobile status user createdAt";
    if (phone) add(await Lead.find({ ...scope, $or: [{ normalizedPhone: phone }, { normalizedSecondaryPhone: phone }] }).select(sel).limit(5).lean(), "phone", 3);
    if (/^\S+@\S+\.\S+$/.test(email)) add(await Lead.find({ ...scope, email: new RegExp(`^${escRx(email)}$`, "i") }).select(sel).limit(5).lean(), "email", 3);
    if (biz.length >= 3) add(await Lead.find({ ...scope, businessName: new RegExp(escRx(biz), "i") }).select(sel).limit(5).lean(), "company", 1);
    if (name.length >= 3) add(await Lead.find({ ...scope, name: new RegExp(escRx(name), "i") }).select(sel).sort({ createdAt: -1 }).limit(8).lean(), "name", 1);
    const leads = [...found.values()].sort((a, b) => b.strength - a.strength).slice(0, 8).map(({ lead: l, match, strength }) => ({
      _id: l._id, id: String(l._id), name: l.name, businessName: l.businessName || "", status: l.status,
      phoneHint: maskTail(l.primaryPhone || l.mobile), email: l.email || "", match, exact: strength >= 3,
    }));
    res.json({ success: true, leads });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// ── GET /api/quotations/lead/:leadId/prefill ─────────────────────────────────
// Best-known client details for a lead, so a new quotation starts filled in.
// Precedence per field: the lead's latest quotation (what someone last typed)
// > its finance invoice > the lead itself > the lead's custom fields.
// Everything stays editable in the form; nothing here is written back.
const pickCustom = (cf, re) => {
  for (const [k, v] of Object.entries(cf || {})) {
    if (re.test(k) && v != null && typeof v !== "object" && String(v).trim()) return String(v).trim();
  }
  return "";
};
const usableContact = (v) => { const t = String(v || "").trim(); return t && !t.startsWith("enc:") ? t : ""; };
async function leadPrefill(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const leadId = req.params.leadId;
    if (!isId(leadId)) return fail(res, 400, "Invalid lead.");
    if (!(await canUseLead(req, company, leadId))) return fail(res, 403, "You don't have access to this lead.");

    const FinanceInvoice = require("../models/FinanceInvoice");
    const [lead, lastQ, inv] = await Promise.all([
      Lead.findOne({ _id: leadId, company }).select("name email businessName service services industry customFields primaryPhone mobile").lean(),
      Quotation.findOne({ company, lead: leadId, source: "created" }).sort({ createdAt: -1 })
        .select("number clientName clientCompany clientPhone clientEmail clientGSTIN clientAddress").lean(),
      FinanceInvoice.findOne({ company, lead: leadId }).sort({ createdAt: -1 }).select("customerName businessName clientGSTIN clientAddress invoiceNumber").lean(),
    ]);
    if (!lead) return fail(res, 404, "Lead not found.");

    const cf = lead.customFields instanceof Map ? Object.fromEntries(lead.customFields) : (lead.customFields || {});
    const from = {};
    const take = (field, ...candidates) => {
      for (const [val, src] of candidates) {
        if (val && String(val).trim()) { from[field] = src; return String(val).trim(); }
      }
      return "";
    };
    const qSrc = lastQ ? `quotation ${lastQ.number}` : "";
    const iSrc = inv ? (inv.invoiceNumber ? `invoice ${inv.invoiceNumber}` : "finance") : "";
    const details = {
      clientName:    take("clientName",    [lastQ?.clientName, qSrc], [inv?.customerName, iSrc], [lead.name, "lead"]),
      clientCompany: take("clientCompany", [lastQ?.clientCompany, qSrc], [inv?.businessName, iSrc], [lead.businessName, "lead"],
                                           [pickCustom(cf, /company|business|organi[sz]ation|firm/i), "lead custom field"]),
      clientGSTIN:   take("clientGSTIN",   [lastQ?.clientGSTIN, qSrc], [inv?.clientGSTIN, iSrc], [pickCustom(cf, /gst/i), "lead custom field"]),
      clientAddress: take("clientAddress", [lastQ?.clientAddress, qSrc], [inv?.clientAddress, iSrc],
                                           [pickCustom(cf, /address|city|location|area/i), "lead custom field"]),
      // The lead's own phone / email come first (the browser logs the reveal,
      // like the 👁 button on the Leads page); an older quotation's is a fallback.
      clientPhone:   take("clientPhone",   [usableContact(lead.primaryPhone || lead.mobile), "lead"], [lastQ?.clientPhone, qSrc]),
      clientEmail:   take("clientEmail",   [usableContact(lead.email), "lead"], [lastQ?.clientEmail, qSrc]),
    };
    res.json({
      success: true, details, from,
      services: [...new Set([...(lead.services || []), lead.service].filter(Boolean))],
      industry: lead.industry || "",
      lastQuotation: lastQ ? lastQ.number : null,
      lead: { _id: lead._id, id: String(lead._id), name: lead.name, businessName: lead.businessName || "" },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
}

// POST /api/quotations  — create a BUILT quotation (line items), assigns the next number.
async function createQuotation(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const a = actorOf(req); const b = req.body || {};
    if (!(await canUseLead(req, company, b.leadId))) return fail(res, 403, "You can't create a quotation for this lead.");
    // The prefix comes from the company's settings, never from the request.
    const st = await QuotationSettings.findOne({ company }).select("numberPrefix currency").lean();
    const q = new Quotation({
      company, number: "PENDING", seq: 0, year: 0, source: "created",   // real number assigned below
      ...clientFrom(b),
      ...contentFrom({ lineItems: [], ...b }),
      title: str(b.title, 300),
      optedServices: Array.isArray(b.optedServices) ? b.optedServices : [],
      currency: str(b.currency, 3).toUpperCase() || st?.currency || "INR",
      discountType: ["none", "percent", "amount"].includes(b.discountType) ? b.discountType : "none", discountValue: Number(b.discountValue) || 0, discountedBy: b.discountedBy || "",
      gstPercent: Number(b.gstPercent) || 0,
      handledBy: b.handledBy || a.name, handledByUser: a.id,
      remark: b.remark || "", status: cleanStatus(b.status, "draft"),
      createdBy: a.id, createdByName: a.name,
    });
    q.recalc();
    const problem = await validationProblem(q);
    if (problem) return fail(res, 400, problem);
    Object.assign(q, await nextQuotationNumber(company, { prefix: cleanPrefix(st?.numberPrefix) }));
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
    const stU = await QuotationSettings.findOne({ company }).select("numberPrefix").lean();
    const q = new Quotation({
      company, number: "PENDING", seq: 0, year: 0, source: "uploaded",   // real number assigned below
      fileUrl, fileName,
      ...clientFrom(b),
      grandTotal: amount,   // total typed by the user; the file itself is the source of truth
      currency: b.currency || "INR",
      title: b.title || "", optedServices: asArray(b.optedServices),
      discountedBy: b.discountedBy || "", handledBy: b.handledBy || a.name, handledByUser: a.id,
      remark: b.remark || "", status: cleanStatus(b.status, "sent"),
      createdBy: a.id, createdByName: a.name,
    });
    const problem = await validationProblem(q);
    if (problem) return fail(res, 400, problem);
    Object.assign(q, await nextQuotationNumber(company, { prefix: cleanPrefix(stU?.numberPrefix) }));
    await q.save();
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
      // Their own quotations, plus any quotation on a lead assigned to them.
      const myLeads = await Lead.find({ company, user: uidOf(req) }).distinct("_id");
      q.$or = [{ createdBy: uidOf(req) }, { handledByUser: uidOf(req) }, { lead: { $in: myLeads } }];
    }
    if (["draft", "sent", "accepted", "rejected"].includes(req.query.status)) q.status = req.query.status;
    if (req.query.linked === "no") q.lead = null;
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      if (req.query.from) q.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) { const t = new Date(req.query.to); t.setHours(23, 59, 59, 999); q.createdAt.$lte = t; }
    }
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i");
      const searchOr = [{ number: rx }, { clientName: rx }, { clientCompany: rx }, { title: rx }, { clientEmail: rx }];
      q.$and = [...(q.$and || []), { $or: searchOr }];
    }
    const items = await Quotation.find(q).sort({ createdAt: -1 }).limit(500)
      .populate("lead", "name businessName status").lean();
    res.json({ success: true, quotations: items.map((x) => ({ ...x, lead: x.lead?._id || x.lead || null, leadInfo: x.lead?._id ? { name: x.lead.name, businessName: x.lead.businessName || "", status: x.lead.status } : null })) });
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
    const fields = ["title", "optedServices", "currency", "discountType", "discountValue", "discountedBy",
      "gstPercent", "handledBy", "remark", "status", "clientName", "clientEmail", "clientPhone", "clientCompany", "clientGSTIN", "clientAddress"];
    for (const k of fields) if (k in b) q[k] = b[k];
    Object.assign(q, contentFrom(b));
    if ("leadId" in b) {   // link to a lead, change it, or unlink (null)
      if (b.leadId && !isId(b.leadId)) return fail(res, 400, "Invalid lead.");
      if (b.leadId && !(await canUseLead(req, company, b.leadId))) return fail(res, 403, "You can't link this quotation to that lead.");
      q.lead = b.leadId || null;
    }
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
  getSettings, updateSettings, uploadLetterhead, leadPrefill, matchLead,
  listTemplates, saveTemplate, renameTemplate, deleteTemplate };
