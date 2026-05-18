// controllers/developerController.js — NEW FILE
const Developer     = require("../models/Developer");
const Company       = require("../models/Company");
const Admin         = require("../models/Admin");
const User          = require("../models/Users");
const generateToken = require("../utils/generateToken");

// ── Login ──────────────────────────────────────────────────────────────────────
const developerLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const dev = await Developer.findOne({ email });
    if (!dev || !(await dev.matchPassword(password)))
      return res.status(401).json({ message: "Invalid credentials" });

    res.json({
      _id: dev._id, name: dev.name, email: dev.email,
      role: "developer",
      token: generateToken(dev._id, "developer"),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Dashboard — aggregated counts ONLY, NEVER query Leads/Chats/Messages ──────
const getDeveloperDashboard = async (req, res) => {
  try {
    const [totalCompanies, activeCompanies, totalAdmins, totalUsers] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ isActive: true }),
      Admin.countDocuments(),
      User.countDocuments(),
    ]);
    res.json({ totalCompanies, activeCompanies, totalAdmins, totalUsers });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Create Company ─────────────────────────────────────────────────────────────
const createCompany = async (req, res) => {
  try {
    const { name, email, phone, plan } = req.body;

    const exists = await Company.findOne({ email });
    if (exists)
      return res.status(400).json({ message: "A company with this email already exists" });

    const company = await Company.create({
      name, email, phone, plan,
      createdBy: req.user._id,
    });
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Create super_admin for a company — enforces 1 per company ─────────────────
const createCompanySuperAdmin = async (req, res) => {
  try {
    const { id: companyId } = req.params;
    const { name, email, password } = req.body;

    const company = await Company.findById(companyId);
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    const exists = await Admin.findOne({ company: companyId, role: "super_admin" });
    if (exists)
      return res.status(400).json({ message: "This company already has a super admin" });

    const superAdmin = await Admin.create({
      name, email, password,
      role: "super_admin",
      company: companyId,
    });

    res.status(201).json({
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      role: superAdmin.role,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── List all companies (without sensitive fields) ──────────────────────────────
const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find().select("-brevoApiKey -encryptionKeyHash");
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Toggle company active/suspended ───────────────────────────────────────────
const toggleCompanyStatus = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    company.isActive = !company.isActive;
    await company.save();
    res.json({ isActive: company.isActive });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Subscriptions ──────────────────────────────────────────────────────────────
const getSubscriptions = async (req, res) => {
  try {
    const subs = await Company.find().select(
      "name plan subscriptionStatus subscriptionExpiry maxUsers maxLeads isActive"
    );
    res.json(subs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const allowed = ["plan", "subscriptionStatus", "subscriptionExpiry", "maxUsers", "maxLeads"];
    const update  = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const company = await Company.findByIdAndUpdate(companyId, update, { new: true });
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  developerLogin,
  getDeveloperDashboard,
  createCompany,
  createCompanySuperAdmin,
  getCompanies,
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
};