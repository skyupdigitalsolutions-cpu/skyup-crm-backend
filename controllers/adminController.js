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


// ── POST /api/admin/company/msg91-register-webhook ───────────────────────────
// Programmatically registers the inbound webhook URL with MSG91 so lead replies
// arrive instantly (< 2s) instead of via the 30s polling fallback.
const registerMsg91Webhook = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true }).lean();
    if (!config?.msg91AuthKey) {
      return res.status(400).json({ message: "MSG91 not configured for this company" });
    }

    const authKey          = config.msg91AuthKey;
    const integratedNumber = config.msg91IntegratedNumber;
    const protocol  = req.headers["x-forwarded-proto"] || "https";
    const host      = req.headers["x-forwarded-host"] || req.headers.host;
    const backendUrl = process.env.BACKEND_URL || `${protocol}://${host}`;
    const webhookUrl = `${backendUrl}/msg91-webhook`;
    const headers    = { authkey: authKey, "Content-Type": "application/json" };

    console.log(`🔧 Registering MSG91 webhook: ${webhookUrl} for number ${integratedNumber}`);

    const results = [];
    let linkedToNumber = false;
    let webhookCreated = false;

    // ── Method A: Link webhook directly to the integrated number ─────────────
    // MSG91 requires TWO steps: (1) create webhook, (2) link to specific number.
    // "Nothing Here" in webhook logs = step 2 was never done.
    const methodAEndpoints = [
      { method: "PUT",   url: "https://control.msg91.com/api/v5/whatsapp/integrated-number",
        body: { integrated_number: integratedNumber, webhook_url: webhookUrl } },
      { method: "PATCH", url: "https://control.msg91.com/api/v5/whatsapp/integrated-number",
        body: { integrated_number: integratedNumber, webhookUrl } },
      { method: "PUT",   url: "https://control.msg91.com/api/v5/whatsapp/integrated-number/settings",
        body: { integrated_number: integratedNumber, response_url: webhookUrl, inbound_url: webhookUrl } },
      { method: "POST",  url: `https://control.msg91.com/api/v5/whatsapp/integrated-number/${integratedNumber}/webhook`,
        body: { webhook_url: webhookUrl, event: "inbound" } },
    ];

    for (const ep of methodAEndpoints) {
      try {
        const r = ep.method === "PUT"   ? await axios.put(ep.url, ep.body, { headers, timeout: 8000 })
                : ep.method === "PATCH" ? await axios.patch(ep.url, ep.body, { headers, timeout: 8000 })
                :                         await axios.post(ep.url, ep.body, { headers, timeout: 8000 });
        results.push({ method: ep.method, url: ep.url, status: r.status, data: r.data });
        console.log(`✅ Method A (${ep.method} ${ep.url}):`, r.data);
        linkedToNumber = true;
        break;
      } catch (e) {
        results.push({ method: ep.method, url: ep.url, status: e.response?.status, error: e.response?.data || e.message });
        console.warn(`⚠️  Method A (${ep.method} ${ep.url}):`, e.response?.data || e.message);
      }
    }

    // ── Method B: Create/update named webhook entry ───────────────────────────
    if (!linkedToNumber) {
      const methodBEndpoints = [
        { url: "https://control.msg91.com/api/v5/webhook",
          body: { name: "CRM Inbound", url: webhookUrl, service: "whatsapp", event: "inbound", integrated_number: integratedNumber } },
        { url: "https://control.msg91.com/api/v5/whatsapp/webhook",
          body: { integrated_number: integratedNumber, webhook_url: webhookUrl, event: "inbound" } },
      ];
      for (const ep of methodBEndpoints) {
        try {
          const r = await axios.post(ep.url, ep.body, { headers, timeout: 8000 });
          results.push({ url: ep.url, status: r.status, data: r.data });
          console.log(`✅ Method B (${ep.url}):`, r.data);
          webhookCreated = true;
          break;
        } catch (e) {
          results.push({ url: ep.url, status: e.response?.status, error: e.response?.data || e.message });
          console.warn(`⚠️  Method B (${ep.url}):`, e.response?.data || e.message);
        }
      }
    }

    const autoRegistered = linkedToNumber || webhookCreated;
    res.json({
      success: true,
      webhookUrl,
      autoRegistered,
      linkedToNumber,
      webhookCreated,
      results,
      message: autoRegistered
        ? "Webhook registered with MSG91! Lead replies will now arrive instantly (<2s)."
        : `Auto-registration failed. Set manually: MSG91 → WhatsApp → Integrated Numbers → ${integratedNumber} → Settings → Response Webhook → ${webhookUrl}`,
    });
  } catch (err) {
    console.error("❌ MSG91 webhook registration error:", err.message);
    res.status(500).json({ success: false, message: err.message });
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

// ── MSG91 Email config ────────────────────────────────────────────────────────
// GET /api/admin/company/msg91-email-config
const getMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select("+msg91EmailApiKey msg91EmailDomain msg91EmailSenderEmail msg91EmailSenderName msg91EmailDailyCount msg91EmailCountDate")
      .lean();

    const MSG91_EMAIL_DAILY_LIMIT = 5000;
    const today = new Date().toISOString().slice(0, 10);
    const count = company?.msg91EmailCountDate === today ? (company?.msg91EmailDailyCount || 0) : 0;

    res.json({
      connected:   !!(company?.msg91EmailApiKey && company?.msg91EmailSenderEmail && company?.msg91EmailDomain),
      domain:      company?.msg91EmailDomain      || "",
      senderEmail: company?.msg91EmailSenderEmail || "",
      senderName:  company?.msg91EmailSenderName  || "",
      dailyLimit:  MSG91_EMAIL_DAILY_LIMIT,
      usedToday:   count,
      remaining:   Math.max(0, MSG91_EMAIL_DAILY_LIMIT - count),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/company/msg91-email-config
const saveMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { apiKey, domain, senderEmail, senderName } = req.body;
    if (!apiKey       || !apiKey.trim())       return res.status(400).json({ message: "MSG91 Auth Key is required" });
    if (!domain       || !domain.trim())       return res.status(400).json({ message: "Sending domain is required" });
    if (!senderEmail  || !senderEmail.trim())  return res.status(400).json({ message: "Sender email is required" });

    await Company.findByIdAndUpdate(companyId, {
      msg91EmailApiKey:      apiKey.trim(),
      msg91EmailDomain:      domain.trim(),
      msg91EmailSenderEmail: senderEmail.trim(),
      msg91EmailSenderName:  (senderName || "CRM").trim(),
    });
    res.json({
      success:     true,
      connected:   true,
      domain:      domain.trim(),
      senderEmail: senderEmail.trim(),
      senderName:  (senderName || "CRM").trim(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/company/msg91-email-config
const deleteMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, {
      msg91EmailApiKey:      "",
      msg91EmailDomain:      "",
      msg91EmailSenderEmail: "",
      msg91EmailSenderName:  "",
    });
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /admin/company/telegram/admins ───────────────────────────────────────
// Returns all admins of this company with their Telegram config.
// Super-admin only (requireCompanySuperAdmin guard on route).
const getAdminsTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const admins = await Admin.find({ company: companyId })
      .select("name email role telegramChatId telegramNotificationsEnabled")
      .lean();

    res.json(admins.map(a => ({
      _id:                          a._id,
      name:                         a.name,
      email:                        a.email,
      role:                         a.role,
      telegramChatId:               a.telegramChatId || "",
      telegramNotificationsEnabled: a.telegramNotificationsEnabled !== false,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /admin/company/telegram/admins/:adminId ───────────────────────────────
// Super-admin updates a specific admin's Telegram chat ID + enabled flag.
const saveAdminTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { adminId } = req.params;
    const { telegramChatId, telegramNotificationsEnabled } = req.body;

    const target = await Admin.findOne({ _id: adminId, company: companyId });
    if (!target) return res.status(404).json({ message: "Admin not found." });

    if (telegramChatId !== undefined) {
      target.telegramChatId = telegramChatId ? String(telegramChatId).trim() : null;
    }
    if (telegramNotificationsEnabled !== undefined) {
      target.telegramNotificationsEnabled = Boolean(telegramNotificationsEnabled);
    }
    await target.save();

    res.json({
      message:                      "Admin Telegram config saved.",
      telegramChatId:               target.telegramChatId || "",
      telegramNotificationsEnabled: target.telegramNotificationsEnabled,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /admin/company/telegram/admins/:adminId/test ─────────────────────────
// Sends a test Telegram message to the specified admin's personal chat.
const testAdminTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { adminId } = req.params;

    const [company, target] = await Promise.all([
      Company.findById(companyId).select("name telegramBotToken").lean(),
      Admin.findOne({ _id: adminId, company: companyId }).select("name telegramChatId").lean(),
    ]);

    if (!company?.telegramBotToken)
      return res.status(400).json({ message: "Company bot token not configured." });
    if (!target?.telegramChatId)
      return res.status(400).json({ message: "Admin chat ID not configured." });

    const text =
      `✅ <b>Telegram Connected!</b>\n\n` +
      `Hello <b>${target.name}</b>, your personal Telegram notifications are now active.\n\n` +
      `You will receive campaign lead alerts for <b>${company.name}</b> in this chat.`;

    const https = require("https");
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: target.telegramChatId, text, parse_mode: "HTML" });
      const req2 = https.request(
        {
          hostname: "api.telegram.org",
          path:     `/bot${company.telegramBotToken}/sendMessage`,
          method:   "POST",
          headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (r) => {
          let d = "";
          r.on("data", c => { d += c; });
          r.on("end", () => {
            try {
              const p = JSON.parse(d);
              p.ok ? resolve(p) : reject(new Error(p.description || "Telegram error"));
            } catch { reject(new Error("Invalid Telegram response")); }
          });
        }
      );
      req2.on("error", reject);
      req2.setTimeout(10000, () => req2.destroy(new Error("Timeout")));
      req2.write(body);
      req2.end();
    });

    res.json({ message: `Test sent to ${target.name}! Check their Telegram.` });
  } catch (err) {
    res.status(500).json({ message: err.message || "Test failed — check token & chat ID." });
  }
};

// ── PUT /admin/user/:id/telegram ─────────────────────────────────────────────
// Admin sets a specific employee's Telegram chat ID.
// Employee can also call this on their own (via authController self-update).
const updateUserTelegram = async (req, res) => {
  try {
    const { id }            = req.params;
    const { telegramChatId } = req.body;
    const companyId          = req.admin?.company?._id || req.admin?.company;

    const user = await User.findOne({ _id: id, company: companyId });
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    user.telegramChatId = telegramChatId ? String(telegramChatId).trim() : null;
    await user.save();

    res.json({ message: 'Telegram chat ID updated.', telegramChatId: user.telegramChatId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /admin/company/clock-in-location ─────────────────────────────────────
const getClockInLocation = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select('clockInLocationEnabled clockInLatitude clockInLongitude clockInRadiusMeters')
      .lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.json({
      enabled:   company.clockInLocationEnabled || false,
      latitude:  company.clockInLatitude  || null,
      longitude: company.clockInLongitude || null,
      radius:    company.clockInRadiusMeters || 100,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /admin/company/clock-in-location ─────────────────────────────────────
const saveClockInLocation = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { enabled, latitude, longitude, radius } = req.body;
    const update = {};
    if (enabled   !== undefined) update.clockInLocationEnabled = Boolean(enabled);
    if (latitude  != null)       update.clockInLatitude        = Number(latitude);
    if (longitude != null)       update.clockInLongitude       = Number(longitude);
    if (radius    != null)       update.clockInRadiusMeters    = Math.max(50, Number(radius));
    await Company.findByIdAndUpdate(companyId, { $set: update });
    res.json({ message: 'Clock-in location settings saved.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /admin/user/:id/meeting-permission ────────────────────────────────────
// Admin grants/revokes client-meeting remote clock-in permission for an employee.
const updateMeetingPermission = async (req, res) => {
  try {
    const { id }    = req.params;
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { grant } = req.body; // true = grant, false = revoke

    const user = await User.findOne({ _id: id, company: companyId });
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    user.clientMeetingPermission          = Boolean(grant);
    user.clientMeetingPermissionGrantedBy = grant ? (req.admin?._id || null) : null;
    user.clientMeetingPermissionGrantedAt = grant ? new Date() : null;
    // Clear the pending request when admin responds
    user.meetingPermissionRequested  = false;
    user.meetingPermissionStatus     = grant ? 'approved' : 'denied';
    await user.save();

    // Notify the employee via socket so the app updates in real-time
    const _io = global._io;
    if (_io) {
      _io.to(`agent:${String(id)}`).emit('meeting_permission_response', {
        approved:  Boolean(grant),
        grantedAt: user.clientMeetingPermissionGrantedAt?.toISOString() || null,
        adminName: req.admin?.name || 'Admin',
      });
    }

    res.json({
      message:   grant ? 'Remote clock-in permission granted (24h).' : 'Permission revoked.',
      userId:    user._id,
      granted:   user.clientMeetingPermission,
      grantedAt: user.clientMeetingPermissionGrantedAt,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
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
  getMsg91EmailConfig,
  saveMsg91EmailConfig,
  deleteMsg91EmailConfig,
  getTelegramConfig,
  saveTelegramConfig,
  testTelegramConfig,
  getAdminsTelegramConfig,
  saveAdminTelegramConfig,
  testAdminTelegramConfig,
  updateUserTelegram,
  getClockInLocation,
  saveClockInLocation,
  updateMeetingPermission,
  registerMsg91Webhook,
};