// middlewares/superAdminMiddleware.js — UPDATED ("superadmin" → "super_admin")
const jwt = require("jsonwebtoken");
const SuperAdmin = require("../models/SuperAdmin");
const Admin = require("../models/Admin");

const protectSuperAdmin = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // UPDATED: role check uses "super_admin" (was "superadmin")
      if (decoded.role && decoded.role !== "super_admin") {
        return res.status(403).json({ message: "Access denied: not a super_admin token" });
      }

      // Try Admin model first (new multi-tenant super_admin)
      const adminDoc = await Admin.findById(decoded.id).select("-password");
      if (adminDoc && adminDoc.role === "super_admin") {
        req.superAdmin = adminDoc;
        return next();
      }

      // Fallback: legacy SuperAdmin document
      const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
      if (!superAdmin) {
        return res.status(401).json({ message: "Not authorized as super_admin" });
      }

      req.superAdmin = superAdmin;
      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

module.exports = { protectSuperAdmin };