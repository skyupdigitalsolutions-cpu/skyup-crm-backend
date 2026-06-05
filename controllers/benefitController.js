// controllers/benefitController.js — NEW FILE
// Manages CompanyBenefit records: list, grant, extend, and deactivate.
// Every mutation writes an EntitlementAuditLog record via logAudit().

const CompanyBenefit = require("../models/CompanyBenefit");
const Company        = require("../models/Company");
const { logAudit }   = require("../services/entitlementService");

// ── Resolve actor from request ─────────────────────────────────────────────────
function getActor(req) {
  if (req.developer) return { actorId: req.developer._id, actorRole: "developer" };
  if (req.superAdmin) return { actorId: req.superAdmin._id, actorRole: "super_admin" };
  if (req.admin)     return { actorId: req.admin._id,     actorRole: req.admin.role || "super_admin" };
  return { actorId: null, actorRole: "system" };
}

// ── GET /api/benefits/:companyId ──────────────────────────────────────────────
// List all benefits for a company, newest first.
const listBenefits = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const benefits = await CompanyBenefit.find({ companyId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, companyId, companyName: company.name, benefits });
  } catch (err) {
    console.error("[listBenefits]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/benefits/:companyId/grant ───────────────────────────────────────
// Grant a benefit to a company (developer/superadmin only).
// Body: { benefitType, quantity?, validDays?, notes? }
//   validDays: number of days the benefit is valid (omit for permanent)
const grantBenefit = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { benefitType, quantity = 1, validDays, notes = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!benefitType) return res.status(400).json({ success: false, message: "benefitType is required" });

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const validFrom  = new Date();
    let   validUntil = null;
    if (validDays && parseInt(validDays, 10) > 0) {
      validUntil = new Date(validFrom);
      validUntil.setDate(validUntil.getDate() + parseInt(validDays, 10));
    }

    const benefit = await CompanyBenefit.create({
      companyId,
      benefitType,
      quantity:  Math.max(1, parseInt(quantity, 10)),
      grantedBy: actorId,
      validFrom,
      validUntil,
      active:    true,
      notes,
    });

    await logAudit({
      companyId,
      actorId,
      actorRole,
      action:   "benefit_granted",
      field:    "benefitType",
      newValue: benefitType,
      reason:   notes || `Benefit granted: ${benefitType} × ${quantity}${validDays ? ` for ${validDays} days` : " (permanent)"}`,
    });

    res.status(201).json({ success: true, benefit });
  } catch (err) {
    console.error("[grantBenefit]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/benefits/:benefitId/extend ───────────────────────────────────────
// Extend the validUntil of an existing benefit.
// Body: { validDays, reason? }  — adds validDays to current validUntil (or now)
const extendBenefit = async (req, res) => {
  try {
    const { benefitId } = req.params;
    const { validDays, reason = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!validDays || parseInt(validDays, 10) < 1) {
      return res.status(400).json({ success: false, message: "validDays must be >= 1" });
    }

    const benefit = await CompanyBenefit.findById(benefitId);
    if (!benefit) return res.status(404).json({ success: false, message: "Benefit not found" });

    const oldUntil = benefit.validUntil;

    // Extend from current validUntil (or now if already expired/null)
    const base = benefit.validUntil && benefit.validUntil > new Date()
      ? new Date(benefit.validUntil)
      : new Date();
    base.setDate(base.getDate() + parseInt(validDays, 10));

    benefit.validUntil = base;
    benefit.active     = true; // re-activate if it was expired
    await benefit.save();

    await logAudit({
      companyId: benefit.companyId,
      actorId,
      actorRole,
      action:   "benefit_extended",
      field:    "validUntil",
      oldValue: oldUntil,
      newValue: benefit.validUntil,
      reason:   reason || `Extended by ${validDays} day(s)`,
    });

    res.json({ success: true, benefit });
  } catch (err) {
    console.error("[extendBenefit]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/benefits/:benefitId ──────────────────────────────────────────
// Deactivate a benefit (soft delete — sets active: false).
// Body: { reason? }
const deactivateBenefit = async (req, res) => {
  try {
    const { benefitId } = req.params;
    const { reason = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    const benefit = await CompanyBenefit.findById(benefitId);
    if (!benefit) return res.status(404).json({ success: false, message: "Benefit not found" });

    benefit.active = false;
    await benefit.save();

    await logAudit({
      companyId: benefit.companyId,
      actorId,
      actorRole,
      action:   "benefit_removed",
      field:    "active",
      oldValue: true,
      newValue: false,
      reason:   reason || "Manually deactivated",
    });

    res.json({ success: true, message: "Benefit deactivated", benefit });
  } catch (err) {
    console.error("[deactivateBenefit]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  listBenefits,
  grantBenefit,
  extendBenefit,
  deactivateBenefit,
};
