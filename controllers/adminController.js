const Admin = require("../models/Admin");
const User = require("../models/Users");
const Lead = require("../models/Leads");
const generateToken = require("../utils/generateToken");

// Get logged-in admin's company info (plan, etc.)
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

// Get all admins in same company only
const getAdmins = async (req, res) => {
  try {
    const admins = await Admin.find({ company: req.admin.company._id })
      .select("-password");
    res.status(200).json(admins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get single admin — company check
const getAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await Admin.findOne({ _id: id, company: req.admin.company._id })
      .select("-password");
    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }
    res.status(200).json(admin);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create admin — auto attach company from logged-in admin
const createAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const adminExists = await Admin.findOne({ email });
    if (adminExists) {
      return res.status(400).json({ message: "Admin already exists" });
    }

    const admin = await Admin.create({
      name,
      email,
      password,
      company: req.admin.company._id,
    });

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

// Delete admin — company check
const deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await Admin.findOne({ _id: id, company: req.admin.company._id });
    if (!admin) {
      return res.status(404).json({ message: "Admin Not Found" });
    }
    await Admin.findByIdAndDelete(id);
    return res.status(200).json({ message: "Admin deleted Successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update admin — company check
const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await Admin.findOne({ _id: id, company: req.admin.company._id });
    if (!admin) {
      return res.status(404).json({ message: "Admin Not Found!.." });
    }
    const updatedAdmin = await Admin.findByIdAndUpdate(id, req.body, { new: true })
      .select("-password");
    return res.status(200).json(updatedAdmin);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all users in same company
const getCompanyUsers = async (req, res) => {
  try {
    const users = await User.find({ company: req.admin.company._id })
      .select("-password");
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all leads in same company
const getCompanyLeads = async (req, res) => {
  try {
    const leads = await Lead.find({ company: req.admin.company._id })
      .populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete a user (agent) — company check to prevent cross-company deletes
const deleteCompanyUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ _id: id, company: req.admin.company._id });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    await User.findByIdAndDelete(id);
    return res.status(200).json({ message: "User deleted successfully" });
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