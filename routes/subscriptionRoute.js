// routes/subscriptionRoute.js — UPDATED
// Added:
//   GET  /my/entitlements          → getMyEntitlements  (full entitlements for calling company)
//   PUT  /override/:companyId      → applyDevOverride   (dev override via subscription route)
//   GET  /full/:companyId          → getCompanyFullDetails
// All existing routes are UNCHANGED.

const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");

const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");
const Developer  = require("../models/Developer");

const {
  getPlans,
  getAllSubscriptions,
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getCompanySubscription,
  updatePlanFeatures,
  getMySubscriptionStatus,
  getMyEntitlements,
  applyDevOverride,
  getCompanyFullDetails,
} = require("../controllers/subscriptionController");

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectAny } = require("../middlewares/authMiddleware");

// ── Middleware: allow either super_admin OR developer ─────────────────────────
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

    return res.status(403).json({
      success: false,
      message: "Access denied. Requires super_admin or developer role.",
    });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Not authorized, invalid token" });
  }
};

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/plans", getPlans);

// ── Admin / super_admin — own subscription ────────────────────────────────────
// Backward-compat: returns combined status + entitlements + resolvedFeatures
router.get("/my/status",       protectAdmin, getMySubscriptionStatus);

// NEW: Full entitlements object for the calling company (used by usePlanFeatures hook).
// protectAny → serves admins, company super-admins AND employees (so employee
// screens like the WhatsApp blast tab can gate themselves client-side).
router.get("/my/entitlements", protectAny, getMyEntitlements);

// ── Privileged (super_admin or developer) ─────────────────────────────────────
router.get("/all",                       protectPrivileged, getAllSubscriptions);
router.get("/full/:companyId",           protectPrivileged, getCompanyFullDetails);
router.get("/:companyId",                protectPrivileged, getCompanySubscription);
router.post("/activate/:companyId",      protectPrivileged, activateSubscription);
router.post("/cancel/:companyId",        protectPrivileged, cancelSubscription);
router.post("/extend-trial/:companyId",  protectPrivileged, extendTrial);
router.put("/features/:companyId",       protectPrivileged, updatePlanFeatures);
router.put("/override/:companyId",       protectPrivileged, applyDevOverride);

module.exports = router;
