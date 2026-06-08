// controllers/addonController.js — NEW FILE
// Manages CompanyAddon records: list, purchase (paid), grant (free),
// renew (extend expiry), and disable.
// Every mutation writes an EntitlementAuditLog record via logAudit().

const CompanyAddon = require("../models/CompanyAddon");
const Company      = require("../models/Company");
const { logAudit } = require("../services/entitlementService");

// ── Resolve actor from request (developer or super_admin) ──────────────────────
function getActor(req) {
  if (req.developer) return { actorId: req.developer._id, actorRole: "developer" };
  if (req.superAdmin) return { actorId: req.superAdmin._id, actorRole: "super_admin" };
  if (req.admin)     return { actorId: req.admin._id,     actorRole: req.admin.role || "super_admin" };
  return { actorId: null, actorRole: "system" };
}

// ── GET /api/addons/:companyId ─────────────────────────────────────────────────
// List all addons for a company (all statuses), newest first.
const listAddons = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const addons = await CompanyAddon.find({ companyId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, companyId, companyName: company.name, addons });
  } catch (err) {
    console.error("[listAddons]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/addons/:companyId/purchase ───────────────────────────────────────
// Create a PAID addon (e.g. customer purchases extra users).
// Body: { addonType, quantity?, durationMonths?, notes? }
const purchaseAddon = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { addonType, quantity = 1, durationMonths, notes = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!addonType) return res.status(400).json({ success: false, message: "addonType is required" });

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const startDate  = new Date();
    let   expiryDate = null;
    if (durationMonths) {
      expiryDate = new Date(startDate);
      expiryDate.setMonth(expiryDate.getMonth() + parseInt(durationMonths, 10));
    }

    const addon = await CompanyAddon.create({
      companyId,
      addonType,
      quantity:      Math.max(1, parseInt(quantity, 10)),
      startDate,
      expiryDate,
      status:        "active",
      paymentStatus: "paid",
      createdBy:     actorId,
      createdByModel: actorRole === "developer" ? "Developer" : "Admin",
      notes,
    });

    await logAudit({
      companyId,
      actorId,
      actorRole,
      action:   "addon_purchased",
      field:    "addonType",
      newValue: addonType,
      reason:   notes || `Paid addon: ${addonType} × ${quantity}`,
    });

    res.status(201).json({ success: true, addon });
  } catch (err) {
    console.error("[purchaseAddon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/addons/:companyId/grant ─────────────────────────────────────────
// Create an addon granted by developer/superadmin (free or custom-priced).
// Body: { addonType, quantity?, durationMonths?, notes?, price?, currency? }
const grantAddon = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { addonType, quantity = 1, durationMonths, notes = "", price = 0, currency = "INR" } = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!addonType) return res.status(400).json({ success: false, message: "addonType is required" });

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const startDate  = new Date();
    let   expiryDate = null;
    if (durationMonths) {
      expiryDate = new Date(startDate);
      expiryDate.setMonth(expiryDate.getMonth() + parseInt(durationMonths, 10));
    }

    const numericPrice = Math.max(0, parseFloat(price) || 0);

    const addon = await CompanyAddon.create({
      companyId,
      addonType,
      quantity:       Math.max(1, parseInt(quantity, 10)),
      startDate,
      expiryDate,
      status:         "active",
      paymentStatus:  numericPrice > 0 ? "paid" : "free",
      price:          numericPrice,
      currency:       (currency || "INR").toString().toUpperCase().trim() || "INR",
      createdBy:      actorId,
      createdByModel: actorRole === "developer" ? "Developer" : "Admin",
      notes,
    });

    await logAudit({
      companyId,
      actorId,
      actorRole,
      action:   "addon_granted",
      field:    "addonType",
      newValue: addonType,
      reason:   notes || `Addon granted: ${addonType} × ${quantity}${numericPrice > 0 ? ` @ ${currency} ${numericPrice}` : " (free)"}`,
    });

    res.status(201).json({ success: true, addon });
  } catch (err) {
    console.error("[grantAddon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/addons/:addonId/renew ────────────────────────────────────────────
// Extend the expiry of an existing addon.
// Body: { durationMonths, reason? }
const renewAddon = async (req, res) => {
  try {
    const { addonId } = req.params;
    const { durationMonths, reason = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!durationMonths || parseInt(durationMonths, 10) < 1) {
      return res.status(400).json({ success: false, message: "durationMonths must be >= 1" });
    }

    const addon = await CompanyAddon.findById(addonId);
    if (!addon) return res.status(404).json({ success: false, message: "Addon not found" });

    const oldExpiry = addon.expiryDate;

    // Extend from current expiry (or now if already expired/null)
    const base = addon.expiryDate && addon.expiryDate > new Date()
      ? new Date(addon.expiryDate)
      : new Date();
    base.setMonth(base.getMonth() + parseInt(durationMonths, 10));

    addon.expiryDate = base;
    addon.status     = "active";
    await addon.save();

    await logAudit({
      companyId: addon.companyId,
      actorId,
      actorRole,
      action:   "addon_renewed",
      field:    "expiryDate",
      oldValue: oldExpiry,
      newValue: addon.expiryDate,
      reason:   reason || `Renewed by ${durationMonths} month(s)`,
    });

    res.json({ success: true, addon });
  } catch (err) {
    console.error("[renewAddon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/addons/:addonId/disable ─────────────────────────────────────────
// Mark addon as disabled (soft delete — record is kept for audit purposes).
// Body: { reason? }
const disableAddon = async (req, res) => {
  try {
    const { addonId } = req.params;
    const { reason = "" } = req.body;
    const { actorId, actorRole } = getActor(req);

    const addon = await CompanyAddon.findById(addonId);
    if (!addon) return res.status(404).json({ success: false, message: "Addon not found" });

    const oldStatus = addon.status;
    addon.status = "disabled";
    await addon.save();

    await logAudit({
      companyId: addon.companyId,
      actorId,
      actorRole,
      action:   "addon_disabled",
      field:    "status",
      oldValue: oldStatus,
      newValue: "disabled",
      reason:   reason || "Manually disabled",
    });

    res.json({ success: true, addon });
  } catch (err) {
    console.error("[disableAddon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  listAddons,
  purchaseAddon,
  grantAddon,
  renewAddon,
  disableAddon,
};
