// routes/benefitRoute.js — NEW FILE
// Benefit management endpoints — requires developer or super_admin token.

const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");

const Developer  = require("../models/Developer");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");

const {
  listBenefits,
  grantBenefit,
  extendBenefit,
  deactivateBenefit,
} = require("../controllers/benefitController");

// ── Middleware: allow either developer OR super_admin ─────────────────────────
const protectPrivileged = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  try {
    const token   = req.headers.authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const role    = decoded.role === "superadmin" ? "super_admin" : decoded.role;

    if (role === "developer") {
      const dev = await Developer.findById(decoded.id).select("-password");
      if (!dev) return res.status(401).json({ success: false, message: "Developer not found" });
      req.developer = dev;
      return next();
    }

    if (role === "super_admin") {
      const adminDoc = await Admin.findById(decoded.id).select("-password");
      if (adminDoc && adminDoc.role === "super_admin") {
        req.superAdmin = adminDoc;
        return next();
      }
      const legacy = await SuperAdmin.findById(decoded.id).select("-password");
      if (legacy) { req.superAdmin = legacy; return next(); }
      return res.status(401).json({ success: false, message: "Not authorized as super_admin" });
    }

    return res.status(403).json({ success: false, message: "Access denied. Requires developer or super_admin." });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Not authorized, invalid token" });
  }
};

// ── Routes ────────────────────────────────────────────────────────────────────

// List all benefits for a company
router.get("/:companyId", protectPrivileged, listBenefits);

// Grant a new benefit
router.post("/:companyId/grant", protectPrivileged, grantBenefit);

// Extend validUntil of a benefit
router.put("/:benefitId/extend", protectPrivileged, extendBenefit);

// Deactivate (soft-delete) a benefit
router.delete("/:benefitId", protectPrivileged, deactivateBenefit);

module.exports = router;
