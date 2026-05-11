// controllers/authController.js
const jwt  = require("jsonwebtoken");
const User = require("../models/Users");
const Company = require("../models/Company");
const generateToken = require("../utils/generateToken");
const { blacklistToken } = require("../middlewares/rateLimiter");

// ── Register ───────────────────────────────────────────────────────────────────
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

// ── Login ──────────────────────────────────────────────────────────────────────
const DEVICE_FIELDS = [
  "appName",
  "appVersion",
  "platform",
  "deviceModel",
  "osVersion",
  "fcmToken",
  "ipAddress",   // ✅ FIX: was missing — mobile app sends this but it was never saved
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
      // ✅ Always record last login timestamp so frontend can display it
      deviceUpdate.lastLoginAt = new Date();
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

// ── Logout ─────────────────────────────────────────────────────────────────────
// Blacklists the current JWT in Redis so it cannot be reused even before expiry.
// Frontend should also delete the token from localStorage/AsyncStorage.
const logout = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(400).json({ message: "No token provided" });
    }

    // Decode (without verifying again — already passed protect middleware)
    // to find how many seconds remain until natural expiry.
    const decoded = jwt.decode(token);
    const nowSec  = Math.floor(Date.now() / 1000);
    const ttl     = decoded?.exp ? decoded.exp - nowSec : 24 * 60 * 60;

    if (ttl > 0) {
      await blacklistToken(token, ttl);
    }

    res.json({ success: true, message: "Logged out successfully." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Update Device / IP info (called from mobile after login) ──────────────────
// ✅ FIX: replaces the previous pattern of calling POST /auth/login a second
//         time just to save the IP. This endpoint is lightweight — no password
//         check, no token generation — just a targeted $set on the User doc.
const DEVICE_UPDATE_FIELDS = [
  "ipAddress", "appName", "appVersion", "platform",
  "deviceModel", "osVersion", "fcmToken",
];

const updateDevice = async (req, res) => {
  try {
    const update = {};
    DEVICE_UPDATE_FIELDS.forEach((f) => {
      if (req.body[f] !== undefined && req.body[f] !== null) {
        update[f] = req.body[f];
      }
    });
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No device fields provided." });
    }
    await User.findByIdAndUpdate(req.user._id, { $set: update });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { register, login, logout, updateDevice };