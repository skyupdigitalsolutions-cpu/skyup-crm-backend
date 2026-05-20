const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");

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
    const filter = { company: req.admin.company._id };
    // Only a company superadmin may see superadmin accounts.
    if (req.admin.role !== "super_admin") filter.role = { $ne: "super_admin" };
    const admins = await Admin.find(filter).select("-password");
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
    const existingAdminCount = await Admin.countDocuments({ company: companyId, role: { $ne: "super_admin" } });

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

    // Guard: never delete a company's last superadmin (would lock the company
    // out of all admin-team management).
    if (admin.role === "super_admin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "super_admin",
      });
      if (superCount <= 1) {
        return res.status(400).json({
          message: "Cannot delete the only superadmin. Promote another admin to superadmin first.",
        });
      }
    }

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

    if (req.body.role && !["super_admin", "admin"].includes(req.body.role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    // Guard: don't demote the company's only superadmin.
    if (admin.role === "super_admin" && req.body.role && req.body.role !== "super_admin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "super_admin",
      });
      if (superCount <= 1) {
        return res.status(400).json({
          message: "Cannot demote the only superadmin. Promote another admin first.",
        });
      }
    }

    const updated = await Admin.findByIdAndUpdate(req.params.id, req.body, { new: true }).select("-password");
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Create a user (agent) owned by the calling admin
const createCompanyUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const companyId = req.admin.company._id;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const PLAN_USER_LIMITS = { basic: 10, pro: 30, enterprise: 50 };
    const userLimit = PLAN_USER_LIMITS[company.plan] || 10;
    const existingUserCount = await User.countDocuments({ company: companyId });
    if (existingUserCount >= userLimit) {
      return res.status(403).json({
        message: `Your ${company.plan} plan allows a maximum of ${userLimit} users. Please upgrade your plan to add more.`,
        limitReached: true, plan: company.plan, maxUsers: userLimit,
      });
    }

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: "User already exists" });

    const user = await User.create({
      name, email, password,
      company: companyId,
      role: "user",
      createdBy: req.admin._id,
    });

    res.status(201).json({
      _id: user._id, name: user.name, email: user.email,
      company: user.company, role: user.role,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Get all users in same company
const getCompanyUsers = async (req, res) => {
  try {
    const filter = { company: req.admin.company._id };
    // Superadmin sees all company users; a regular admin sees only their own.
    if (req.admin.role !== "super_admin") filter.createdBy = req.admin._id;
    const users = await User.find(filter).select("-password");
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all leads in same company — paginated
const getCompanyLeads = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
    const skip  = (page - 1) * limit;

    const companyId = req.admin.company._id;
    const [leads, total] = await Promise.all([
      Lead.find({ company: companyId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      Lead.countDocuments({ company: companyId }),
    ]);

    res.status(200).json({ leads, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FIX: Delete user — with company check
const deleteCompanyUser = async (req, res) => {
  try {
   const query = { _id: req.params.id, company: req.admin.company._id };
    if (req.admin.role !== "super_admin") query.createdBy = req.admin._id;
    const user = await User.findOne(query);
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/dashboard-stats ───────────────────────────────────────────
const getDashboardStats = async (req, res) => {
  try {
    const companyId = req.admin.company._id;

    const [
      totalLeads,
      hotLeads,
      warmLeads,
      coldLeads,
      revealAggregate,
    ] = await Promise.all([
      Lead.countDocuments({ company: companyId }),
      Lead.countDocuments({ company: companyId, temperature: "Hot" }),
      Lead.countDocuments({ company: companyId, temperature: "Warm" }),
      Lead.countDocuments({ company: companyId, temperature: "Cold" }),
      Lead.aggregate([
        { $match: { company: companyId } },
        { $group: {
            _id: null,
            totalReveals:   { $sum: "$phoneRevealCount" },
            leadsRevealed:  { $sum: { $cond: [{ $gt: ["$phoneRevealCount", 0] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const revealStats = revealAggregate[0] || { totalReveals: 0, leadsRevealed: 0 };

    const topRevealed = await Lead.find({ company: companyId, phoneRevealCount: { $gt: 0 } })
      .sort({ phoneRevealCount: -1 })
      .limit(5)
      .select("name mobile phoneRevealCount")
      .lean();

    res.status(200).json({
      totalLeads,
      quality: { hot: hotLeads, warm: warmLeads, cold: coldLeads },
      phoneReveal: {
        totalReveals:  revealStats.totalReveals,
        leadsRevealed: revealStats.leadsRevealed,
        topRevealed:   topRevealed.map(l => ({
          name:   l.name,
          mobile: l.mobile,
          count:  l.phoneRevealCount,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/company/auto-template ─────────────────────────────────────
const getAutoTemplateSettings = async (req, res) => {
  try {
    const company = await Company.findById(req.admin.company._id).select("autoTemplate");
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json({ autoTemplate: company.autoTemplate || {} });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/admin/company/auto-template ─────────────────────────────────────
const updateAutoTemplateSettings = async (req, res) => {
  try {
    const { whatsapp, email, sms } = req.body;
    const update = {};
    if (whatsapp !== undefined) {
      if (typeof whatsapp.enabled      === "boolean") update["autoTemplate.whatsapp.enabled"]      = whatsapp.enabled;
      if (whatsapp.templateName !== undefined)         update["autoTemplate.whatsapp.templateName"] = whatsapp.templateName;
      if (whatsapp.languageCode !== undefined)         update["autoTemplate.whatsapp.languageCode"] = whatsapp.languageCode;
    }
    if (email !== undefined) {
      if (typeof email.enabled      === "boolean")  update["autoTemplate.email.enabled"]      = email.enabled;
      if (email.subject     !== undefined)           update["autoTemplate.email.subject"]      = email.subject;
      if (email.fromName    !== undefined)           update["autoTemplate.email.fromName"]     = email.fromName;
      if (email.bodyTemplate !== undefined)          update["autoTemplate.email.bodyTemplate"] = email.bodyTemplate;
    }
    if (sms !== undefined) {
      if (typeof sms.enabled  === "boolean")  update["autoTemplate.sms.enabled"]    = sms.enabled;
      if (sms.message    !== undefined)        update["autoTemplate.sms.message"]    = sms.message;
      if (sms.templateId !== undefined)        update["autoTemplate.sms.templateId"] = sms.templateId;
      if (sms.senderId   !== undefined)        update["autoTemplate.sms.senderId"]   = sms.senderId;
    }
    const company = await Company.findByIdAndUpdate(
      req.admin.company._id,
      { $set: update },
      { new: true, select: "autoTemplate" }
    );
    res.json({ success: true, autoTemplate: company.autoTemplate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Company Branding ──────────────────────────────────────────────────────────
// GET /api/admin/company/brand  →  { name, logoUrl }
const getCompanyBrand = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId).select("brandName brandLogoUrl").lean();
    res.json({ name: company?.brandName || "", logoUrl: company?.brandLogoUrl || "" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Multer storage for logo uploads
const brandStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../public/uploads/logos");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const cid = req.admin?.company?._id || req.admin?.company;
    cb(null, `logo_${cid}${ext}`);
  },
});
const brandUpload = multer({
  storage: brandStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
}).single("logo");

// PUT /api/admin/company/brand  →  FormData: name (text) + logo (file, optional)
const updateCompanyBrand = (req, res) => {
  brandUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      const companyId = req.admin?.company?._id || req.admin?.company;
      const updates   = {};
      if (req.body.name !== undefined) {
        updates.brandName = req.body.name.trim().slice(0, 40);
      }
      if (req.file) {
        // Adjust this URL prefix to match your server / CDN setup
        updates.brandLogoUrl = `/uploads/logos/${req.file.filename}`;
      }
      const company = await Company.findByIdAndUpdate(companyId, updates, { new: true })
        .select("brandName brandLogoUrl");
      res.json({ name: company.brandName, logoUrl: company.brandLogoUrl });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
};

// DELETE /api/admin/company/brand/logo
const deleteCompanyLogo = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, { brandLogoUrl: "" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Brevo (email blast) connection ────────────────────────────────────────────
// GET /api/admin/company/brevo-status  →  { connected: bool }
const getBrevoStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId).select("+brevoApiKey").lean();
    res.json({ connected: !!(company?.brevoApiKey) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/company/brevo-config  →  { apiKey }
const saveBrevoConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ message: "Brevo API key is required" });
    }
    await Company.findByIdAndUpdate(companyId, { brevoApiKey: apiKey.trim() });
    res.json({ success: true, connected: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
  createCompanyUser,
  deleteCompanyUser,
  getDashboardStats,
  getAutoTemplateSettings,
  updateAutoTemplateSettings,
  getCompanyBrand,
  updateCompanyBrand,
  deleteCompanyLogo,
  getBrevoStatus,
  saveBrevoConfig,
};
