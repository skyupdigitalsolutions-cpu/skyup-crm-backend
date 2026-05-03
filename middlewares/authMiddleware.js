// middlewares/authMiddleware.js
const jwt   = require("jsonwebtoken");
const User  = require("../models/Users");
const Admin = require("../models/Admin");

// ── User-only middleware ───────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
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
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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