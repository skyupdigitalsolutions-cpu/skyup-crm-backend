// middlewares/adminAuthMiddleware.js — UPDATED ("superadmin" → "super_admin" in role checks)
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

      // ── super_admin acting as Admin ─────────────────────────────────────────
      // UPDATED: role check uses "super_admin" (was "superadmin")
      if (decoded.role === "super_admin") {
        // First try to find as a proper Admin document (new multi-tenant model)
        const adminDoc = await Admin.findById(decoded.id).select("-password").populate("company");
        if (adminDoc) {
          req.admin = adminDoc;
          req.user = {
            id:        adminDoc._id.toString(),
            userId:    adminDoc._id.toString(),
            companyId: adminDoc.company?._id?.toString() || adminDoc.company?.toString(),
            role:      "super_admin",
            name:      adminDoc.name,
          };
          return next();
        }

        // Fallback: legacy SuperAdmin document
        const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
        if (!superAdmin) {
          return res.status(401).json({ message: "Not authorized as super_admin" });
        }

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
          return res.status(404).json({ message: "No company found for super_admin to manage" });
        }

        req.superAdmin = superAdmin;
        req.admin = {
          _id:          superAdmin._id,
          name:         superAdmin.name,
          email:        superAdmin.email,
          role:         "super_admin",
          company,
          isSuperAdmin: true,
        };
        req.user = {
          id:        superAdmin._id.toString(),
          userId:    superAdmin._id.toString(),
          companyId: company._id.toString(),
          role:      "admin",
          name:      superAdmin.name,
        };

        return next();
      }

      // UPDATED: reject non-admin roles (now excludes both "admin" and "super_admin")
      if (decoded.role && !["admin", "super_admin"].includes(decoded.role)) {
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

      req.user = {
        id:        req.admin._id.toString(),
        userId:    req.admin._id.toString(),
        companyId: req.admin.company._id.toString(),
        role:      req.admin.role,
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

// ── Company-super_admin gate ──────────────────────────────────────────────────
// Run AFTER protectAdmin. Passes only if caller is the company's super_admin.
// UPDATED: role check uses "super_admin" (was "superadmin")
const requireCompanySuperAdmin = (req, res, next) => {
  if (req.admin && req.admin.role === "super_admin") {
    return next();
  }
  return res.status(403).json({
    message: "Access denied: only the company super_admin can perform this action",
  });
};

module.exports = { protectAdmin, requireCompanySuperAdmin };