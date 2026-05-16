// middlewares/authMiddleware.js
const jwt        = require("jsonwebtoken");
const User       = require("../models/Users");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");
const Company    = require("../models/Company");
const { isTokenBlacklisted } = require("./rateLimiter");

// ── User-only middleware ───────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];

      // ── Blacklist check (logout / revocation) ───────────────────────────────
      if (await isTokenBlacklisted(token)) {
        return res.status(401).json({ message: "Token has been invalidated. Please log in again." });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role && decoded.role !== "user") {
        return res.status(403).json({ message: "Access denied: not a user token" });
      }

      req.user = await User.findById(decoded.id).select("-password");
      if (!req.user) {
        return res.status(401).json({ message: "User not found" });
      }

      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

// ── Dual middleware — accepts BOTH admin and user tokens ───────────────────────
// Sets req.user  + req.callerCompany when called by a regular user
// Sets req.admin + req.callerCompany when called by an admin
// Controllers use req.callerCompany so they work for both roles.
const protectAny = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];

      // ── Blacklist check ─────────────────────────────────────────────────────
      if (await isTokenBlacklisted(token)) {
        return res.status(401).json({ message: "Token has been invalidated. Please log in again." });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role === "superadmin") {
        // SuperAdmin acting as admin — resolve a company context so dual-role
        // controllers (WhatsApp, call logs, etc.) work like they do for admin.
        const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
        if (!superAdmin) return res.status(401).json({ message: "Not authorized as superadmin" });

        const headerCompanyId = req.headers["x-company-id"];
        let company = null;
        if (headerCompanyId) {
          company = await Company.findById(headerCompanyId).catch(() => null);
        }
        if (!company) company = await Company.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (!company) company = await Company.findOne().sort({ createdAt: 1 });
        if (!company) return res.status(404).json({ message: "No company found for superadmin to manage" });

        req.superAdmin = superAdmin;
        req.admin = {
          _id:          superAdmin._id,
          name:         superAdmin.name,
          email:        superAdmin.email,
          role:         "superadmin",
          company,
          isSuperAdmin: true,
        };
        req.callerCompany = company._id;
        return next();
      }

      if (decoded.role === "admin") {
        req.admin = await Admin.findById(decoded.id)
          .select("-password")
          .populate("company");
        if (!req.admin) return res.status(401).json({ message: "Admin not found" });
        req.callerCompany = req.admin.company?._id || req.admin.company;
      } else {
        req.user = await User.findById(decoded.id).select("-password");
        if (!req.user) return res.status(401).json({ message: "User not found" });
        req.callerCompany = req.user.company;
      }

      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

module.exports = { protect, protectAny };
