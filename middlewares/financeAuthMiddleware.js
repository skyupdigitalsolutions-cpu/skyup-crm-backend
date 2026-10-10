// middlewares/financeAuthMiddleware.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Auth guard for the standalone Finance Panel (/finance/login → /finance).
//
// Mirrors the Performance Marketing panel, with one deliberate difference:
// `financeAccess` is a REAL on/off switch. Suspending a finance user in
// User Management actually blocks them.
//
// Who may use the panel (inside an ACTIVE company that has the Finance
// Dashboard switched on by the Developer):
//   • finance_user with financeAccess=true, active — created by the super admin
// Everyone else is refused — including admins and super admins. (A super admin
// only creates / suspends finance logins; they cannot open the panel.)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const jwt     = require("jsonwebtoken");
const Admin   = require("../models/Admin");
const { isTokenBlacklisted } = require("./rateLimiter");

// Finance Dashboard is OFF unless the Developer panel turns it ON for the company.
async function financeEnabled(companyId) {
  try {
    const { getCompanyEntitlements } = require("../services/entitlementService");
    const ent = await getCompanyEntitlements(String((companyId && companyId._id) || companyId));
    return !!ent && ent.financeDashboard === true;
  } catch (e) { return false; }
}

/** Pure check — is this Admin document allowed into the Finance Panel? */
function hasFinanceAccess(admin) {
  if (!admin) return false;
  if (admin.isActive === false) return false;
  return admin.role === "finance_user" && admin.financeAccess === true;
}

/** Shared company-level checks. Returns an error message, or null when fine. */
async function companyBlockReason(company) {
  if (!company || company.isActive === false) return "Company is suspended.";
  if (!(await financeEnabled(company._id))) return "Finance Dashboard is not enabled for your company.";
  return null;
}

const protectFinance = async (req, res, next) => {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
  if (!token) return res.status(401).json({ message: "Not authorised — no token" });

  try {
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ message: "Token revoked. Please log in again." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === "user" || decoded.role === "developer") {
      return res.status(403).json({ message: "Access denied — finance panel login required." });
    }

    const admin = await Admin.findById(decoded.id).populate("company").lean();
    if (!admin) return res.status(401).json({ message: "Account not found." });

    if (!hasFinanceAccess(admin)) {
      return res.status(403).json({ message: "Finance panel access not granted. Contact your super admin." });
    }
    const blocked = await companyBlockReason(admin.company);
    if (blocked) return res.status(403).json({ message: blocked });

    req.admin = admin;
    req.financePanel = true;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token. Please log in again." });
  }
};

// Developers manage a company's finance data from Developer → Company → Finance.
const { protectDeveloper } = require("./developerMiddleware");
const protectFinanceOrDeveloper = (req, res, next) => {
  const token = (req.headers.authorization || "").split(" ")[1] || "";
  if (!token) return res.status(401).json({ message: "Not authorised — no token" });
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.role === "developer") return protectDeveloper(req, res, next);
  } catch (e) { /* fall through */ }
  return protectFinance(req, res, next);
};

module.exports = { protectFinance, protectFinanceOrDeveloper, financeEnabled, hasFinanceAccess, companyBlockReason };
