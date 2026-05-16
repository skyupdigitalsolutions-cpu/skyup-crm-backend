// middlewares/adminAuthMiddleware.js
const jwt        = require("jsonwebtoken");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");
const Company    = require("../models/Company");
const { isTokenBlacklisted } = require("./rateLimiter");

const protectAdmin = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];

      // ── Blacklist check (logout / revocation) ───────────────────────────────
      if (await isTokenBlacklisted(token)) {
        return res.status(401).json({ message: "Token has been invalidated. Please log in again." });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ── SuperAdmin acting as Admin ──────────────────────────────────────────
      // A superadmin has no company of its own, so every admin-protected page
      // (Leads, Campaigns, Communications, Attendance, etc.) used to return
      // 403 and render blank. Here we accept the superadmin token and build a
      // synthetic admin context scoped to one company, so every existing admin
      // controller (which reads req.admin.company / req.admin._id) works
      // unchanged — i.e. all admin pages now work for superadmin too.
      if (decoded.role === "superadmin") {
        const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
        if (!superAdmin) {
          return res.status(401).json({ message: "Not authorized as superadmin" });
        }

        // Which company is the superadmin operating on?
        // Priority: explicit "x-company-id" header (future company switcher)
        //           → first active company → first company overall.
        const headerCompanyId = req.headers["x-company-id"];
        let company = null;
        if (headerCompanyId) {
          company = await Company.findById(headerCompanyId).catch(() => null);
        }
        if (!company) {
          company = await Company.findOne({ isActive: true }).sort({ createdAt: 1 });
        }
        if (!company) {
          company = await Company.findOne().sort({ createdAt: 1 });
        }
        if (!company) {
          return res.status(404).json({ message: "No company found for superadmin to manage" });
        }

        req.superAdmin = superAdmin;

        // Synthetic admin object — controllers read company as
        // `req.admin.company._id || req.admin.company`, so a populated
        // Company document keeps every downstream query working.
        req.admin = {
          _id:          superAdmin._id,
          name:         superAdmin.name,
          email:        superAdmin.email,
          role:         "superadmin",
          company,
          isSuperAdmin: true,
        };

        req.user = {
          id:        superAdmin._id.toString(),
          userId:    superAdmin._id.toString(),
          companyId: company._id.toString(),
          role:      "admin", // behave exactly like an admin downstream
          name:      superAdmin.name,
        };

        return next();
      }

      // Reject if token was issued for a different (non-admin) role
      if (decoded.role && decoded.role !== "admin") {
        return res.status(403).json({ message: "Access denied: not an admin token" });
      }

      req.admin = await Admin.findById(decoded.id)
        .select("-password")
        .populate("company");

      if (!req.admin) {
        return res.status(401).json({ message: "Admin not found" });
      }

      if (!req.admin.company || !req.admin.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
      }

      // ── Also set req.user so WhatsApp (and other) controllers can read it ───
      req.user = {
        id:        req.admin._id.toString(),
        userId:    req.admin._id.toString(),
        companyId: req.admin.company._id.toString(),
        role:      "admin",
        name:      req.admin.name,
      };

      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

module.exports = { protectAdmin };
