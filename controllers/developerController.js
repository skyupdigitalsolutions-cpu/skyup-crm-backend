// controllers/developerController.js — UPDATED
// Added: getCompanyDetails, applyDevOverride, grantFreeAddon, grantBenefit,
//        addAiCredits, changeSubscriptionStatus, getAuditLogs
// All existing functions are UNCHANGED.

const path          = require("path");
const fs            = require("fs");
const multer        = require("multer");
const cloudinary             = require("cloudinary").v2;
const { CloudinaryStorage }  = require("multer-storage-cloudinary");
const Developer     = require("../models/Developer");
const Company       = require("../models/Company");
const Admin         = require("../models/Admin");
const User          = require("../models/Users");
const generateToken = require("../utils/generateToken");
const { sendEmail }           = require("../utils/brevoMailer");
const { companyWelcomeEmail } = require("../utils/emailTemplates");

// New dependencies for Phase 3 additions
const CompanyAddon        = require("../models/CompanyAddon");
const CompanyBenefit      = require("../models/CompanyBenefit");
const CompanyUsage        = require("../models/CompanyUsage");
const EntitlementAuditLog = require("../models/EntitlementAuditLog");
const {
  getCompanyEntitlements,
  getRemainingUsage,
  logAudit,
} = require("../services/entitlementService");
const { calcDaysRemaining } = require("./subscriptionController");
const Payment = require("../models/Payment");

// ── Cloudinary config ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Cloudinary storage for company logo uploads ───────────────────────────────
const logoStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const id     = req.params.id || Date.now();
    const prefix = file.fieldname === "headerLogo" ? "company_header_logo" : "company_logo";
    return {
      folder:          "skyup-crm/logos",
      resource_type:   "image",
      public_id:       `${prefix}_${id}_${Date.now()}`,
      allowed_formats: ["jpg", "jpeg", "png", "svg", "webp"],
      transformation:  [{ width: 400, height: 400, crop: "limit" }],
    };
  },
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
}).fields([
  { name: "logo",       maxCount: 1 },
  { name: "headerLogo", maxCount: 1 },
]);

const withOptionalLogo = (handler) => (req, res) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    logoUpload(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message });
      handler(req, res);
    });
  } else {
    handler(req, res);
  }
};

