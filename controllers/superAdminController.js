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
      role: "superadmin",
      token: generateToken(superAdmin._id, "superadmin"),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login SuperAdmin
const loginSuperAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const superAdmin = await SuperAdmin.findOne({ email });

    if (superAdmin && (await superAdmin.matchPassword(password))) {
      res.status(200).json({
        _id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        role: superAdmin.role,
        token: generateToken(superAdmin._id, "superadmin"),
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
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

const getDashboardStats = async (req, res) => {
  try {
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

module.exports = {
  registerSuperAdmin,
  loginSuperAdmin,
  createCompany,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
};