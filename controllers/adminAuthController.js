// controllers/adminAuthController.js
const Admin = require("../models/Admin");
const Company = require("../models/Company");
const generateToken = require("../utils/generateToken");

// Register Admin
const registerAdmin = async (req, res) => {
  try {
    const { name, email, password, companyId } = req.body;

    // Check company exists
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    // Check company is active
    if (!company.isActive) {
      return res.status(403).json({ message: "Company is not active" });
    }

    const adminExists = await Admin.findOne({ email });
    if (adminExists) {
      return res.status(400).json({ message: "Admin already exists" });
    }

    const admin = await Admin.create({
      name,
      email,
      password,
      company: companyId,
    });

    res.status(201).json({
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      company: admin.company,
      token: generateToken(admin._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login Admin
const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email }).populate("company");
    if (admin && (await admin.matchPassword(password))) {

      // Check company is active
      if (!admin.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
      }

      res.status(200).json({
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        company: admin.company._id,
        token: generateToken(admin._id),
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { registerAdmin, loginAdmin };