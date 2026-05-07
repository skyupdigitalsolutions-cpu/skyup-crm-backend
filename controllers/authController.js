const User = require("../models/Users");
const Company = require("../models/Company");
const generateToken = require("../utils/generateToken");

// Register
const register = async (req, res) => {
  try {
    const { name, email, password, companyId } = req.body;

    // 1️⃣ Fetch company FIRST
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }
    if (!company.isActive) {
      return res.status(403).json({ message: "Company is not active" });
    }

    // 2️⃣ NOW you can safely use company.plan
    const PLAN_USER_LIMITS = { basic: 10, pro: 30, enterprise: 50 };
    const userLimit = PLAN_USER_LIMITS[company.plan] || 10;
    const existingUserCount = await User.countDocuments({ company: companyId });

    if (existingUserCount >= userLimit) {
      return res.status(403).json({
        message: `Your ${company.plan} plan allows a maximum of ${userLimit} users. Please upgrade your plan to add more.`,
        limitReached: true,
        plan: company.plan,
        maxUsers: userLimit,
      });
    }

    // 3️⃣ Rest continues unchanged...
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = await User.create({
      name, email, password,
      company: companyId,
      role: "user",
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      company: user.company,
      role: user.role,
      token: generateToken(user._id, "user"),
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Login
const DEVICE_FIELDS = [
  "appName",
  "appVersion",
  "platform",
  "deviceModel",
  "osVersion",
  "fcmToken",
];

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate("company");
    if (user && (await user.matchPassword(password))) {
      if (!user.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
      }

      // ── Capture device / app info if the mobile app sent it ────────────────
      const deviceUpdate = {};
      DEVICE_FIELDS.forEach((f) => {
        if (req.body[f] !== undefined && req.body[f] !== null) {
          deviceUpdate[f] = req.body[f];
        }
      });
      if (Object.keys(deviceUpdate).length > 0) {
        await User.findByIdAndUpdate(user._id, { $set: deviceUpdate });
      }

      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        company: user.company._id,
        role: user.role,
        token: generateToken(user._id, "user"),
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { register, login };
