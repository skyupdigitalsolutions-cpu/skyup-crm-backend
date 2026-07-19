// middlewares/marketingAuthMiddleware.js
// ─────────────────────────────────────────────────────────────────────────────
// Auth guard for the Performance Marketing Panel.
// Accepts the same JWT issued by /api/auth/login (admin or super_admin role).
// Rejects users with role "user" (employees) — they have no access.
// Beautify-safe: no ?. or ?? operators.
// ─────────────────────────────────────────────────────────────────────────────

const jwt     = require("jsonwebtoken");
const Admin   = require("../models/Admin");
const Company = require("../models/Company");
const { isTokenBlacklisted } = require("./rateLimiter");

const protectMarketing = async (req, res, next) => {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    token = auth.split(" ")[1];
  }
  if (!token) {
    return res.status(401).json({ message: "Not authorised — no token" });
  }

  try {
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ message: "Token revoked. Please log in again." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Employees (role: "user") can never access even with a flag
    if (decoded.role === "user") {
      return res.status(403).json({ message: "Access denied — admin login required." });
    }

    const admin = await Admin.findById(decoded.id).populate("company").lean();
    if (!admin) {
      return res.status(401).json({ message: "Account not found." });
    }

    // Must have marketingAccess: true — set by super admin in Company Details.
    // super_admin always has access; regular admins need the flag set.
    const isSuperAdmin = admin.role === "super_admin" || admin.role === "superadmin";
    if (!isSuperAdmin && !admin.marketingAccess) {
      return res.status(403).json({ message: "Marketing panel access not granted. Contact your super admin." });
    }

    const company = admin.company;
    if (!company || !company.isActive) {
      return res.status(403).json({ message: "Company is suspended." });
    }

    req.admin = admin;
    req.marketingPanel = true;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token. Please log in again." });
  }
};

module.exports = { protectMarketing };
