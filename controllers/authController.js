const User = require("../models/Users");
const Company = require("../models/Company");
const generateToken = require("../utils/generateToken");

// Register
const register = async (req, res) => {
  try {
    const { name, email, password, companyId } = req.body;

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }
    if (!company.isActive) {
      return res.status(403).json({ message: "Company is not active" });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = await User.create({
      name,
      email,
      password,
      company: companyId,
      role: "user",           // ✅ fixed
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      company: user.company,
      role: user.role,        // ✅ added
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate("company");
    if (user && (await user.matchPassword(password))) {

      if (!user.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
      }

      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        company: user.company._id,
        role: user.role,      // ✅ added
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { register, login };