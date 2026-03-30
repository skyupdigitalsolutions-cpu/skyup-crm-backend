const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");

const protectAdmin = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Reject if token was issued for a different role
      if (decoded.role && decoded.role !== "admin") {
        return res.status(403).json({ message: "Access denied: not an admin token" });
      }

      req.admin = await Admin.findById(decoded.id)
        .select("-password")
        .populate("company");

      if (!req.admin) {
        return res.status(401).json({ message: "Admin not found" });
      }

      if (!req.admin.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
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

module.exports = { protectAdmin };