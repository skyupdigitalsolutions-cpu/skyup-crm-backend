
const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");

// Plan limits — single source of truth on the backend
// Must match UpgradePlan.jsx and UserManagement.jsx
const PLAN_LIMITS = {
  basic:      { maxAdmins: 1,  maxUsers: 10  },  // = starter
  pro:        { maxAdmins: 3,  maxUsers: 30  },  // = growth
  enterprise: { maxAdmins: 5,  maxUsers: 50  },
};

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.basic;
}

// Get logged-in admin's company info
const getMyCompany = async (req, res) => {
  try {
    res.status(200).json({
      _id:      req.admin.company._id,
      name:     req.admin.company.name,
      email:    req.admin.company.email,
      plan:     req.admin.company.plan,
      isActive: req.admin.company.isActive,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all admins in same company
const getAdmins = async (req, res) => {
  try {
    const admins = await Admin.find({ company: req.admin.company._id }).select("-password");
    res.status(200).json(admins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get single admin
const getAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id }).select("-password");
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    res.status(200).json(admin);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FIX: Create admin — enforce plan limit before creating
const createAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const companyId = req.admin.company._id;

    // FIX: Check plan limit server-side
    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const limits = getPlanLimits(company.plan);
    const existingAdminCount = await Admin.countDocuments({ company: companyId });

    if (existingAdminCount >= limits.maxAdmins) {
      return res.status(403).json({
        message: `Your ${company.plan} plan allows a maximum of ${limits.maxAdmins} admin${limits.maxAdmins > 1 ? "s" : ""}. Please upgrade your plan to add more.`,
        limitReached: true,
        plan: company.plan,
        maxAdmins: limits.maxAdmins,
      });
    }

    const adminExists = await Admin.findOne({ email });
    if (adminExists) return res.status(400).json({ message: "Admin already exists" });

    const admin = await Admin.create({ name, email, password, company: companyId });

    res.status(201).json({
      _id:     admin._id,
      name:    admin.name,
      email:   admin.email,
      company: admin.company,
      role:    "admin",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete admin
const deleteAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!admin) return res.status(404).json({ message: "Admin Not Found" });
    await Admin.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Admin deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update admin
const updateAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!admin) return res.status(404).json({ message: "Admin Not Found" });
    const updated = await Admin.findByIdAndUpdate(req.params.id, req.body, { new: true }).select("-password");
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all users in same company
const getCompanyUsers = async (req, res) => {
  try {
    const users = await User.find({ company: req.admin.company._id }).select("-password");
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all leads in same company
const getCompanyLeads = async (req, res) => {
  try {
    const leads = await Lead.find({ company: req.admin.company._id }).populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FIX: Delete user — with company check
const deleteCompanyUser = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getMyCompany,
  getAdmin,
  getAdmins,
  createAdmin,
  deleteAdmin,
  updateAdmin,
  getCompanyUsers,
  getCompanyLeads,
  deleteCompanyUser,
};
