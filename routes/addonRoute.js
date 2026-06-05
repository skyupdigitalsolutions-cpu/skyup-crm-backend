// routes/addonRoute.js — NEW FILE
// Addon management endpoints — requires developer or super_admin token.
// Uses the same protectPrivileged middleware pattern as subscriptionRoute.js.

const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");

const Developer  = require("../models/Developer");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");

const {
  listAddons,
  purchaseAddon,
  grantAddon,
  renewAddon,
  disableAddon,
} = require("../controllers/addonController");

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

// ── Routes ─────────────────────────────────────────────────────────────────────
// All routes require privileged auth

// List all addons for a company
router.get("/:companyId", protectPrivileged, listAddons);

// Purchase a paid addon
router.post("/:companyId/purchase", protectPrivileged, purchaseAddon);

// Grant a free addon (developer/superadmin only)
router.post("/:companyId/grant", protectPrivileged, grantAddon);

// Renew (extend expiry) an addon
router.put("/:addonId/renew", protectPrivileged, renewAddon);

// Disable (soft-delete) an addon
router.put("/:addonId/disable", protectPrivileged, disableAddon);

module.exports = router;
