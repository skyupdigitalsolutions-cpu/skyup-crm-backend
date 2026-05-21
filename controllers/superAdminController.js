// controllers/superAdminController.js
const bcrypt       = require("bcryptjs");
const SuperAdmin   = require("../models/SuperAdmin");
const Company      = require("../models/Company");
const Admin        = require("../models/Admin");
const User         = require("../models/Users");
const Lead         = require("../models/Leads");
const generateToken         = require("../utils/generateToken");
const { sendSuperAdminOtp } = require("../utils/brevoMailer");

// ── OTP config ─────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MIN  = 10;
const MAX_ATTEMPTS    = 3;
const LOCK_MIN        = 15;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

// Register SuperAdmin (run once only!)
const registerSuperAdmin = async (req, res) => {
  try {
    const exists = await SuperAdmin.findOne({});
    if (exists) {
      return res.status(400).json({ message: "SuperAdmin already exists" });
    }

    const { name, email, password } = req.body;
    const superAdmin = await SuperAdmin.create({ name, email, password });

    res.status(201).json({
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      role: "super_admin",
      token: generateToken(superAdmin._id, "super_admin"),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── STEP 1: POST /api/superadmin/login ────────────────────────────────────────
// Validates email + password → sends OTP to super admin email.
// Does NOT return a JWT yet.
const loginSuperAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required." });

    let targetName  = "";
    let targetEmail = "";
    let isAdmin     = false; // true = found in Admin model

    // Try Admin model first (new multi-tenant super_admin)
    const adminDoc = await Admin.findOne({ email, role: "super_admin" }).populate("company");
    if (adminDoc && (await adminDoc.matchPassword(password))) {
      targetName  = adminDoc.name;
      targetEmail = adminDoc.email;
      isAdmin     = true;
    }

    // Fallback: legacy SuperAdmin document
    if (!isAdmin) {
      const legacyDoc = await SuperAdmin.findOne({ email });
      if (legacyDoc && (await legacyDoc.matchPassword(password))) {
        targetName  = legacyDoc.name;
        targetEmail = legacyDoc.email;

        // Respect existing lockout
        if (legacyDoc.otpLockedUntil && legacyDoc.otpLockedUntil > new Date()) {
          const mins = Math.ceil((legacyDoc.otpLockedUntil - Date.now()) / 60000);
          return res.status(429).json({
            message: `Too many failed OTP attempts. Try again in ${mins} minute(s).`,
          });
        }
      }
    }

    if (!targetEmail)
      return res.status(401).json({ message: "Invalid email or password." });

    // Generate & hash OTP
    const plainOtp  = generateOtp();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    // Upsert an OTP record in the SuperAdmin collection (works for both flows)
    await SuperAdmin.findOneAndUpdate(
      { email: targetEmail },
      {
        $set: {
          name:           targetName,
          email:          targetEmail,
          // Keep password field valid; if it's a new shadow doc set a placeholder
          ...(isAdmin ? {} : {}),
          otp:            hashedOtp,
          otpExpiry,
          otpAttempts:    0,
          otpLockedUntil: null,
        },
        $setOnInsert: { password: "SHADOW_NO_DIRECT_LOGIN" },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Send OTP via Brevo
    try {
      await sendSuperAdminOtp(targetEmail, targetName, plainOtp);
    } catch (mailErr) {
      console.error("Brevo OTP send error:", mailErr.message);
      return res.status(502).json({
        message: "Could not send OTP email. Check your BREVO_API_KEY configuration.",
      });
    }

    return res.status(200).json({
      message:      "OTP sent to your registered email. Please verify to complete login.",
      otpSent:      true,
      email:        targetEmail,
      expiresInMin: OTP_EXPIRY_MIN,
    });
  } catch (error) {
    console.error("loginSuperAdmin error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── STEP 2: POST /api/superadmin/verify-otp ───────────────────────────────────
// Accepts { email, otp } → returns JWT on success.
const verifySuperAdminOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ message: "Email and OTP are required." });

    const otpDoc = await SuperAdmin.findOne({ email });
    if (!otpDoc || !otpDoc.otp)
      return res.status(400).json({ message: "No pending OTP. Please login again." });

    // Lockout check
    if (otpDoc.otpLockedUntil && otpDoc.otpLockedUntil > new Date()) {
      const mins = Math.ceil((otpDoc.otpLockedUntil - Date.now()) / 60000);
      return res.status(429).json({ message: `Account locked. Try again in ${mins} minute(s).` });
    }

    // Expiry check
    if (!otpDoc.otpExpiry || otpDoc.otpExpiry < new Date()) {
      otpDoc.otp = null; otpDoc.otpExpiry = null; otpDoc.otpAttempts = 0;
      await otpDoc.save();
      return res.status(400).json({ message: "OTP has expired. Please login again." });
    }

    // OTP match
    const isMatch = await otpDoc.matchOtp(String(otp).trim());
    if (!isMatch) {
      otpDoc.otpAttempts += 1;
      if (otpDoc.otpAttempts >= MAX_ATTEMPTS) {
        otpDoc.otp            = null;
        otpDoc.otpExpiry      = null;
        otpDoc.otpLockedUntil = new Date(Date.now() + LOCK_MIN * 60 * 1000);
        await otpDoc.save();
        return res.status(429).json({
          message: `Too many failed attempts. Locked for ${LOCK_MIN} minutes.`,
        });
      }
      await otpDoc.save();
      const left = MAX_ATTEMPTS - otpDoc.otpAttempts;
      return res.status(400).json({ message: `Incorrect OTP. ${left} attempt(s) remaining.` });
    }

    // Clear OTP
    otpDoc.otp = null; otpDoc.otpExpiry = null;
    otpDoc.otpAttempts = 0; otpDoc.otpLockedUntil = null;
    await otpDoc.save();

    // Resolve real admin doc for JWT response
    const adminDoc = await Admin.findOne({ email, role: "super_admin" }).populate("company");
    if (adminDoc) {
      return res.status(200).json({
        _id:         adminDoc._id,
        name:        adminDoc.name,
        email:       adminDoc.email,
        role:        "super_admin",
        companyId:   adminDoc.company?._id,
        companyName: adminDoc.company?.name,
        token:       generateToken(adminDoc._id, "super_admin"),
      });
    }

    // Fallback: legacy SuperAdmin doc (real one, not shadow)
    return res.status(200).json({
      _id:   otpDoc._id,
      name:  otpDoc.name,
      email: otpDoc.email,
      role:  "super_admin",
      token: generateToken(otpDoc._id, "super_admin"),
    });
  } catch (error) {
    console.error("verifySuperAdminOtp error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── RESEND: POST /api/superadmin/resend-otp ───────────────────────────────────
const resendSuperAdminOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required." });

    const otpDoc = await SuperAdmin.findOne({ email });
    if (!otpDoc)
      return res.status(400).json({ message: "No pending login session. Please login again." });

    if (otpDoc.otpLockedUntil && otpDoc.otpLockedUntil > new Date()) {
      const mins = Math.ceil((otpDoc.otpLockedUntil - Date.now()) / 60000);
      return res.status(429).json({ message: `Account locked. Try again in ${mins} minute(s).` });
    }

    const plainOtp  = generateOtp();
    const hashedOtp = await bcrypt.hash(plainOtp, 10);
    otpDoc.otp            = hashedOtp;
    otpDoc.otpExpiry      = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);
    otpDoc.otpAttempts    = 0;
    otpDoc.otpLockedUntil = null;
    await otpDoc.save();

    try {
      await sendSuperAdminOtp(email, otpDoc.name, plainOtp);
    } catch (mailErr) {
      console.error("Brevo OTP resend error:", mailErr.message);
      return res.status(502).json({ message: "Failed to resend OTP. Check BREVO_API_KEY." });
    }

    return res.status(200).json({ message: "New OTP sent to your email.", expiresInMin: OTP_EXPIRY_MIN });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Company Management ────────────────────────────────────────────────────────

const createCompany = async (req, res) => {
  try {
    const { name, email, phone, plan } = req.body;

    const companyExists = await Company.findOne({ email });
    if (companyExists) {
      return res.status(400).json({ message: "Company already exists" });
    }

    const company = await Company.create({ name, email, phone, plan });
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find({});
    res.status(200).json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const admins = await Admin.find({ company: id }).select("-password");
    const users  = await User.find({ company: id }).select("-password");
    const leads  = await Lead.find({ company: id });

    res.status(200).json({ company, admins, users, leads });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const toggleCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    company.isActive = !company.isActive;
    await company.save();

    res.status(200).json({
      message: `Company ${company.isActive ? "activated" : "deactivated"} successfully`,
      isActive: company.isActive,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    await Admin.deleteMany({ company: id });
    await User.deleteMany({ company: id });
    await Lead.deleteMany({ company: id });
    await Company.findByIdAndDelete(id);

    res.status(200).json({ message: "Company and all its data deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── UPDATED: getDashboardStats now accepts optional companyId (from companyIsolation) ─
const getDashboardStats = async (req, res) => {
  try {
    const companyId = req.companyId; // set by companyIsolation middleware

    if (companyId) {
      // Scoped stats for a specific company's super_admin
      const [users, leads, admins] = await Promise.all([
        User.countDocuments({ company: companyId }),
        Lead.countDocuments({ company: companyId }),
        Admin.countDocuments({ company: companyId, role: "admin" }),
      ]);
      return res.json({ users, leads, admins });
    }

    // Platform-wide stats (legacy, for old SuperAdmin flow)
    const totalCompanies  = await Company.countDocuments();
    const activeCompanies = await Company.countDocuments({ isActive: true });
    const totalAdmins     = await Admin.countDocuments();
    const totalUsers      = await User.countDocuments();
    const totalLeads      = await Lead.countDocuments();

    res.status(200).json({
      totalCompanies,
      activeCompanies,
      totalAdmins,
      totalUsers,
      totalLeads,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── NEW: super_admin creates an admin within their own company ────────────────
const createAdmin = async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const companyId = req.companyId; // from companyIsolation middleware

    if (!companyId)
      return res.status(400).json({ message: "Company context missing" });

    // super_admin cannot create another super_admin
    if (req.body.role === "super_admin")
      return res.status(403).json({ message: "Cannot create another super admin" });

    const existing = await Admin.findOne({ email });
    if (existing)
      return res.status(400).json({ message: "An admin with this email already exists" });

    const admin = await Admin.create({
      name, email, password, department,
      role: "admin",
      company: companyId,
    });

    res.status(201).json({
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      department: admin.department,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── NEW: GET /api/superadmin/admin-details/:adminId ───────────────────────────
const getAdminDetails = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { adminId } = req.params;

    const admin = await Admin.findOne({ _id: adminId, company: companyId }).select("-password").lean();
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    const users = await User.find({ company: companyId, createdBy: adminId })
      .select("-password")
      .lean();

    const leads = await Lead.find({ company: companyId, assignedAdmin: adminId })
      .select("name mobile email status source campaign temperature phoneRevealCount assignedAdmin user date remark")
      .lean();

    const userIds = users.map((u) => u._id.toString());
    const leadsWithRevealsByAdmin = await Lead.find({
      company: companyId,
      "phoneRevealLog.0": { $exists: true },
    })
      .select("name mobile phoneRevealLog phoneRevealCount")
      .lean();

    let totalRevealsByAdmin = 0;
    const revealedLeads = [];
    leadsWithRevealsByAdmin.forEach((lead) => {
      const adminReveals = lead.phoneRevealLog.filter(
        (entry) => userIds.includes(entry.userId?.toString())
      );
      if (adminReveals.length > 0) {
        totalRevealsByAdmin += adminReveals.length;
        revealedLeads.push({
          leadId: lead._id,
          name: lead.name,
          mobile: lead.mobile,
          revealCount: adminReveals.length,
          revealedBy: adminReveals.map((e) => ({ userName: e.userName, revealedAt: e.revealedAt })),
        });
      }
    });

    const statusBreakdown = leads.reduce((acc, l) => {
      acc[l.status] = (acc[l.status] || 0) + 1;
      return acc;
    }, {});

    const tempBreakdown = leads.reduce((acc, l) => {
      const t = l.temperature || "Unknown";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});

    res.status(200).json({
      admin,
      users,
      leads,
      stats: {
        totalUsers: users.length,
        totalLeads: leads.length,
        statusBreakdown,
        tempBreakdown,
        phoneReveals: {
          totalRevealsByAdmin,
          leadsRevealed: revealedLeads.length,
          details: revealedLeads,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── NEW: GET /api/superadmin/all-admins ───────────────────────────────────────
const getAllAdminsWithStats = async (req, res) => {
  try {
    const companyId = req.companyId;

    const admins = await Admin.find({ company: companyId, role: "admin" })
      .select("-password")
      .lean();

    const adminsWithStats = await Promise.all(
      admins.map(async (admin) => {
        const [userCount, leadCount] = await Promise.all([
          User.countDocuments({ company: companyId, createdBy: admin._id }),
          Lead.countDocuments({ company: companyId, assignedAdmin: admin._id }),
        ]);
        return { ...admin, userCount, leadCount };
      })
    );

    res.status(200).json(adminsWithStats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
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
};