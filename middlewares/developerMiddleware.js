// middlewares/developerMiddleware.js
const jwt       = require("jsonwebtoken");
const Developer = require("../models/Developer");

const protectDeveloper = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role && decoded.role !== "developer") {
        return res.status(403).json({ message: "Access denied: not a developer token" });
      }

      const developer = await Developer.findById(decoded.id).select("-password");
      if (!developer) {
        return res.status(401).json({ message: "Not authorized as developer" });
      }

      req.developer = developer;
      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

module.exports = { protectDeveloper };
