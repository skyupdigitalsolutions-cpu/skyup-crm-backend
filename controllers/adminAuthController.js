// controllers/adminAuthController.js
const jwt     = require("jsonwebtoken");
const Admin   = require("../models/Admin");
const Company = require("../models/Company");
const generateToken   = require("../utils/generateToken");
const { blacklistToken } = require("../middlewares/rateLimiter");

// ── Register Admin (used when creating a new company) ─────────────────────────
const registerAdmin = async (req, res) => {
  try {
    const { name, email, password, companyId } = req.body;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });
    if (!company.isActive) return res.status(403).json({ message: "Company is not active" });

const adminExists = await Admin.findOne({ email });
    if (adminExists) return res.status(400).json({ message: "Admin already exists" });

    // ── Per-company superadmin ───────────────────────────────────────────────
    // FIRST admin of a company becomes that company's superadmin (full control
    // inside their own company). Every later admin is a normal "admin".
    // This does NOT touch the global platform SuperAdmin (models/SuperAdmin.js).
    const existingCount = await Admin.countDocuments({ company: companyId });
    const role = existingCount === 0 ? "superadmin" : "admin";

    const admin = await Admin.create({ name, email, password, company: companyId, role });

    res.status(201).json({
      _id:     admin._id,
      name:    admin.name,
      email:   admin.email,
      company: admin.company,
      plan:    company.plan,        // FIX: include plan so frontend doesn't need extra fetch
      role:    admin.role,          // CHANGED: real role (superadmin | admin), was hardcoded
      token:   generateToken(admin._id, "admin"), // JWT role stays "admin" on purpose
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Login Admin ────────────────────────────────────────────────────────────────
const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email }).populate("company");
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!admin.company.isActive) {
      return res.status(403).json({ message: "Your company is deactivated" });
    }

res.status(200).json({
      _id:     admin._id,
      name:    admin.name,
      email:   admin.email,
      company: admin.company._id,
      plan:    admin.company.plan,  // FIX: include plan in login response
      role:    admin.role,          // CHANGED: was hardcoded "admin"; now superadmin | admin
      token:   generateToken(admin._id, "admin"), // JWT role stays "admin" so protectAdmin passes
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Logout Admin ───────────────────────────────────────────────────────────────
// Blacklists the current JWT so it cannot be reused even before its expiry.
// Frontend should also clear the token from localStorage / cookies.
const logoutAdmin = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(400).json({ message: "No token provided" });
    }

    const decoded = jwt.decode(token);
    const nowSec  = Math.floor(Date.now() / 1000);
    const ttl     = decoded?.exp ? decoded.exp - nowSec : 24 * 60 * 60;

    if (ttl > 0) {
      await blacklistToken(token, ttl);
    }

    res.json({ success: true, message: "Admin logged out successfully." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { registerAdmin, loginAdmin, logoutAdmin };
