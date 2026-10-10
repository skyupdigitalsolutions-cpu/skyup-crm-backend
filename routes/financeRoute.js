// routes/financeRoute.js — UPDATED
// EMPLOYEE-ONLY endpoints, mounted at /api/finance.
// Employees never get a Finance Panel login; they just see the invoices that
// were assigned to them as payment follow-ups inside the normal CRM and can
// reschedule / leave remarks. Everything else lives in the standalone panel:
//   routes/financePanelAuth.js      (sign-in)
//   routes/financeInvoiceRoutes.js  (invoices, payments, follow-ups)
"use strict";

const express = require("express");
const router  = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const c = require("../controllers/financeController");

// Blocks employees whose company doesn't have the module switched on.
async function requireFinance(req, res, next) {
  try {
    const company = req.user && (req.user.companyId || (req.user.company && req.user.company._id) || req.user.company);
    if (!company) return res.status(400).json({ success: false, message: "Company context not found" });
    const { financeEnabled } = require("../middlewares/financeAuthMiddleware");
    if (!(await financeEnabled(company))) {
      return res.status(403).json({ success: false, code: "MODULE_DISABLED", message: "Finance Dashboard is not enabled for your company." });
    }
    next();
  } catch (e) {
    return res.status(500).json({ success: false, message: "Could not verify module access." });
  }
}

router.get ("/my/followups",    protect, requireFinance, c.myFollowUps);
router.put ("/my/:id/followup", protect, requireFinance, c.myFollowUp);
router.post("/my/:id/remarks",  protect, requireFinance, c.myRemark);

module.exports = router;
