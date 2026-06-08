const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const cloudinary             = require("cloudinary").v2;
const { CloudinaryStorage }  = require("multer-storage-cloudinary");

// ── Cloudinary config (uses same env vars as the rest of the app) ─────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
    // super_admin gets plainPassword for credential view; others don't
    const selectFields = req.admin.role === "super_admin" ? "-password" : "-password -plainPassword";
    const admins = await Admin.find(filter).select(selectFields);
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

// Create admin — enforce plan limit before creating
const createAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const companyId = req.admin.company._id;

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

    const admin = await Admin.create({ name, email, password, plainPassword: password, company: companyId });

    res.status(201).json({
      _id:           admin._id,
      name:          admin.name,
      email:         admin.email,
      company:       admin.company,
      role:          "admin",
      plainPassword: admin.plainPassword,
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

    // Guard: never delete a company's last superadmin
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
      name, email, password, plainPassword: password,
      company: companyId,
      role: "user",
      createdBy: req.admin._id,
    });

    res.status(201).json({
      _id: user._id, name: user.name, email: user.email,
      company: user.company, role: user.role,
      plainPassword: user.plainPassword,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all users in same company
const getCompanyUsers = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const filter = { company: companyId };
    const ownFilter = { company: companyId };
    if (req.admin.role !== "super_admin") ownFilter.createdBy = req.admin._id;

    const userSelectFields = req.admin.role === "super_admin" ? "-password" : "-password -plainPassword";
    const [users, totalCompanyUsers] = await Promise.all([
      User.find(ownFilter).select(userSelectFields),
      User.countDocuments(filter),
    ]);

    res.status(200).json({ users, totalCompanyUsers });
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

    // Admins and superadmins see all leads including closed ones.
    // Non-admin roles (employees) must NOT see closed leads.
    // mergedInto: null ensures absorbed duplicate leads are always hidden.
    const isAdminRole = ["admin", "super_admin"].includes(req.admin.role);
    const filter = { company: companyId, mergedInto: null };
    if (!isAdminRole) {
      filter.isClosed = { $ne: true };
    }

    const [leads, total] = await Promise.all([
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      Lead.countDocuments(filter),
    ]);

    res.status(200).json({ leads, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete user — with company check
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
    const companyId = req.admin?.company?._id || req.admin?.company;

    const [
      totalLeads,
      hotLeads,
      warmLeads,
      coldLeads,
      revealAggregate,
      emailRevealAggregate,
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
      Lead.aggregate([
        { $match: { company: companyId } },
        { $group: {
            _id: null,
            totalReveals:  { $sum: "$emailRevealCount" },
            leadsRevealed: { $sum: { $cond: [{ $gt: ["$emailRevealCount", 0] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const revealStats      = revealAggregate[0]      || { totalReveals: 0, leadsRevealed: 0 };
    const emailRevealStats = emailRevealAggregate[0]  || { totalReveals: 0, leadsRevealed: 0 };

    // ── Phone reveal: top leads + per-admin breakdown ────────────────────────
    const topRevealed = await Lead.find({ company: companyId, phoneRevealCount: { $gt: 0 } })
      .sort({ phoneRevealCount: -1 })
      .limit(5)
      .select("name mobile phoneRevealCount")
      .lean();

    // ── Email reveal: top leads + per-admin breakdown ─────────────────────
    const topEmailRevealed = await Lead.find({ company: companyId, emailRevealCount: { $gt: 0 } })
      .sort({ emailRevealCount: -1 })
      .limit(5)
      .select("name email emailRevealCount")
      .lean();

    let byAdmin = [];
    let byAdminEmail = [];

    if (req.admin?.role === "super_admin") {
      // ── Phone reveal by admin ──────────────────────────────────────────
      const leadsWithReveals = await Lead.find({
        company: companyId,
        "phoneRevealLog.0": { $exists: true },
      }).select("name mobile phoneRevealLog phoneRevealCount").lean();

      const userMap = {};
      leadsWithReveals.forEach((lead) => {
        (lead.phoneRevealLog || []).forEach((entry) => {
          const uid = entry.userId?.toString() || "unknown";
          if (!userMap[uid]) {
            userMap[uid] = {
              adminName: entry.userName || "Unknown User",
              totalReveals: 0,
              leadsRevealed: new Set(),
              leads: {},
            };
          }
          userMap[uid].totalReveals += 1;
          userMap[uid].leadsRevealed.add(lead._id.toString());
          const lid = lead._id.toString();
          if (!userMap[uid].leads[lid]) {
            userMap[uid].leads[lid] = { name: lead.name, mobile: lead.mobile, count: 0 };
          }
          userMap[uid].leads[lid].count += 1;
        });
      });

      byAdmin = Object.values(userMap).map((a) => ({
        adminName:     a.adminName,
        totalReveals:  a.totalReveals,
        leadsRevealed: a.leadsRevealed.size,
        leads:         Object.values(a.leads),
      }));

      // ── Email reveal by admin ──────────────────────────────────────────
      const leadsWithEmailReveals = await Lead.find({
        company: companyId,
        "emailRevealLog.0": { $exists: true },
      }).select("name email emailRevealLog emailRevealCount").lean();

      const emailUserMap = {};
      leadsWithEmailReveals.forEach((lead) => {
        (lead.emailRevealLog || []).forEach((entry) => {
          const uid = entry.userId?.toString() || "unknown";
          if (!emailUserMap[uid]) {
            emailUserMap[uid] = {
              adminName:    entry.userName || "Unknown User",
              adminEmail:   entry.userEmail || "",
              totalReveals: 0,
              leadsRevealed: new Set(),
              leads: {},
            };
          }
          emailUserMap[uid].totalReveals += 1;
          emailUserMap[uid].leadsRevealed.add(lead._id.toString());
          const lid = lead._id.toString();
          if (!emailUserMap[uid].leads[lid]) {
            emailUserMap[uid].leads[lid] = { name: lead.name, email: lead.email, count: 0 };
          }
          emailUserMap[uid].leads[lid].count += 1;
        });
      });

      byAdminEmail = Object.values(emailUserMap).map((a) => ({
        adminName:     a.adminName,
        adminEmail:    a.adminEmail,
        totalReveals:  a.totalReveals,
        leadsRevealed: a.leadsRevealed.size,
        leads:         Object.values(a.leads),
      }));
    }

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
        byAdmin,
      },
      emailReveal: {
        totalReveals:  emailRevealStats.totalReveals,
        leadsRevealed: emailRevealStats.leadsRevealed,
        topRevealed:   topEmailRevealed.map(l => ({
          name:  l.name,
          email: l.email,
          count: l.emailRevealCount,
        })),
        byAdmin: byAdminEmail,
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
    // Resolve companyId from admin token (admin/super_admin) OR employee/user token
    const raw =
      req.companyId ||
      (req.admin?.company?._id ?? req.admin?.company) ||
      req.user?.company ||
      req.user?.companyId;
    const companyId = raw ? raw.toString() : null;
    const company   = await Company.findById(companyId)
      .select("brandName brandLogoUrl headerName headerLogoUrl")
      .lean();
    // Cloudinary URLs are always absolute — return as-is
    res.json({
      name:          company?.brandName     || "",
      logoUrl:       company?.brandLogoUrl  || "",
      headerName:    company?.headerName    || "",
      headerLogoUrl: company?.headerLogoUrl || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Cloudinary storage for company logo uploads ──────────────────────────────
const brandStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const raw = req.admin?.company?._id ?? req.admin?.company;
    const cid = raw ? raw.toString() : "unknown";
    return {
      folder:          "skyup-crm/logos",
      resource_type:   "image",
      public_id:       `logo_${cid}_${Date.now()}`,
      allowed_formats: ["jpg", "jpeg", "png", "svg", "webp"],
      transformation:  [{ width: 400, height: 400, crop: "limit" }],
    };
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
      const raw       = req.admin?.company?._id ?? req.admin?.company;
      const companyId = raw ? raw.toString() : null;
      if (!companyId) return res.status(400).json({ message: "Company not found on request" });

      const updates = {};
      if (req.body.name !== undefined) {
        updates.brandName = req.body.name.trim().slice(0, 40);
      }
      if (req.file) {
        // Cloudinary returns the full CDN URL directly in req.file.path
        updates.brandLogoUrl = req.file.path;
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

// ── Brevo full config ─────────────────────────────────────────────────────────
// GET /api/admin/company/brevo-config
const getBrevoConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId).select("+brevoApiKey brevoSenderEmail brevoSenderName").lean();
    res.json({
      connected:   !!(company?.brevoApiKey),
      senderEmail: company?.brevoSenderEmail || "",
      senderName:  company?.brevoSenderName  || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/company/brevo-config
const saveBrevoFullConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { apiKey, senderEmail, senderName } = req.body;
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ message: "Brevo API key is required" });
    }
    if (!senderEmail || !senderEmail.trim()) {
      return res.status(400).json({ message: "Sender email is required" });
    }
    await Company.findByIdAndUpdate(companyId, {
      brevoApiKey:      apiKey.trim(),
      brevoSenderEmail: senderEmail.trim(),
      brevoSenderName:  (senderName || "CRM").trim(),
    });
    res.json({
      success:     true,
      connected:   true,
      senderEmail: senderEmail.trim(),
      senderName:  (senderName || "CRM").trim(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/company/brevo-config
const deleteBrevoConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, {
      brevoApiKey:      "",
      brevoSenderEmail: "",
      brevoSenderName:  "",
    });
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── MSG91 (WhatsApp + SMS) config ─────────────────────────────────────────────
// GET /api/admin/company/msg91-config
const getMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");

    const waConfig  = await WhatsAppConfig.findOne({ company: companyId }).lean();
    const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();

    const hasAuthKey  = !!(waConfig?.msg91AuthKey || smsConfig?.msg91AuthKey);
    const hasWaNumber = !!(waConfig?.msg91IntegratedNumber);

    res.json({
      connected:        hasAuthKey && hasWaNumber,
      integratedNumber: waConfig?.msg91IntegratedNumber || "",
      namespace:        waConfig?.msg91Namespace        || "",
      authKeySet:       hasAuthKey,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/company/msg91-config
const saveMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const { authKey, integratedNumber, namespace } = req.body;
    if (!authKey || !authKey.trim()) {
      return res.status(400).json({ message: "MSG91 Auth Key is required" });
    }
    if (!integratedNumber || !integratedNumber.trim()) {
      return res.status(400).json({ message: "Integrated WhatsApp number is required" });
    }
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");

    await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      {
        company: companyId,
        provider: "msg91",
        msg91AuthKey: authKey.trim(),
        msg91IntegratedNumber: integratedNumber.trim(),
        msg91Namespace: (namespace || "").trim(),
        isActive: true,
      },
      { upsert: true, new: true }
    );

    await SmsConfig.findOneAndUpdate(
      { company: companyId },
      { company: companyId, msg91AuthKey: authKey.trim(), isActive: true },
      { upsert: true, new: true }
    );

    res.json({ success: true, connected: true, integratedNumber: integratedNumber.trim(), authKeySet: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/company/msg91-config
const deleteMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");
    await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      { msg91AuthKey: "", msg91IntegratedNumber: "", isActive: false }
    );
    await SmsConfig.findOneAndUpdate(
      { company: companyId },
      { msg91AuthKey: "", isActive: false }
    );
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Single clean export block ─────────────────────────────────────────────────
// ── GET /admin/company/telegram ───────────────────────────────────────────────
const getTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    // Explicitly select telegramBotToken (it has select:false on the schema)
    const company = await Company.findById(companyId)
      .select('telegramEnabled telegramChatId telegramBotToken')
      .lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.json({
      telegramEnabled:  company.telegramEnabled  || false,
      telegramChatId:   company.telegramChatId   || '',
      // Only indicate whether a token is set — never return the actual token
      hasToken: !!(company.telegramBotToken),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /admin/company/telegram ───────────────────────────────────────────────
const saveTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { telegramBotToken, telegramChatId, telegramEnabled } = req.body;

    const update = {};
    if (telegramChatId   !== undefined) update.telegramChatId   = (telegramChatId || '').trim();
    if (telegramEnabled  !== undefined) update.telegramEnabled   = Boolean(telegramEnabled);
    // Only update token when explicitly provided (non-empty string)
    if (telegramBotToken && String(telegramBotToken).trim()) {
      update.telegramBotToken = String(telegramBotToken).trim();
    }

    await Company.findByIdAndUpdate(companyId, { $set: update });
    res.json({ message: 'Telegram settings saved.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /admin/company/telegram/test ─────────────────────────────────────────
const testTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select('name telegramBotToken telegramChatId')
      .lean();

    if (!company) return res.status(404).json({ message: 'Company not found' });
    if (!company.telegramBotToken) return res.status(400).json({ message: 'Bot token not configured.' });
    if (!company.telegramChatId)   return res.status(400).json({ message: 'Chat ID not configured.' });

    const { sendTestNotification } = require('../services/telegramService');
    await sendTestNotification(company.telegramBotToken, company.telegramChatId, company.name);
    res.json({ message: 'Test message sent! Check your Telegram group.' });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to send test — check token and chat ID.' });
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
  getBrevoConfig,
  saveBrevoFullConfig,
  deleteBrevoConfig,
  getMsg91Config,
  saveMsg91Config,
  deleteMsg91Config,
  getTelegramConfig,
  saveTelegramConfig,
  testTelegramConfig,
};