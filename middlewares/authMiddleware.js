// middlewares/authMiddleware.js — UPDATED (added protectUnified + authorizeRoles; existing code unchanged)
const jwt        = require("jsonwebtoken");
const User       = require("../models/Users");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");
const Developer  = require("../models/Developer");
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

      if (decoded.role && decoded.role !== "user" && decoded.role !== "employee") {
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

      if (decoded.role === "super_admin" || decoded.role === "superadmin") {
        // super_admin acting as admin — resolve a company context so dual-role
        // controllers (WhatsApp, call logs, etc.) work like they do for admin.
        const superAdmin = await SuperAdmin.findById(decoded.id).select("-password")
          || await Admin.findById(decoded.id).select("-password").populate("company");

        if (!superAdmin) return res.status(401).json({ message: "Not authorized as super_admin" });

        // For Admin model super_admin, company is already populated
        if (superAdmin.company) {
          req.admin = superAdmin;
          req.callerCompany = superAdmin.company?._id || superAdmin.company;
          return next();
        }

        const headerCompanyId = req.headers["x-company-id"];
        let company = null;
        if (headerCompanyId) {
          company = await Company.findById(headerCompanyId).catch(() => null);
        }
        if (!company) company = await Company.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (!company) company = await Company.findOne().sort({ createdAt: 1 });
        if (!company) return res.status(404).json({ message: "No company found for super_admin to manage" });

        req.superAdmin = superAdmin;
        req.admin = {
          _id:          superAdmin._id,
          name:         superAdmin.name,
          email:        superAdmin.email,
          role:         "super_admin",
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

// ── NEW: Unified JWT middleware — handles all 4 roles ─────────────────────────
const protectUnified = async (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer"))
    return res.status(401).json({ message: "Not authorized, no token" });

  try {
    const token = req.headers.authorization.split(" ")[1];

    if (await isTokenBlacklisted(token))
      return res.status(401).json({ message: "Token invalidated. Please log in again." });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Normalise legacy "superadmin" -> "super_admin" so all role checks are consistent
    const normalizedRole = decoded.role === "superadmin" ? "super_admin" : decoded.role;

    if (normalizedRole === "developer") {
      req.user = await Developer.findById(decoded.id).select("-password");
    } else if (["super_admin", "admin"].includes(normalizedRole)) {
      req.user = await Admin.findById(decoded.id).select("-password").populate("company");
      // Fall back to legacy SuperAdmin collection if not found in Admin model
      if (!req.user) {
        const legacySuperAdmin = await SuperAdmin.findById(decoded.id).select("-password");
        if (legacySuperAdmin) {
          // Always force role to "super_admin" regardless of what the model stores
          req.user = { ...legacySuperAdmin.toObject(), role: "super_admin" };
        }
      }
    } else {
      // employee / user
      req.user = await User.findById(decoded.id).select("-password");
    }

    // Ensure role is always normalised on req.user (covers Admin model docs with old role string)
    if (req.user && req.user.role === "superadmin") {
      const obj = typeof req.user.toObject === "function" ? req.user.toObject() : { ...req.user };
      req.user = { ...obj, role: "super_admin" };
    }

    if (!req.user) return res.status(401).json({ message: "Not authorized" });
    next();
  } catch {
    return res.status(401).json({ message: "Not authorized, invalid token" });
  }
};

// ── NEW: Role gate — use after protectUnified ─────────────────────────────────
const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      message: `Access denied. Required: ${roles.join(", ")}`,
    });
  }
  next();
};

module.exports = { protect, protectAny, protectUnified, authorizeRoles };
