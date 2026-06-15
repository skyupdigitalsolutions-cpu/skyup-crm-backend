// controllers/superAdminController.js — UPDATED
// Added: getCompanyEntitlementDetails — visible to super_admin role.
// Added: getExpiringSubscriptions — returns companies with subscriptions expiring within N days.
// All existing functions are UNCHANGED.

const bcrypt       = require("bcryptjs");
const SuperAdmin   = require("../models/SuperAdmin");
const Company      = require("../models/Company");
const Admin        = require("../models/Admin");
const User         = require("../models/Users");
const Lead         = require("../models/Leads");
const generateToken         = require("../utils/generateToken");
const { sendSuperAdminOtp } = require("../utils/brevoMailer");

// Imports for entitlement details
const CompanyAddon        = require("../models/CompanyAddon");
const CompanyBenefit      = require("../models/CompanyBenefit");
const CompanyUsage        = require("../models/CompanyUsage");
const EntitlementAuditLog = require("../models/EntitlementAuditLog");
const { getCompanyEntitlements, getRemainingUsage } = require("../services/entitlementService");
const { calcDaysRemaining } = require("./subscriptionController");

// ── OTP config ─────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MIN = 10;
const MAX_ATTEMPTS   = 3;
const LOCK_MIN       = 15;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL ORIGINAL FUNCTIONS — unchanged
// ─────────────────────────────────────────────────────────────────────────────

