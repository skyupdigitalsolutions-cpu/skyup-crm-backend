// controllers/superAdminController.js — UPDATED (added createAdmin, fixed getDashboardStats with companyId filter; all existing functions unchanged)
const SuperAdmin = require("../models/SuperAdmin");
const Company = require("../models/Company");
const Admin = require("../models/Admin");
const User = require("../models/Users");
const Lead = require("../models/Leads");
const generateToken = require("../utils/generateToken");

// ─── Auth ──────────────────────────────────────────

// Register SuperAdmin (run once only!)
const registerSuperAdmin = async (req, res) => {
  try {
    const exists = await SuperAdmin.findOne({});
    if (exists) {
      return res.status(400).json({ message: "SuperAdmin already exists" });
    }

    const { name, email, password } = req.body;
    const superAdmin = await SuperAdmin.create({ name, email, password });

    res.status(201).json({
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      role: "super_admin",
      token: generateToken(superAdmin._id, "super_admin"),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login SuperAdmin (legacy — unified login at /api/auth/login is preferred)
const loginSuperAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Try Admin model first (new super_admin)
    const adminDoc = await Admin.findOne({ email, role: "super_admin" }).populate("company");
    if (adminDoc && (await adminDoc.matchPassword(password))) {
      return res.status(200).json({
        _id: adminDoc._id,
        name: adminDoc.name,
        email: adminDoc.email,
        role: "super_admin",
        companyId: adminDoc.company?._id,
        companyName: adminDoc.company?.name,
        token: generateToken(adminDoc._id, "super_admin"),
      });
    }

    // Fallback: legacy SuperAdmin document
    const superAdmin = await SuperAdmin.findOne({ email });
    if (superAdmin && (await superAdmin.matchPassword(password))) {
      return res.status(200).json({
        _id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        role: superAdmin.role,
        token: generateToken(superAdmin._id, "super_admin"),
      });
    }

    res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Company Management ───────────────────────────

const createCompany = async (req, res) => {
  try {
    const { name, email, phone, plan } = req.body;

    const companyExists = await Company.findOne({ email });
    if (companyExists) {
      return res.status(400).json({ message: "Company already exists" });
    }

    const company = await Company.create({ name, email, phone, plan });
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find({});
    res.status(200).json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const admins = await Admin.find({ company: id }).select("-password");
    const users  = await User.find({ company: id }).select("-password");
    const leads  = await Lead.find({ company: id });

    res.status(200).json({ company, admins, users, leads });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const toggleCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    company.isActive = !company.isActive;
    await company.save();

    res.status(200).json({
      message: `Company ${company.isActive ? "activated" : "deactivated"} successfully`,
      isActive: company.isActive,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    await Admin.deleteMany({ company: id });
    await User.deleteMany({ company: id });
    await Lead.deleteMany({ company: id });
    await Company.findByIdAndDelete(id);

    res.status(200).json({ message: "Company and all its data deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── UPDATED: getDashboardStats now accepts optional companyId (from companyIsolation) ─
const getDashboardStats = async (req, res) => {
  try {
    const companyId = req.companyId; // set by companyIsolation middleware

    if (companyId) {
      // Scoped stats for a specific company's super_admin
      const [users, leads, admins] = await Promise.all([
        User.countDocuments({ company: companyId }),
        Lead.countDocuments({ company: companyId }),
        Admin.countDocuments({ company: companyId, role: "admin" }),
      ]);
      return res.json({ users, leads, admins });
    }

    // Platform-wide stats (legacy, for old SuperAdmin flow)
    const totalCompanies  = await Company.countDocuments();
    const activeCompanies = await Company.countDocuments({ isActive: true });
    const totalAdmins     = await Admin.countDocuments();
    const totalUsers      = await User.countDocuments();
    const totalLeads      = await Lead.countDocuments();

    res.status(200).json({
      totalCompanies,
      activeCompanies,
      totalAdmins,
      totalUsers,
      totalLeads,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── NEW: super_admin creates an admin within their own company ────────────────
const createAdmin = async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const companyId = req.companyId; // from companyIsolation middleware

    if (!companyId)
      return res.status(400).json({ message: "Company context missing" });

    // super_admin cannot create another super_admin
    if (req.body.role === "super_admin")
      return res.status(403).json({ message: "Cannot create another super admin" });

    const existing = await Admin.findOne({ email });
    if (existing)
      return res.status(400).json({ message: "An admin with this email already exists" });

    const admin = await Admin.create({
      name, email, password, department,
      role: "admin",
      company: companyId,
    });

    res.status(201).json({
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      department: admin.department,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  registerSuperAdmin,
  loginSuperAdmin,
  createCompany,
  createAdmin,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
};