// ── Login ──────────────────────────────────────────────────────────────────────
const developerLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const dev = await Developer.findOne({ email });
    if (!dev || !(await dev.matchPassword(password)))
      return res.status(401).json({ message: "Invalid credentials" });

    res.json({
      _id: dev._id, name: dev.name, email: dev.email,
      role: "developer",
      token: generateToken(dev._id, "developer"),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Dashboard ─────────────────────────────────────────────────────────────────
const getDeveloperDashboard = async (req, res) => {
  try {
    const now   = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const [totalCompanies, activeCompanies, totalAdmins, totalUsers,
           trialCompanies, suspendedCompanies, expiringAddons] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ isActive: true }),
      Admin.countDocuments(),
      User.countDocuments(),
      Company.countDocuments({ subscriptionStatus: "trial" }),
      Company.countDocuments({ subscriptionStatus: { $in: ["suspended", "paused"] } }),
      // Addons expiring within 7 days
      CompanyAddon.countDocuments({
        status: "active",
        expiryDate: { $gt: now, $lt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    // Total AI usage this month across all companies
    const usageAgg = await CompanyUsage.aggregate([
      { $match: { month } },
      {
        $group: {
          _id:                null,
          totalTranscriptions: { $sum: "$transcriptionsUsed" },
          totalSummaries:      { $sum: "$summariesUsed" },
          totalVoiceBot:       { $sum: "$voiceBotUsed" },
        },
      },
    ]);
    const aiUsage = usageAgg[0] || { totalTranscriptions: 0, totalSummaries: 0, totalVoiceBot: 0 };

    res.json({
      totalCompanies, activeCompanies, totalAdmins, totalUsers,
      trialCompanies, suspendedCompanies, expiringAddons,
      aiUsageThisMonth: aiUsage,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Create Company ─────────────────────────────────────────────────────────────
const _createCompanyHandler = async (req, res) => {
  try {
    const body  = req.body || {};
    const { name, email, phone, plan } = body;

    if (!name || !email)
      return res.status(400).json({ message: "Company name and email are required" });

    const exists = await Company.findOne({ email });
    if (exists)
      return res.status(400).json({ message: "A company with this email already exists" });

    const { headerName } = body;
    const companyData = {
      name, email, phone, plan: plan || "trial",
      createdBy: req.user._id,
    };

    if (req.files?.logo?.[0])       companyData.logo = req.files.logo[0].path;
    if (headerName !== undefined && String(headerName).trim())
      companyData.headerName = String(headerName).trim().slice(0, 40);
    if (req.files?.headerLogo?.[0]) companyData.headerLogoUrl = req.files.headerLogo[0].path;

    const company = await Company.create(companyData);

    setImmediate(async () => {
      try {
        const template = companyWelcomeEmail({ companyName: company.name, plan: company.plan });
        await sendEmail({ to: company.email, toName: company.name, subject: template.subject, html: template.html, text: template.text });
        console.log(`[createCompany] ✉  Welcome email sent to ${company.email}`);
      } catch (mailErr) {
        console.error(`[createCompany] ✗  Welcome email failed for ${company.email}:`, mailErr.message);
      }
    });

    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
const createCompany = withOptionalLogo(_createCompanyHandler);

// ── Create super_admin ────────────────────────────────────────────────────────
const createCompanySuperAdmin = async (req, res) => {
  try {
    const { id: companyId } = req.params;
    const { name, email, password } = req.body;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const exists = await Admin.findOne({ company: companyId, role: "super_admin" });
    if (exists) return res.status(400).json({ message: "This company already has a super admin" });

    const superAdmin = await Admin.create({ name, email, password, role: "super_admin", company: companyId });

    res.status(201).json({ _id: superAdmin._id, name: superAdmin.name, email: superAdmin.email, role: superAdmin.role });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Update Company ────────────────────────────────────────────────────────────
const _updateCompanyHandler = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const body = req.body || {};
    const { name, email, phone, plan, headerName } = body;

    if (email && email !== company.email) {
      const exists = await Company.findOne({ email, _id: { $ne: company._id } });
      if (exists) return res.status(400).json({ message: "Another company with this email already exists" });
      company.email = email;
    }

    if (name)  company.name  = name;
    if (phone !== undefined) company.phone = phone;
    if (plan && ["trial","basic","pro","enterprise"].includes(plan)) company.plan = plan;
    if (headerName !== undefined) company.headerName = String(headerName).trim().slice(0, 40);
    if (req.files?.logo?.[0])       company.logo = req.files.logo[0].path;
    if (req.files?.headerLogo?.[0]) company.headerLogoUrl = req.files.headerLogo[0].path;

    await company.save();
    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
const updateCompany = withOptionalLogo(_updateCompanyHandler);

// ── List companies ────────────────────────────────────────────────────────────
const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find().select("-brevoApiKey -encryptionKeyHash -customerOpenAiKey -customerGeminiKey");
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Toggle company active/suspended ───────────────────────────────────────────
const toggleCompanyStatus = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ message: "Company not found" });
    company.isActive = !company.isActive;
    await company.save();
    res.json({ isActive: company.isActive });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Subscriptions list (developer panel) ─────────────────────────────────────
const getSubscriptions = async (req, res) => {
  try {
    const subs = await Company.find().select(
      "name plan subscriptionStatus subscriptionExpiry maxAdmins maxUsers maxLeads maxWebsites isActive"
    );
    res.json(subs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const allowed = ["plan","subscriptionStatus","subscriptionExpiry","maxAdmins","maxUsers","maxLeads","maxWebsites","maxMetaCampaigns","maxGoogleAccounts","maxStorage"];
    const update  = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const company = await Company.findByIdAndUpdate(companyId, update, { new: true });
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW PHASE 3 ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/developer/companies/:id/details ──────────────────────────────────
// Full company details page: subscription + usage + addons + benefits + AI credits + audit log
const getCompanyDetails = async (req, res) => {
  try {
    const companyId = req.params.id;

    const now   = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const [company, entitlements, addons, benefits, usage, auditLogs, remaining] = await Promise.all([
      Company.findById(companyId)
        .select("-brevoApiKey -encryptionKeyHash -customerOpenAiKey -customerGeminiKey -telegramBotToken")
        .lean(),
      getCompanyEntitlements(companyId),
      CompanyAddon.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyBenefit.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyUsage.findOne({ companyId, month }).lean(),
      EntitlementAuditLog.find({ companyId }).sort({ createdAt: -1 }).limit(50).lean(),
      getRemainingUsage(companyId),
    ]);

    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Normalize devOverrides.featureToggles (a Mongoose Map) → plain object.
    // JSON.stringify(new Map()) === "{}", so without this the frontend would
    // never see the company's explicit per-feature overrides.
    if (company.devOverrides && company.devOverrides.featureToggles instanceof Map) {
      company.devOverrides.featureToggles = Object.fromEntries(company.devOverrides.featureToggles);
    }

    res.json({
      success: true,
      company,
      entitlements,
      addons,
      benefits,
      usage:    usage || { month, recordingsUsed: 0, transcriptionsUsed: 0, summariesUsed: 0, voiceBotUsed: 0 },
      remaining,
      auditLogs,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    console.error("[getCompanyDetails]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/developer/companies/:id/override ─────────────────────────────────
// Save resource overrides + feature toggles to company.devOverrides
const applyDevOverride = async (req, res) => {
  try {
    const companyId = req.params.id;
    const { featureToggles, reason = "" } = req.body;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Serialize the current devOverrides to a plain JS object.
    // toObject() converts the Mongoose subdoc but may leave the featureToggles
    // field as a Map instance when using Mongoose 9.x with Map type fields.
    // We explicitly convert it to a plain object to ensure safe spreading.
    const rawOverrides = company.devOverrides?.toObject?.() || company.devOverrides || {};
    const oldOverrides = {
      ...rawOverrides,
      featureToggles: rawOverrides.featureToggles instanceof Map
        ? Object.fromEntries(rawOverrides.featureToggles)
        : (rawOverrides.featureToggles || {}),
    };
    const newOverrides = { ...oldOverrides };

    // Numeric / limit overrides. For each field:
    //   • key ABSENT from body     → leave unchanged
    //   • key present & a number   → set as ABSOLUTE override (this company only)
    //   • key present & "" or null → clear it (revert to plan + addon value)
    const NUMERIC_FIELDS = [
      "admins", "users", "leads", "websites",
      "metaCampaigns", "googleAccounts", "storageMB",
      "transcriptionsLimit", "summariesLimit", "voiceBotLimit",
    ];
    for (const field of NUMERIC_FIELDS) {
      if (!(field in req.body)) continue;
      const raw = req.body[field];
      if (raw === null || raw === "") {
        newOverrides[field] = null;
      } else {
        const n = parseInt(raw, 10);
        newOverrides[field] = Number.isFinite(n) ? n : null;
      }
    }

    // recordingEnabled tri-state: true / false / null (inherit)
    if ("recordingEnabled" in req.body) {
      const r = req.body.recordingEnabled;
      newOverrides.recordingEnabled = (r === null || r === "") ? null : !!r;
    }

    // featureToggles replaced wholesale when provided (object keyed by camelCase feature key)
    if (featureToggles && typeof featureToggles === "object") {
      newOverrides.featureToggles = featureToggles;
    }

    company.devOverrides = newOverrides;
    await company.save();

    await logAudit({
      companyId,
      actorId:   req.developer?._id || null,
      actorRole: "developer",
      action:    "dev_override_applied",
      field:     "devOverrides",
      oldValue:  oldOverrides,
      newValue:  newOverrides,
      reason:    reason || "Dev override applied from Developer Panel",
    });

    const entitlements = await getCompanyEntitlements(companyId);
    res.json({ success: true, devOverrides: newOverrides, entitlements });
  } catch (err) {
    console.error("[applyDevOverride]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/developer/companies/:id/ai-credits ─────────────────────────────
// Add AI transcription / summary / voiceBot credits via a new free addon entry
const addAiCredits = async (req, res) => {
  try {
    const companyId = req.params.id;
    const { creditType, quantity = 1, reason = "" } = req.body;

    // creditType: "transcriptions_100" | "transcriptions_500" | "summaries_100" | "summaries_500"
    const VALID_TYPES = ["transcriptions_100", "transcriptions_500", "summaries_100", "summaries_500"];
    if (!VALID_TYPES.includes(creditType)) {
      return res.status(400).json({
        success: false,
        message: `creditType must be one of: ${VALID_TYPES.join(", ")}`,
      });
    }

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const addon = await CompanyAddon.create({
      companyId,
      addonType:     creditType,
      quantity:      Math.max(1, parseInt(quantity, 10)),
      startDate:     new Date(),
      expiryDate:    null,  // credits don't expire
      status:        "active",
      paymentStatus: "free",
      createdBy:     req.developer?._id || null,
      createdByModel: "Developer",
      notes:         reason || `AI credits added by developer: ${creditType} × ${quantity}`,
    });

    await logAudit({
      companyId,
      actorId:   req.developer?._id || null,
      actorRole: "developer",
      action:    "ai_credits_added",
      field:     "addonType",
      newValue:  { creditType, quantity },
      reason:    reason || `AI credits: ${creditType} × ${quantity}`,
    });

    res.status(201).json({ success: true, addon });
  } catch (err) {
    console.error("[addAiCredits]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/developer/companies/:id/status ───────────────────────────────────
// Pause / resume / suspend a company's subscription
const changeSubscriptionStatus = async (req, res) => {
  try {
    const companyId = req.params.id;
    const { status, reason = "" } = req.body;

    const VALID = ["active", "suspended", "paused", "cancelled", "trial"];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${VALID.join(", ")}` });
    }

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const oldStatus = company.subscriptionStatus;
    company.subscriptionStatus = status;
    // isActive should only be true when status is "active" or "trial"
    company.isActive = ["active", "trial"].includes(status);
    await company.save();

    await logAudit({
      companyId,
      actorId:   req.developer?._id || null,
      actorRole: "developer",
      action:    "subscription_status_changed",
      field:     "subscriptionStatus",
      oldValue:  oldStatus,
      newValue:  status,
      reason:    reason || `Status changed to "${status}"`,
    });

    res.json({ success: true, company: { _id: company._id, subscriptionStatus: status, isActive: company.isActive } });
  } catch (err) {
    console.error("[changeSubscriptionStatus]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/developer/companies/:id/audit ────────────────────────────────────
// Paginated audit log for a company
const getAuditLogs = async (req, res) => {
  try {
    const companyId = req.params.id;
    const page  = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limit = Math.min(100, parseInt(req.query.limit || "20", 10));
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      EntitlementAuditLog.find({ companyId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EntitlementAuditLog.countDocuments({ companyId }),
    ]);

    res.json({
      success: true,
      logs,
      pagination: { total, page, pages: Math.ceil(total / limit), limit },
    });
  } catch (err) {
    console.error("[getAuditLogs]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/developer/companies/:id/grant-addon ─────────────────────────────
// Convenience wrapper: grant free addon from developer panel
const grantFreeAddon = async (req, res) => {
  // Delegate to addonController.grantAddon logic inline to avoid circular deps
  try {
    const companyId = req.params.id;
    const { addonType, quantity = 1, durationMonths, notes = "" } = req.body;

    if (!addonType) return res.status(400).json({ success: false, message: "addonType is required" });

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const startDate  = new Date();
    let   expiryDate = null;
    if (durationMonths) {
      expiryDate = new Date(startDate);
      expiryDate.setMonth(expiryDate.getMonth() + parseInt(durationMonths, 10));
    }

    const addon = await CompanyAddon.create({
      companyId, addonType,
      quantity:  Math.max(1, parseInt(quantity, 10)),
      startDate, expiryDate,
      status:        "active",
      paymentStatus: "free",
      createdBy:     req.developer?._id || null,
      createdByModel: "Developer",
      notes,
    });

    await logAudit({
      companyId,
      actorId:   req.developer?._id || null,
      actorRole: "developer",
      action:    "addon_granted",
      field:     "addonType",
      newValue:  addonType,
      reason:    notes || `Free addon granted: ${addonType} × ${quantity}`,
    });

    res.status(201).json({ success: true, addon });
  } catch (err) {
    console.error("[grantFreeAddon]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/developer/companies/:id/grant-benefit ──────────────────────────
// Convenience wrapper: grant benefit from developer panel
const grantBenefit = async (req, res) => {
  try {
    const companyId = req.params.id;
    const { benefitType, quantity = 1, validDays, notes = "" } = req.body;

    if (!benefitType) return res.status(400).json({ success: false, message: "benefitType is required" });

    const company = await Company.findById(companyId).select("name").lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const validFrom  = new Date();
    let   validUntil = null;
    if (validDays && parseInt(validDays, 10) > 0) {
      validUntil = new Date(validFrom);
      validUntil.setDate(validUntil.getDate() + parseInt(validDays, 10));
    }

    const benefit = await require("../models/CompanyBenefit").create({
      companyId, benefitType,
      quantity:  Math.max(1, parseInt(quantity, 10)),
      grantedBy: req.developer?._id || null,
      validFrom, validUntil,
      active: true, notes,
    });

    await logAudit({
      companyId,
      actorId:   req.developer?._id || null,
      actorRole: "developer",
      action:    "benefit_granted",
      field:     "benefitType",
      newValue:  benefitType,
      reason:    notes || `Benefit granted: ${benefitType} × ${quantity}`,
    });

    res.status(201).json({ success: true, benefit });
  } catch (err) {
    console.error("[grantBenefit]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};


// ── GET /api/developer/companies/:id/payments ─────────────────────────────────
// Returns all payment invoices for a specific company (developer-only)
const getCompanyPayments = async (req, res) => {
  try {
    const { id: companyId } = req.params;

    const payments = await Payment.find({ company: companyId })
      .sort({ createdAt: -1 })
      .lean();

    const invoices = payments.map((p) => ({
      id:            p.invoiceId,
      invoiceId:     p.invoiceId,
      date:          new Date(p.createdAt).toLocaleDateString("en-IN", {
                       day: "2-digit", month: "short", year: "numeric",
                     }),
      rawDate:       p.createdAt,
      amount:        `₹${p.amount.toLocaleString("en-IN")}`,
      baseAmount:    p.amount,
      status:        p.status === "paid" ? "Paid" : p.status === "failed" ? "Failed" : "Pending",
      planName:      p.planName,
      billingCycle:  p.billing,
      transactionId: p.razorpayPaymentId,
      orderId:       p.razorpayOrderId,
    }));

    return res.status(200).json({ success: true, invoices });
  } catch (err) {
    console.error("[getCompanyPayments]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  // Existing
  developerLogin,
  getDeveloperDashboard,
  createCompany,
  createCompanySuperAdmin,
  getCompanies,
  updateCompany,
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
  // New Phase 3
  getCompanyDetails,
  applyDevOverride,
  addAiCredits,
  changeSubscriptionStatus,
  getAuditLogs,
  grantFreeAddon,
  grantBenefit,
  getCompanyPayments,
};