const registerSuperAdmin = async (req, res) => {
  try {
    const exists = await SuperAdmin.findOne({});
    if (exists) return res.status(400).json({ message: "SuperAdmin already exists" });
    const { name, email, password } = req.body;
    const superAdmin = await SuperAdmin.create({ name, email, password });
    res.status(201).json({
      _id: superAdmin._id, name: superAdmin.name, email: superAdmin.email,
      role: "super_admin",
      token: generateToken(superAdmin._id, "super_admin"),
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const loginSuperAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required." });

    let targetName = "", targetEmail = "", isAdmin = false;

    const adminDoc = await Admin.findOne({ email, role: "super_admin" }).populate("company");
    if (adminDoc && (await adminDoc.matchPassword(password))) {
      targetName = adminDoc.name; targetEmail = adminDoc.email; isAdmin = true;
    }

    if (!isAdmin) {
      const legacyDoc = await SuperAdmin.findOne({ email });
      if (legacyDoc && (await legacyDoc.matchPassword(password))) {
        targetName = legacyDoc.name; targetEmail = legacyDoc.email;
        if (legacyDoc.otpLockedUntil && legacyDoc.otpLockedUntil > new Date()) {
          const mins = Math.ceil((legacyDoc.otpLockedUntil - Date.now()) / 60000);
          return res.status(429).json({ message: `Too many failed OTP attempts. Try again in ${mins} minute(s).` });
        }
      }
    }

    if (!targetEmail) return res.status(401).json({ message: "Invalid email or password." });

    const plainOtp  = generateOtp();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    await SuperAdmin.findOneAndUpdate(
      { email: targetEmail },
      {
        $set: {
          name: targetName, email: targetEmail,
          otp: hashedOtp, otpExpiry,
          otpAttempts: 0, otpLockedUntil: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendSuperAdminOtp({ toEmail: targetEmail, toName: targetName, otp: plainOtp });

    res.json({
      success: true,
      message: `OTP sent to ${targetEmail}. Valid for ${OTP_EXPIRY_MIN} minutes.`,
      email:   targetEmail,
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const verifySuperAdminOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required." });

    const shadowDoc = await SuperAdmin.findOne({ email });
    if (!shadowDoc) return res.status(401).json({ message: "No pending OTP for this email." });

    if (shadowDoc.otpLockedUntil && shadowDoc.otpLockedUntil > new Date()) {
      const mins = Math.ceil((shadowDoc.otpLockedUntil - Date.now()) / 60000);
      return res.status(429).json({ message: `Account locked. Try again in ${mins} minute(s).` });
    }

    if (!shadowDoc.otp || !shadowDoc.otpExpiry || new Date() > shadowDoc.otpExpiry) {
      return res.status(400).json({ message: "OTP expired. Please request a new one." });
    }

    const match = await bcrypt.compare(String(otp), shadowDoc.otp);
    if (!match) {
      const attempts = (shadowDoc.otpAttempts || 0) + 1;
      const update   = { otpAttempts: attempts };
      if (attempts >= MAX_ATTEMPTS) {
        update.otpLockedUntil = new Date(Date.now() + LOCK_MIN * 60 * 1000);
        update.otp = null; update.otpExpiry = null;
        await SuperAdmin.findByIdAndUpdate(shadowDoc._id, { $set: update });
        return res.status(429).json({ message: `Too many failed attempts. Account locked for ${LOCK_MIN} minutes.` });
      }
      await SuperAdmin.findByIdAndUpdate(shadowDoc._id, { $set: update });
      return res.status(400).json({ message: `Invalid OTP. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.` });
    }

    await SuperAdmin.findByIdAndUpdate(shadowDoc._id, {
      $set: { otp: null, otpExpiry: null, otpAttempts: 0, otpLockedUntil: null },
    });

    // ── Path A: Admin model (new multi-tenant super admin) ───────────────────
    // Super admin created via SuperAdmin dashboard → exists in Admin collection
    // with role "super_admin" and a company reference.
    const adminDoc = await Admin.findOne({ email, role: "super_admin" }).populate("company");
    if (adminDoc) {
      return res.json({
        _id:         adminDoc._id,
        name:        adminDoc.name,
        email:       adminDoc.email,
        role:        "super_admin",
        company:     adminDoc.company,
        companyId:   adminDoc.company?._id,
        companyName: adminDoc.company?.name,
        token:       generateToken(adminDoc._id, "super_admin"),
      });
    }

    // ── Path B: Legacy SuperAdmin model ──────────────────────────────────────
    // Super admin was created via the old /superadmin/register route and only
    // exists in the SuperAdmin collection (no company field on that model).
    //
    // FIX: Without this lookup the legacy response had no company/companyId,
    // so localStorage stored companyId:"", the socket's super_admin_join guard
    // silently aborted (missing company), and the chat panel showed
    // "No contacts yet / 0 online" forever.
    //
    // We look up the Admin collection by email to find the associated company —
    // the super admin may have been migrated to Admin since their initial
    // registration, or a matching Admin record may exist under the same email.
    // If found, include companyId so the chat widget works correctly.
    const migratedAdmin = await Admin.findOne({ email }).populate("company");
    const companyObj    = migratedAdmin?.company || null;
    const companyId     = companyObj?._id || null;
    const companyName   = companyObj?.name || "";

    // If no Admin record exists at all for this email, the super admin is a
    // pure legacy account with no company association. Chat will remain empty
    // but at least the login succeeds without crashing.
    if (!companyId) {
      console.warn(
        "[verifySuperAdminOtp] Legacy super admin has no Admin record / company — chat will be empty.",
        "email=", email
      );
    }

    res.json({
      _id:         shadowDoc._id,
      name:        shadowDoc.name,
      email:       shadowDoc.email,
      role:        "super_admin",
      company:     companyObj,
      companyId:   companyId,
      companyName: companyName,
      token:       generateToken(shadowDoc._id, "super_admin"),
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const resendSuperAdminOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required." });

    const shadowDoc = await SuperAdmin.findOne({ email });
    if (!shadowDoc) return res.status(404).json({ message: "No pending OTP session for this email. Please login first." });

    if (shadowDoc.otpLockedUntil && shadowDoc.otpLockedUntil > new Date()) {
      const mins = Math.ceil((shadowDoc.otpLockedUntil - Date.now()) / 60000);
      return res.status(429).json({ message: `Account locked. Try again in ${mins} minute(s).` });
    }

    const plainOtp  = generateOtp();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    await SuperAdmin.findByIdAndUpdate(shadowDoc._id, {
      $set: { otp: hashedOtp, otpExpiry, otpAttempts: 0 },
    });

    await sendSuperAdminOtp({ toEmail: email, toName: shadowDoc.name || "Admin", otp: plainOtp });

    res.json({ success: true, message: `OTP resent to ${email}.` });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const createCompany = async (req, res) => {
  try {
    const { name, email, phone, plan } = req.body;
    if (!name || !email) return res.status(400).json({ message: "Name and email are required" });
    const exists = await Company.findOne({ email });
    if (exists) return res.status(400).json({ message: "Company with this email already exists" });

    // Default new companies onto the gated 7-day Pro free trial: "trial_pending"
    // (read-only) until a payment method is added, which starts the 7-day clock.
    const companyData =
      plan && plan !== "trial"
        ? { name, email, phone, plan }
        : {
            name, email, phone,
            plan:               "pro",
            trialPlan:          "pro",
            subscriptionStatus: "trial_pending",
            trialEndsAt:        null,
          };

    const company = await Company.create(companyData);
    res.status(201).json(company);
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find().select("-brevoApiKey -encryptionKeyHash");
    res.json(companies);
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const getCompany = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id).select("-brevoApiKey -encryptionKeyHash");
    if (!company) return res.status(404).json({ message: "Company not found" });

    let entitlementSummary = null;
    try { entitlementSummary = await getCompanyEntitlements(req.params.id); } catch (_) {}

    res.json({ ...company.toObject(), entitlementSummary });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const toggleCompany = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ message: "Company not found" });
    company.isActive = !company.isActive;
    await company.save();
    res.json({ message: `Company ${company.isActive ? "activated" : "deactivated"}`, isActive: company.isActive });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const deleteCompany = async (req, res) => {
  try {
    const company = await Company.findByIdAndDelete(req.params.id);
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json({ message: "Company deleted" });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const getDashboardStats = async (req, res) => {
  try {
    const companyId = req.companyId;
    if (companyId) {
      const [users, leads, admins, totalCompanies] = await Promise.all([
        User.countDocuments({ company: companyId }),
        Lead.countDocuments({ company: companyId }),
        Admin.countDocuments({ company: companyId }),
        Company.countDocuments(),
      ]);
      return res.json({ users, leads, admins, totalCompanies });
    }
    const [totalCompanies, activeCompanies, totalAdmins, totalUsers, totalLeads] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ isActive: true }),
      Admin.countDocuments(),
      User.countDocuments(),
      Lead.countDocuments(),
    ]);
    res.status(200).json({ totalCompanies, activeCompanies, totalAdmins, totalUsers, totalLeads });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const createAdmin = async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const companyId = req.companyId;
    if (!companyId) return res.status(400).json({ message: "Company context missing" });
    if (req.body.role === "super_admin") return res.status(403).json({ message: "Cannot create another super admin" });
    const existing = await Admin.findOne({ email });
    if (existing) return res.status(400).json({ message: "An admin with this email already exists" });
    const admin = await Admin.create({ name, email, password, plainPassword: password, department, role: "admin", company: companyId });
    res.status(201).json({ _id: admin._id, name: admin.name, email: admin.email, role: admin.role, department: admin.department });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const getAdminDetails = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { adminId } = req.params;
    const admin = await Admin.findOne({ _id: adminId, company: companyId }).select("-password").lean();
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    const users   = await User.find({ company: companyId, createdBy: adminId }).select("-password").lean();
    const userIds = users.map(u => u._id.toString());
    const leadsQuery = { company: companyId, $or: [{ assignedAdmin: adminId }, ...(userIds.length > 0 ? [{ user: { $in: userIds } }] : [])] };
    const leads  = await Lead.find(leadsQuery).select("name mobile email status source campaign temperature phoneRevealCount assignedAdmin user date remark").lean();
    const leadsWithRevealsByAdmin = await Lead.find({ company: companyId, "phoneRevealLog.0": { $exists: true } }).select("name mobile phoneRevealLog phoneRevealCount").lean();
    let totalRevealsByAdmin = 0;
    const revealedLeads = [];
    leadsWithRevealsByAdmin.forEach(lead => {
      const adminReveals = lead.phoneRevealLog.filter(entry => userIds.includes(entry.userId?.toString()) || entry.userId?.toString() === adminId);
      if (adminReveals.length > 0) {
        totalRevealsByAdmin += adminReveals.length;
        revealedLeads.push({ leadId: lead._id, name: lead.name, mobile: lead.mobile, revealCount: adminReveals.length, revealedBy: adminReveals.map(e => ({ userName: e.userName, revealedAt: e.revealedAt })) });
      }
    });
    const statusBreakdown = leads.reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});
    const tempBreakdown   = leads.reduce((acc, l) => { const t = l.temperature || "Unknown"; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
    res.status(200).json({ admin, users, leads, stats: { totalUsers: users.length, totalLeads: leads.length, statusBreakdown, tempBreakdown, phoneReveals: { totalRevealsByAdmin, leadsRevealed: revealedLeads.length, details: revealedLeads } } });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

const getAllAdminsWithStats = async (req, res) => {
  try {
    const companyId = req.companyId;
    const admins = await Admin.find({ company: companyId, role: "admin" }).select("-password").lean();
    const adminsWithStats = await Promise.all(admins.map(async admin => {
      const adminUsers = await User.find({ company: companyId, createdBy: admin._id }, { _id: 1 }).lean();
      const userIds = adminUsers.map(u => u._id);
      const [userCount, leadCount] = await Promise.all([
        Promise.resolve(userIds.length),
        Lead.countDocuments({ company: companyId, $or: [{ assignedAdmin: admin._id }, ...(userIds.length > 0 ? [{ user: { $in: userIds } }] : [])] }),
      ]);
      return { ...admin, userCount, leadCount };
    }));
    res.status(200).json(adminsWithStats);
  } catch (error) { res.status(500).json({ message: error.message }); }
};

// ─────────────────────────────────────────────────────────────────────────────
// getCompanyEntitlementDetails
// GET /api/superadmin/companies/:id/entitlements
// ─────────────────────────────────────────────────────────────────────────────
const getCompanyEntitlementDetails = async (req, res) => {
  try {
    const companyId = req.params.id;
    const now   = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const [company, entitlements, addons, benefits, usage, remaining] = await Promise.all([
      Company.findById(companyId)
        .select("-brevoApiKey -encryptionKeyHash -customerOpenAiKey -customerGeminiKey")
        .lean(),
      getCompanyEntitlements(companyId),
      CompanyAddon.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyBenefit.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyUsage.findOne({ companyId, month }).lean(),
      getRemainingUsage(companyId),
    ]);

    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    res.json({
      success: true,
      company,
      entitlements,
      addons,
      benefits,
      usage:    usage || { month, recordingsUsed: 0, transcriptionsUsed: 0, summariesUsed: 0, voiceBotUsed: 0 },
      remaining,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    console.error("[getCompanyEntitlementDetails]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getExpiringSubscriptions
// GET /api/superadmin/expiring-subscriptions?days=30
// Returns companies whose subscriptionEnd falls within the next N days (max 90).
// Used by NotificationProvider on mount to populate the bell icon alerts.
// ─────────────────────────────────────────────────────────────────────────────
const getExpiringSubscriptions = async (req, res) => {
  try {
    const days   = Math.min(parseInt(req.query.days) || 30, 90);
    const now    = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const companies = await Company.find({
      subscriptionEnd: { $gte: now, $lte: cutoff },
    })
      .select("name email plan subscriptionEnd isActive")
      .sort({ subscriptionEnd: 1 })
      .lean();

    const results = companies.map(c => ({
      ...c,
      daysRemaining: calcDaysRemaining(c),
    }));

    res.json({ success: true, count: results.length, companies: results });
  } catch (err) {
    console.error("[getExpiringSubscriptions]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /superadmin/company/:id/call-log-sync ─────────────────────────────────
// Super admin enables or disables device call-log sync for a specific company.
// When disabled, the backend rejects all /call-logs/sync requests from that company.
const toggleCallLogSync = async (req, res) => {
  try {
    const { id }     = req.params;
    const { enabled } = req.body;
    const Company    = require('../models/Company');
    const company    = await Company.findById(id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    company.callLogSyncEnabled = Boolean(enabled);
    await company.save();
    res.json({
      message:            `Device call-log sync ${enabled ? 'enabled' : 'disabled'} for ${company.name}.`,
      callLogSyncEnabled: company.callLogSyncEnabled,
      companyId:          company._id,
      companyName:        company.name,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = {
  registerSuperAdmin,
  loginSuperAdmin,
  verifySuperAdminOtp,
  resendSuperAdminOtp,
  createCompany,
  createAdmin,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
  getAdminDetails,
  getAllAdminsWithStats,
  getCompanyEntitlementDetails,
  getExpiringSubscriptions,
  toggleCallLogSync,
};