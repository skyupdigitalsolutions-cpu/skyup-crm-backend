const jwt = require("jsonwebtoken");
const SuperAdmin = require("../models/SuperAdmin");

const protectSuperAdmin = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
      if (!superAdmin) {
        return res.status(401).json({ message: "Not authorized as superadmin" });
      }

      req.superAdmin = superAdmin; // ✅ Attach superadmin to request
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