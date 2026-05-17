const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");

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
    const admins = await Admin.find({ company: req.admin.company._id }).select("-password");
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
    const existingAdminCount = await Admin.countDocuments({ company: companyId });

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
    if (admin.role === "superadmin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "superadmin",
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

    if (req.body.role && !["superadmin", "admin"].includes(req.body.role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    // Guard: don't demote the company's only superadmin.
    if (admin.role === "superadmin" && req.body.role && req.body.role !== "superadmin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "superadmin",
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

// Get all users in same company
const getCompanyUsers = async (req, res) => {
  try {
    const users = await User.find({ company: req.admin.company._id }).select("-password");
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all leads in same company — paginated
// BUG FIX: was returning ALL leads with no limit (response grows unboundedly).
// Now returns paginated { leads[], total, page, pages } matching adminGetAllLeads shape.
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
    const user = await User.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/dashboard-stats ───────────────────────────────────────────
// Returns KPI stats for admin dashboard including phone reveal counts
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

    // Top 5 most-revealed leads
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

module.exports = {
  getMyCompany,
  getAdmin,
  getAdmins,
  createAdmin,
  deleteAdmin,
  updateAdmin,
  getCompanyUsers,
  getCompanyLeads,
  deleteCompanyUser,
  getDashboardStats,
};
