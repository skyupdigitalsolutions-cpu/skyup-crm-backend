// controllers/developerController.js — NEW FILE
const path          = require("path");
const fs            = require("fs");
const multer        = require("multer");
const Developer     = require("../models/Developer");
const Company       = require("../models/Company");
const Admin         = require("../models/Admin");
const User          = require("../models/Users");
const generateToken = require("../utils/generateToken");

// ── Multer for company logo uploads (developer panel) ─────────────────────────
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../public/uploads/logos");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `company_logo_${req.params.id || Date.now()}${ext}`);
  },
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
}).single("logo");

// Wrapper: parses multipart if a file is present, otherwise falls through
// (express.json() already parsed the body for JSON requests)
const withOptionalLogo = (handler) => (req, res) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    // Parse the multipart form — then hand off to handler
    logoUpload(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message });
      handler(req, res);
    });
  } else {
    // JSON body already parsed by express.json() — just call handler
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

// ── Dashboard — aggregated counts ONLY, NEVER query Leads/Chats/Messages ──────
const getDeveloperDashboard = async (req, res) => {
  try {
    const [totalCompanies, activeCompanies, totalAdmins, totalUsers] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ isActive: true }),
      Admin.countDocuments(),
      User.countDocuments(),
    ]);
    res.json({ totalCompanies, activeCompanies, totalAdmins, totalUsers });
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

    const companyData = {
      name, email, phone, plan,
      createdBy: req.user._id,
    };

    if (req.file) {
      companyData.logo = `/uploads/logos/${req.file.filename}`;
    }

    const company = await Company.create(companyData);
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createCompany = withOptionalLogo(_createCompanyHandler);

// ── Create super_admin for a company — enforces 1 per company ─────────────────
const createCompanySuperAdmin = async (req, res) => {
  try {
    const { id: companyId } = req.params;
    const { name, email, password } = req.body;

    const company = await Company.findById(companyId);
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    const exists = await Admin.findOne({ company: companyId, role: "super_admin" });
    if (exists)
      return res.status(400).json({ message: "This company already has a super admin" });

    const superAdmin = await Admin.create({
      name, email, password,
      role: "super_admin",
      company: companyId,
    });

    res.status(201).json({
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      role: superAdmin.role,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Update Company (name, email, phone, plan, logo) ────────────────────────────
// NOTE: exported as a wrapped handler via withOptionalLogo so multer runs first
//       when the request is multipart/form-data (logo upload), and the raw
//       handler is called directly for plain JSON requests.
const _updateCompanyHandler = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    // req.body may be undefined when multer hasn't parsed it yet for non-multipart
    // requests — guard with nullish coalescing so we never crash on destructure.
    const body  = req.body || {};
    const { name, email, phone, plan } = body;

    // Check email uniqueness only if email changed
    if (email && email !== company.email) {
      const exists = await Company.findOne({ email, _id: { $ne: company._id } });
      if (exists)
        return res.status(400).json({ message: "Another company with this email already exists" });
      company.email = email;
    }

    if (name)  company.name  = name;
    if (phone !== undefined) company.phone = phone;
    if (plan && ["basic","pro","enterprise"].includes(plan)) company.plan = plan;

    // Logo uploaded via multer (multipart/form-data)
    if (req.file) {
      // Store relative URL served from /uploads/logos/
      company.logo = `/uploads/logos/${req.file.filename}`;
    }

    await company.save();
    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Public export — wraps with optional logo parsing middleware
const updateCompany = withOptionalLogo(_updateCompanyHandler);

// ── List all companies (without sensitive fields) ──────────────────────────────
const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find().select("-brevoApiKey -encryptionKeyHash");
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Toggle company active/suspended ───────────────────────────────────────────
const toggleCompanyStatus = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    company.isActive = !company.isActive;
    await company.save();
    res.json({ isActive: company.isActive });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Subscriptions ──────────────────────────────────────────────────────────────
const getSubscriptions = async (req, res) => {
  try {
    const subs = await Company.find().select(
      "name plan subscriptionStatus subscriptionExpiry maxUsers maxLeads isActive"
    );
    res.json(subs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const allowed = ["plan", "subscriptionStatus", "subscriptionExpiry", "maxUsers", "maxLeads"];
    const update  = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const company = await Company.findByIdAndUpdate(companyId, update, { new: true });
    if (!company)
      return res.status(404).json({ message: "Company not found" });

    res.json(company);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  developerLogin,
  getDeveloperDashboard,
  createCompany,
  createCompanySuperAdmin,
  getCompanies,
  updateCompany,
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
};
