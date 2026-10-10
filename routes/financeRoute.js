// routes/financeRoute.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Finance Dashboard API. Mounted twice in server.js:
//   /api/finance                                   → admin / super_admin / employee
//   /api/developer/companies/:companyId/finance    → developer, for one company
//
// The module is OFF for every company until the Developer turns it on
// (Developer → Companies → <company> → Features → "Finance Dashboard").
// Developers are not blocked by that switch — they are the ones who flip it.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const jwt     = require("jsonwebtoken");
const router  = express.Router({ mergeParams: true });

const { protect }          = require("../middlewares/authMiddleware");
const { protectAdmin }     = require("../middlewares/adminAuthMiddleware");
const { protectDeveloper } = require("../middlewares/developerMiddleware");
const c = require("../controllers/financeController");

// Admin / super_admin token, or a developer token (routed by its role claim;
// the chosen middleware still fully verifies the token).
const protectAdminOrDeveloper = (req, res, next) => {
  const token = (req.headers.authorization || "").split(" ")[1] || "";
  if (!token) return res.status(401).json({ message: "Not authorized, no token" });
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.role === "developer") return protectDeveloper(req, res, next);
  } catch { /* fall through */ }
  return protectAdmin(req, res, next);
};

// Blocks every non-developer caller whose company doesn't have the module on.
async function requireFinance(req, res, next) {
  try {
    if (req.developer) return next();
    const company =
      (req.admin && ((req.admin.company && req.admin.company._id) || req.admin.company)) ||
      (req.user && (req.user.companyId || (req.user.company && req.user.company._id) || req.user.company));
    if (!company) return res.status(400).json({ success: false, message: "Company context not found" });
    const { getCompanyEntitlements } = require("../services/entitlementService");
    const ent = await getCompanyEntitlements(String(company));
    if (!ent || ent.financeDashboard !== true) {
      return res.status(403).json({
        success: false,
        code: "MODULE_DISABLED",
        message: "Finance Dashboard is not enabled for your company.",
      });
    }
    next();
  } catch (e) {
    return res.status(500).json({ success: false, message: "Could not verify module access." });
  }
}

// ── Employee: only the invoices assigned to them ─────────────────────────────
router.get ("/my/followups",           protect, requireFinance, c.myFollowUps);
router.put ("/my/:id/followup",        protect, requireFinance, c.myFollowUp);
router.post("/my/:id/remarks",         protect, requireFinance, c.myRemark);

// ── Admin / super_admin / developer ──────────────────────────────────────────
const admin = [protectAdminOrDeveloper, requireFinance];

router.get ("/settings",               ...admin, c.getSettings);
router.put ("/settings",               ...admin, c.updateSettings);
router.get ("/assignees",              ...admin, c.listAssignees);

router.get ("/",                       ...admin, c.listInvoices);
router.post("/",                       ...admin, c.createInvoice);
router.get ("/:id",                    ...admin, c.getInvoice);
router.put ("/:id",                    ...admin, c.updateInvoice);

router.post  ("/:id/payments",              ...admin, c.addPayment);
router.put   ("/:id/payments/:paymentId",   ...admin, c.updatePayment);
router.delete("/:id/payments/:paymentId",   ...admin, c.deletePayment);

router.put ("/:id/followup",           ...admin, c.setFollowUp);
router.post("/:id/remarks",            ...admin, c.addRemark);
router.post("/:id/cancel",             ...admin, c.cancelInvoice);
router.post("/:id/reopen",             ...admin, c.reopenInvoice);

module.exports = router;
