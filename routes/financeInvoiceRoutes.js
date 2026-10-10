// routes/financeInvoiceRoutes.js — NEW FILE
// Finance Panel invoice API. Mounted twice in server.js:
//   /api/finance-panel                              → finance users + super admin (panel)
//   /api/developer/companies/:companyId/finance     → developer, for one company
// Auth, company-active and module-enabled checks all live in
// protectFinanceOrDeveloper (developers bypass only the module switch).
"use strict";

const express = require("express");
const router  = express.Router({ mergeParams: true });
const { protectFinanceOrDeveloper } = require("../middlewares/financeAuthMiddleware");
const c = require("../controllers/financeController");

router.use(protectFinanceOrDeveloper);

router.get ("/settings",  c.getSettings);
router.put ("/settings",  c.updateSettings);
router.get ("/assignees", c.listAssignees);

router.get ("/",    c.listInvoices);
router.post("/",    c.createInvoice);
router.get ("/:id", c.getInvoice);
router.put ("/:id", c.updateInvoice);

router.post  ("/:id/payments",            c.addPayment);
router.put   ("/:id/payments/:paymentId", c.updatePayment);
router.delete("/:id/payments/:paymentId", c.deletePayment);

router.put ("/:id/followup", c.setFollowUp);
router.post("/:id/remarks",  c.addRemark);
router.post("/:id/cancel",   c.cancelInvoice);
router.post("/:id/reopen",   c.reopenInvoice);

module.exports = router;
