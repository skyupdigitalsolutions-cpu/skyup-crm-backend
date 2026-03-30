const jwt = require("jsonwebtoken");

// role: "user" | "admin" | "superadmin"
const generateToken = (id, role = "user") => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: "24h",
  });
};

module.exports = generateToken;