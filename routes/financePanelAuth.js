// routes/financePanelAuth.js — NEW FILE
// Sign-in for the standalone Finance Panel. Mounted at /api/finance-panel.
//   POST /login   email + password → JWT (same shape as the CRM login)
//   GET  /me      who am I (used to verify a session)
"use strict";

const express = require("express");
const router  = express.Router();
const Admin   = require("../models/Admin");
const generateToken = require("../utils/generateToken");
const { logAuditEvent } = require("../utils/auditLogger");
const { authLimiter, ipFloodLimiter } = require("../middlewares/rateLimiter");
const { protectFinance, hasFinanceAccess, companyBlockReason } = require("../middlewares/financeAuthMiddleware");

function audit(req, admin, action, status, reason) {
  try {
    logAuditEvent({
      action, resourceType: "Auth", req,
      actorId: admin._id, actorModel: "Admin", actorEmail: admin.email,
      actorRole: admin.role, company: admin.company && admin.company._id, statusCode: status,
      metadata: Object.assign({ panel: "finance" }, reason ? { reason } : {}),
    });
  } catch (e) { /* auditing must never break sign-in */ }
}

router.post("/login", ipFloodLimiter, authLimiter, async (req, res) => {
  try {
    const email    = String((req.body && req.body.email) || "").toLowerCase().trim();
    const password = (req.body && req.body.password) || "";
    if (!email || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const admin = await Admin.findOne({ email }).populate("company");
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (!hasFinanceAccess(admin)) {
      audit(req, admin, "login_failed", 403, "finance_access_not_granted");
      return res.status(403).json({ message: "Finance panel access not granted. Contact your super admin." });
    }
    const blocked = await companyBlockReason(admin.company);
    if (blocked) {
      audit(req, admin, "login_failed", 403, "company_blocked");
      return res.status(403).json({ message: blocked });
    }

    audit(req, admin, "login", 200);
    return res.json({
      _id: admin._id, name: admin.name, email: admin.email, role: admin.role,
      companyId: admin.company._id, companyName: admin.company.name,
      logoUrl: admin.company.brandLogoUrl || "",
      token: generateToken(admin._id, admin.role),
    });
  } catch (err) {
    res.status(500).json({ message: "Sign-in failed. Please try again." });
  }
});

router.get("/me", protectFinance, (req, res) => {
  const a = req.admin, c = a.company || {};
  res.json({ _id: a._id, name: a.name, email: a.email, role: a.role, companyId: c._id || null, companyName: c.name || "", logoUrl: c.brandLogoUrl || "" });
});

module.exports = router;
