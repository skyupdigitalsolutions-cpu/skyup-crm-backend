// middlewares/adminAuthMiddleware.js — UPDATED ("superadmin" → "super_admin" in role checks)
const jwt        = require("jsonwebtoken");
const Admin      = require("../models/Admin");
const SuperAdmin = require("../models/SuperAdmin");
const Company    = require("../models/Company");
const { isTokenBlacklisted, redisClient } = require("./rateLimiter");

// ── Legacy SuperAdmin → Company cache ─────────────────────────────────────────
// The legacy SuperAdmin path resolves "which company is the superadmin
// currently managing" on every single request via 1-2 extra DB round-trips
// (header lookup, or a full collection scan via Company.findOne({isActive})).
// That target rarely changes within a session, so cache it per superadmin id
// with a short TTL — switching companies (header-driven) still works because
// the header value is part of the cache key.
const SUPERADMIN_COMPANY_CACHE_TTL_SECONDS = 60;
const superAdminCompanyCacheKey = (superAdminId, headerCompanyId) =>
  `sacomp:${superAdminId}:${headerCompanyId || "default"}`;

async function getCachedSuperAdminCompany(superAdminId, headerCompanyId) {
  try {
    if (!redisClient.isReady) return null;
    const cached = await redisClient.get(superAdminCompanyCacheKey(superAdminId, headerCompanyId));
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    console.error("[adminAuth] superadmin company cache read failed:", err.message);
    return null;
  }
}

async function setCachedSuperAdminCompany(superAdminId, headerCompanyId, company) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.set(
      superAdminCompanyCacheKey(superAdminId, headerCompanyId),
      JSON.stringify(company),
      { EX: SUPERADMIN_COMPANY_CACHE_TTL_SECONDS }
    );
  } catch (err) {
    console.error("[adminAuth] superadmin company cache write failed:", err.message);
  }
}

