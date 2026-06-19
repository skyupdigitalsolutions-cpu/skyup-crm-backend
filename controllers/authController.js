// controllers/authController.js — UPDATED (added loginUnified; all existing functions unchanged)
const jwt  = require("jsonwebtoken");
const User = require("../models/Users");
const Admin = require("../models/Admin");
const Developer = require("../models/Developer");
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
    const userLimit = company.maxUsers || PLAN_USER_LIMITS[company.plan] || 10;
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
      role: "employee",
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      company: user.company,
      role: user.role,
      token: generateToken(user._id, "employee"),
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Login (employee / user only) ──────────────────────────────────────────────
const DEVICE_FIELDS = [
  "appName",
  "appVersion",
  "platform",
  "deviceModel",
  "osVersion",
  "fcmToken",
  "ipAddress",
];

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate("company");
    if (user && (await user.matchPassword(password))) {
      if (!user.company.isActive) {
        return res.status(403).json({ message: "Your company is deactivated" });
      }

      const deviceUpdate = {};
      DEVICE_FIELDS.forEach((f) => {
        if (req.body[f] !== undefined && req.body[f] !== null) {
          deviceUpdate[f] = req.body[f];
        }
      });
      deviceUpdate.lastLoginAt = new Date();
      if (Object.keys(deviceUpdate).length > 0) {
        await User.findByIdAndUpdate(user._id, { $set: deviceUpdate });
      }

      res.json({
        _id:       user._id,
        name:      user.name,
        email:     user.email,
        company:   user.company._id,
        companyId: user.company._id,  // include companyId for chat widget
        createdBy: user.createdBy,    // include createdBy for chat widget
        role:      user.role,
        token:     generateToken(user._id, user.role || "employee"),
      });
    } else {
      // Specific reason so the UI can highlight the right field.
      if (!user) {
        return res.status(401).json({
          message: "No account found with this email.",
          code: "EMAIL_NOT_FOUND",
          field: "email",
        });
      }
      return res.status(401).json({
        message: "Incorrect password. Please try again.",
        code: "WRONG_PASSWORD",
        field: "password",
      });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── NEW: Unified login — single endpoint for all 4 roles ──────────────────────
const loginUnified = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1) Check Developer
    const dev = await Developer.findOne({ email });
    if (dev && (await dev.matchPassword(password))) {
      return res.json({
        _id: dev._id, name: dev.name, email: dev.email,
        role: "developer",
        token: generateToken(dev._id, "developer"),
      });
    }

    // 2) Check Admin — but NEVER allow super_admin through this endpoint
    const admin = await Admin.findOne({ email }).populate("company");
    if (admin && (await admin.matchPassword(password))) {
      // super_admin must always use /superadmin/login (which has OTP verification)
      if (admin.role === "super_admin" || admin.role === "superadmin") {
        return res.status(403).json({
          message: "Super Admin accounts require secure login. Please use the Super Admin login page.",
          redirectTo: "/superadmin/login",
        });
      }
      if (!admin.company?.isActive)
        return res.status(403).json({ message: "Company is suspended" });
      return res.json({
        _id: admin._id, name: admin.name, email: admin.email,
        role: admin.role,
        companyId: admin.company._id,
        companyName: admin.company.name,
        brandLogoUrl: admin.company.brandLogoUrl,
        token: generateToken(admin._id, admin.role),
      });
    }

    // 3) Check Employee
    const user = await User.findOne({ email }).populate("company");
    if (user && (await user.matchPassword(password))) {
      if (user.company && !user.company.isActive)
        return res.status(403).json({ message: "Company is suspended" });

      // Update device info if provided
      const deviceUpdate = { lastLoginAt: new Date() };
      DEVICE_FIELDS.forEach((f) => {
        if (req.body[f] !== undefined && req.body[f] !== null) deviceUpdate[f] = req.body[f];
      });
      await User.findByIdAndUpdate(user._id, { $set: deviceUpdate });

      return res.json({
        _id: user._id, name: user.name, email: user.email,
        role: user.role || "employee",
        companyId: user.company._id,  // always send ObjectId, not the populated object
        createdBy: user.createdBy,   // needed by UserChatWidget to resolve the admin chat thread
        token: generateToken(user._id, user.role || "employee"),
      });
    }

    // No role matched on email+password. Distinguish WHY so the UI can show a
    // specific message instead of a generic "invalid email or password".
    //   • If no account anywhere has this email  → email not found.
    //   • If the email exists but password failed → wrong password.
    // NOTE: this intentionally reveals whether an email is registered (account
    // enumeration). For an internal CRM that's an accepted UX tradeoff; if you
    // want to hide it, revert to a single generic 401 message.
    const emailExists =
      !!dev ||
      !!admin ||
      !!user ||
      !!(await Developer.findOne({ email }).select("_id").lean()) ||
      !!(await Admin.findOne({ email }).select("_id").lean()) ||
      !!(await User.findOne({ email }).select("_id").lean());

    if (!emailExists) {
      return res.status(401).json({
        message: "No account found with this email.",
        code: "EMAIL_NOT_FOUND",
        field: "email",
      });
    }

    return res.status(401).json({
      message: "Incorrect password. Please try again.",
      code: "WRONG_PASSWORD",
      field: "password",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Logout ─────────────────────────────────────────────────────────────────────
const logout = async (req, res) => {
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

    res.json({ success: true, message: "Logged out successfully." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Update Device / IP info (called from mobile after login) ──────────────────
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

// ── PATCH /auth/my-telegram — employee self-updates their Telegram chat ID ────
const updateMyTelegram = async (req, res) => {
  try {
    const userId         = req.user?._id;
    const { telegramChatId } = req.body;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.telegramChatId = telegramChatId ? String(telegramChatId).trim() : null;
    await user.save();

    res.json({ message: 'Telegram chat ID updated.', telegramChatId: user.telegramChatId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { register, login, loginUnified, logout, updateDevice, updateMyTelegram };