const protectAdmin = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];

      // ── Blacklist check (logout / revocation) ───────────────────────────────
      if (await isTokenBlacklisted(token)) {
        return res.status(401).json({ message: "Token has been invalidated. Please log in again." });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ── super_admin acting as Admin ─────────────────────────────────────────
      // UPDATED: role check uses "super_admin" (was "superadmin")
      if (decoded.role === "super_admin") {
        // First try to find as a proper Admin document (new multi-tenant model)
        const adminDoc = await Admin.findById(decoded.id).select("-password").populate("company");
        if (adminDoc) {
          req.admin = adminDoc;
          req.user = {
            id:        adminDoc._id.toString(),
            userId:    adminDoc._id.toString(),
            companyId: adminDoc.company?._id?.toString() || adminDoc.company?.toString(),
            role:      "super_admin",
            name:      adminDoc.name,
          };
          return next();
        }

        // Fallback: legacy SuperAdmin document
        const superAdmin = await SuperAdmin.findById(decoded.id).select("-password");
        if (!superAdmin) {
          return res.status(401).json({ message: "Not authorized as super_admin" });
        }

        const headerCompanyId = req.headers["x-company-id"];

        let company = await getCachedSuperAdminCompany(superAdmin._id, headerCompanyId);

        if (!company) {
          if (headerCompanyId) {
            company = await Company.findById(headerCompanyId).lean().catch(() => null);
          }
          if (!company) {
            company = await Company.findOne({ isActive: true }).sort({ createdAt: 1 }).lean();
          }
          if (!company) {
            company = await Company.findOne().sort({ createdAt: 1 }).lean();
          }
          if (company) {
            await setCachedSuperAdminCompany(superAdmin._id, headerCompanyId, company);
          }
        }

        if (!company) {
          return res.status(404).json({ message: "No company found for super_admin to manage" });
        }

        req.superAdmin = superAdmin;
        req.admin = {
          _id:          superAdmin._id,
          name:         superAdmin.name,
          email:        superAdmin.email,
          role:         "super_admin",
          company,
          isSuperAdmin: true,
        };
        req.user = {
          id:        superAdmin._id.toString(),
          userId:    superAdmin._id.toString(),
          companyId: company._id.toString(),
          role:      "admin",
          name:      superAdmin.name,
        };

        return next();
      }

      // UPDATED: reject non-admin roles (now excludes both "admin" and "super_admin")
      if (decoded.role && !["admin", "super_admin"].includes(decoded.role)) {
        return res.status(403).json({ message: "Access denied: not an admin token" });
      }

      req.admin = await Admin.findById(decoded.id)
        .select("-password")
        .populate("company");

      if (!req.admin) {
        return res.status(401).json({ message: "Admin not found" });
      }

      if (!req.admin.company) {
        return res.status(403).json({ message: "Company not found" });
      }

      const company = req.admin.company;

      // ── Auto-suspend: mark expired if validity has passed ─────────────────
      const now = new Date();
      if (company.subscriptionStatus === "active" && company.subscriptionExpiry && now > company.subscriptionExpiry) {
        await Company.findByIdAndUpdate(company._id, { subscriptionStatus: "expired", isActive: false });
        company.subscriptionStatus = "expired";
        company.isActive = false;
      }
      if (company.subscriptionStatus === "trial" && company.trialEndsAt && now > company.trialEndsAt) {
        await Company.findByIdAndUpdate(company._id, { subscriptionStatus: "expired", isActive: false });
        company.subscriptionStatus = "expired";
        company.isActive = false;
      }

      // ── Block suspended/expired companies — but allow UpgradePlan routes ──
      const isSubscriptionRoute = req.path?.startsWith("/company/brand") ||
        req.originalUrl?.includes("/subscription") ||
        req.originalUrl?.includes("/razorpay");

      if (!company.isActive && !isSubscriptionRoute) {
        return res.status(403).json({
          message: "Your subscription has expired. Please renew to continue.",
          code: "SUBSCRIPTION_EXPIRED",
          suspended: true,
        });
      }

      // ── Compute days remaining for expiry warning ─────────────────────────
      let daysRemaining = null;
      if (company.subscriptionStatus === "active" && company.subscriptionExpiry) {
        const nowMid    = Date.UTC(now.getUTCFullYear(),    now.getUTCMonth(),    now.getUTCDate());
        const expMid    = Date.UTC(new Date(company.subscriptionExpiry).getUTCFullYear(), new Date(company.subscriptionExpiry).getUTCMonth(), new Date(company.subscriptionExpiry).getUTCDate());
        daysRemaining   = Math.round((expMid - nowMid) / 86_400_000);
      } else if (company.subscriptionStatus === "trial" && company.trialEndsAt) {
        const nowMid    = Date.UTC(now.getUTCFullYear(),    now.getUTCMonth(),    now.getUTCDate());
        const expMid    = Date.UTC(new Date(company.trialEndsAt).getUTCFullYear(), new Date(company.trialEndsAt).getUTCMonth(), new Date(company.trialEndsAt).getUTCDate());
        daysRemaining   = Math.round((expMid - nowMid) / 86_400_000);
      }

      req.user = {
        id:           req.admin._id.toString(),
        userId:       req.admin._id.toString(),
        companyId:    company._id.toString(),
        role:         req.admin.role,
        name:         req.admin.name,
        daysRemaining,
        expiringSoon: daysRemaining !== null && daysRemaining <= 5 && daysRemaining > 0,
      };

      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, invalid token" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

// ── Company-super_admin gate ──────────────────────────────────────────────────
// Run AFTER protectAdmin. Passes only if caller is the company's super_admin.
// UPDATED: role check uses "super_admin" (was "superadmin")
const requireCompanySuperAdmin = (req, res, next) => {
  if (req.admin && req.admin.role === "super_admin") {
    return next();
  }
  return res.status(403).json({
    message: "Access denied: only the company super_admin can perform this action",
  });
};

module.exports = { protectAdmin, requireCompanySuperAdmin };