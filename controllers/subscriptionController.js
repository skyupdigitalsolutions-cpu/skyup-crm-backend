// controllers/subscriptionController.js — UPDATED
// Changes from original:
//  1. All hardcoded plan checks replaced by getCompanyEntitlements()
//  2. getMySubscriptionStatus now returns full entitlements object
//  3. Added devOverride endpoint logic
//  4. activateSubscription extended: "suspended"/"paused" status + demo credits
//  5. Added getCompanyFullDetails()
//  6. DEFAULT_PLAN_FEATURES extended with "trial" plan + all new limit fields
//  7. Added GET /my/entitlements route handler

const Company    = require("../models/Company");
const PlanConfig = require("../models/PlanConfig");
const CompanyAddon    = require("../models/CompanyAddon");
const CompanyBenefit  = require("../models/CompanyBenefit");
const CompanyUsage    = require("../models/CompanyUsage");
const EntitlementAuditLog = require("../models/EntitlementAuditLog");
const {
  getCompanyEntitlements,
  getRemainingUsage,
  logAudit,
} = require("../services/entitlementService");

// ── Plan feature definitions — single source of truth for fallback ─────────────
// Extended with "trial" plan and all new limit fields from spec.
// Controllers should call getCompanyEntitlements() rather than referencing
// this directly — it is kept here only for activation defaults and backward compat.
const DEFAULT_PLAN_FEATURES = {
  trial: {
    name:    "Trial",
    price:   { monthly: 0, yearly: 0 },
    color:   "#9CA3AF",
    maxAdmins: 1,
    maxUsers:  3,
    maxLeads:  100,
    maxWebsites: 1,
    maxMetaCampaigns: 0,
    maxGoogleAccounts: 0,
    maxStorageMB: 50,
    transcriptionsPerMonth: 0,
    summariesPerMonth: 0,
    voiceBotPerMonth: 0,
    recordingEnabled: false,
    dataRetentionDays: 7,
    features: [
      { key: "leads",          label: "Lead Management",      enabled: true  },
      { key: "contacts",       label: "Contacts",             enabled: true  },
      { key: "basic-reports",  label: "Basic Reports",        enabled: true  },
      { key: "attendance",     label: "Attendance",           enabled: false },
      { key: "daily-report",   label: "Daily Report (Email)", enabled: false },
      { key: "sms-blast",      label: "SMS Blast",            enabled: false },
      { key: "whatsapp-blast", label: "WhatsApp Blast",       enabled: false },
      { key: "email-blast",    label: "Email Blast",          enabled: false },
      { key: "campaigns",      label: "Campaigns",            enabled: false },
      { key: "google-ads",     label: "Google Ads",           enabled: false },
      { key: "meta-ads",       label: "Facebook / Meta Ads",  enabled: false },
      { key: "call-recording", label: "Call Recordings",      enabled: false },
      { key: "api-access",     label: "API / Webhooks",       enabled: false },
      { key: "custom-reports", label: "Custom Reports",       enabled: false },
      { key: "white-label",    label: "White Label",          enabled: false },
    ],
  },
  basic: {
    name:    "Basic",
    price:   { monthly: 999, yearly: 9990 },
    color:   "#6B7280",
    maxAdmins: 1,
    maxUsers:  5,
    maxLeads:  1000,
    maxWebsites: 1,
    maxMetaCampaigns: 1,
    maxGoogleAccounts: 1,
    maxStorageMB: 100,
    transcriptionsPerMonth: 0,
    summariesPerMonth: 0,
    voiceBotPerMonth: 0,
    recordingEnabled: false,
    dataRetentionDays: 15,
    features: [
      { key: "leads",          label: "Lead Management",      enabled: true  },
      { key: "contacts",       label: "Contacts",             enabled: true  },
      { key: "basic-reports",  label: "Basic Reports",        enabled: true  },
      { key: "attendance",     label: "Attendance",           enabled: true  },
      { key: "daily-report",   label: "Daily Report (Email)", enabled: true  },
      { key: "sms-blast",      label: "SMS Blast",            enabled: false },
      { key: "whatsapp-blast", label: "WhatsApp Blast",       enabled: false },
      { key: "email-blast",    label: "Email Blast",          enabled: false },
      { key: "campaigns",      label: "Campaigns",            enabled: false },
      { key: "google-ads",     label: "Google Ads",           enabled: false },
      { key: "meta-ads",       label: "Facebook / Meta Ads",  enabled: false },
      { key: "call-recording", label: "Call Recordings",      enabled: false },
      { key: "api-access",     label: "API / Webhooks",       enabled: false },
      { key: "custom-reports", label: "Custom Reports",       enabled: false },
      { key: "white-label",    label: "White Label",          enabled: false },
    ],
  },
  pro: {
    name:    "Pro",
    price:   { monthly: 2999, yearly: 29990 },
    color:   "#2563EB",
    maxAdmins: 3,
    maxUsers:  20,
    maxLeads:  10000,
    maxWebsites: 3,
    maxMetaCampaigns: 5,
    maxGoogleAccounts: 3,
    maxStorageMB: 5120,
    transcriptionsPerMonth: 200,
    summariesPerMonth: 200,
    voiceBotPerMonth: 100,
    recordingEnabled: true,
    dataRetentionDays: 60,
    features: [
      { key: "leads",          label: "Lead Management",      enabled: true  },
      { key: "contacts",       label: "Contacts",             enabled: true  },
      { key: "basic-reports",  label: "Basic Reports",        enabled: true  },
      { key: "attendance",     label: "Attendance",           enabled: true  },
      { key: "daily-report",   label: "Daily Report (Email)", enabled: true  },
      { key: "sms-blast",      label: "SMS Blast",            enabled: true  },
      { key: "whatsapp-blast", label: "WhatsApp Blast",       enabled: true  },
      { key: "email-blast",    label: "Email Blast",          enabled: true  },
      { key: "campaigns",      label: "Campaigns",            enabled: true  },
      { key: "google-ads",     label: "Google Ads",           enabled: true  },
      { key: "meta-ads",       label: "Facebook / Meta Ads",  enabled: true  },
      { key: "call-recording", label: "Call Recordings",      enabled: true  },
      { key: "api-access",     label: "API / Webhooks",       enabled: true  },
      { key: "custom-reports", label: "Custom Reports",       enabled: false },
      { key: "white-label",    label: "White Label",          enabled: false },
    ],
  },
  enterprise: {
    name:    "Enterprise",
    price:   { monthly: 9999, yearly: 99990 },
    color:   "#7C3AED",
    maxAdmins: 10,
    maxUsers:  999,
    maxLeads:  999999,
    maxWebsites: 999,
    maxMetaCampaigns: 999,
    maxGoogleAccounts: 999,
    maxStorageMB: 51200,
    transcriptionsPerMonth: 2000,
    summariesPerMonth: 2000,
    voiceBotPerMonth: 1000,
    recordingEnabled: true,
    dataRetentionDays: 365,
    features: [
      { key: "leads",          label: "Lead Management",      enabled: true },
      { key: "contacts",       label: "Contacts",             enabled: true },
      { key: "basic-reports",  label: "Basic Reports",        enabled: true },
      { key: "attendance",     label: "Attendance",           enabled: true },
      { key: "daily-report",   label: "Daily Report (Email)", enabled: true },
      { key: "sms-blast",      label: "SMS Blast",            enabled: true },
      { key: "whatsapp-blast", label: "WhatsApp Blast",       enabled: true },
      { key: "email-blast",    label: "Email Blast",          enabled: true },
      { key: "campaigns",      label: "Campaigns",            enabled: true },
      { key: "google-ads",     label: "Google Ads",           enabled: true },
      { key: "meta-ads",       label: "Facebook / Meta Ads",  enabled: true },
      { key: "call-recording", label: "Call Recordings",      enabled: true },
      { key: "api-access",     label: "API / Webhooks",       enabled: true },
      { key: "custom-reports", label: "Custom Reports",       enabled: true },
      { key: "white-label",    label: "White Label",          enabled: true },
    ],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Calendar-accurate days remaining (UTC midnight comparison)
function calcDaysRemaining(company) {
  const now    = new Date();
  let expiry   = null;
  if (["active","suspended","paused"].includes(company.subscriptionStatus) && company.subscriptionExpiry)
    expiry = new Date(company.subscriptionExpiry);
  else if (company.subscriptionStatus === "trial" && company.trialEndsAt)
    expiry = new Date(company.trialEndsAt);
  if (!expiry) return 0;
  const nowMid    = Date.UTC(now.getUTCFullYear(),    now.getUTCMonth(),    now.getUTCDate());
  const expiryMid = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  const diff      = Math.round((expiryMid - nowMid) / 86_400_000);
  return diff > 0 ? diff : 0;
}

// Merge developer-saved planFeatures overrides onto plan defaults
function resolvePlanFeatures(planKey, savedOverrides) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PLAN_FEATURES[planKey] || DEFAULT_PLAN_FEATURES.basic));
  if (!savedOverrides || !Array.isArray(savedOverrides)) return base;
  for (const override of savedOverrides) {
    const feat = base.features.find(f => f.key === override.key);
    if (feat) feat.enabled = !!override.enabled;
  }
  return base;
}

// Resolve actor for audit log
function getActor(req) {
  if (req.developer) return { actorId: req.developer._id, actorRole: "developer" };
  if (req.superAdmin) return { actorId: req.superAdmin._id, actorRole: "super_admin" };
  return { actorId: null, actorRole: "system" };
}

// ── GET /api/subscription/plans ──────────────────────────────────────────────
const getPlans = async (req, res) => {
  try {
    const dbPlans = await PlanConfig.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
    if (dbPlans.length > 0) {
      const plansMap = {};
      for (const p of dbPlans) {
        plansMap[p.planKey] = {
          name:                  p.name,
          price:                 p.price,
          color:                 p.color,
          maxAdmins:             p.maxAdmins,
          maxUsers:              p.maxUsers,
          maxLeads:              p.maxLeads,
          maxWebsites:           p.maxWebsites,
          maxMetaCampaigns:      p.maxMetaCampaigns,
          maxGoogleAccounts:     p.maxGoogleAccounts,
          maxStorageMB:          p.maxStorageMB,
          transcriptionsPerMonth: p.transcriptionsPerMonth,
          summariesPerMonth:     p.summariesPerMonth,
          voiceBotPerMonth:      p.voiceBotPerMonth,
          recordingEnabled:      p.recordingEnabled,
          dataRetentionDays:     p.dataRetentionDays,
          features:              p.features,
        };
      }
      return res.json({ success: true, plans: plansMap });
    }
    res.json({ success: true, plans: DEFAULT_PLAN_FEATURES });
  } catch (err) {
    res.json({ success: true, plans: DEFAULT_PLAN_FEATURES });
  }
};

// ── GET /api/subscription/all ─────────────────────────────────────────────────
const getAllSubscriptions = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limit  = Math.min(100, parseInt(req.query.limit || "50", 10));
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;
    const search = req.query.search?.trim() || null;

    const filter = {};
    if (status && status !== "all") filter.subscriptionStatus = status;
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [result] = await Company.aggregate([
      { $match: filter },
      {
        $facet: {
          total:        [{ $count: "count" }],
          companies: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, email: 1, plan: 1, isActive: 1,
                subscriptionStatus: 1, subscriptionExpiry: 1,
                trialEndsAt: 1, planFeatures: 1, createdAt: 1,
                maxAdmins: 1, maxUsers: 1, maxLeads: 1,
              },
            },
          ],
          statusCounts: [{ $group: { _id: "$subscriptionStatus", count: { $sum: 1 } } }],
        },
      },
    ]);

    const total     = result?.total?.[0]?.count ?? 0;
    const companies = result?.companies ?? [];

    const enriched = companies.map(c => ({
      ...c,
      daysRemaining:    calcDaysRemaining(c),
      resolvedFeatures: resolvePlanFeatures(c.plan, c.planFeatures),
    }));

    const statusSummary = {};
    for (const s of (result?.statusCounts ?? [])) statusSummary[s._id] = s.count;

    res.json({
      success: true,
      companies: enriched,
      pagination: { total, page, pages: Math.ceil(total / limit), limit },
      summary: statusSummary,
    });
  } catch (err) {
    console.error("[getAllSubscriptions]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/activate/:companyId ────────────────────────────────
// Extended: supports "suspended"/"paused" status + grants demo credits on first activation
const activateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { plan, billing = "monthly", durationMonths, status: targetStatus } = req.body;
    const { actorId, actorRole } = getActor(req);

    const validPlans = Object.keys(DEFAULT_PLAN_FEATURES);
    if (plan && !validPlans.includes(plan)) {
      return res.status(400).json({
        success: false,
        message: `Invalid plan. Choose: ${validPlans.join(", ")}`,
      });
    }

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const oldPlan   = company.plan;
    const oldStatus = company.subscriptionStatus;

    const months = Math.max(1, parseInt(durationMonths || (billing === "yearly" ? 12 : 1), 10));
    const now    = new Date();
    const currentExpiry = company.subscriptionExpiry ? new Date(company.subscriptionExpiry) : null;
    const baseDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
    const expiry   = new Date(baseDate);
    expiry.setMonth(expiry.getMonth() + months);

    const finalPlan   = plan || company.plan;
    const planDef     = DEFAULT_PLAN_FEATURES[finalPlan] || DEFAULT_PLAN_FEATURES.basic;
    const finalStatus = ["active","suspended","paused"].includes(targetStatus)
      ? targetStatus
      : "active";

    company.plan               = finalPlan;
    company.subscriptionStatus = finalStatus;
    company.subscriptionExpiry = expiry;
    company.isActive           = finalStatus === "active";
    company.maxAdmins          = planDef.maxAdmins;
    company.maxUsers           = planDef.maxUsers;
    company.maxLeads           = planDef.maxLeads;
    company.maxWebsites        = planDef.maxWebsites;
    company.maxMetaCampaigns   = planDef.maxMetaCampaigns;
    company.maxGoogleAccounts  = planDef.maxGoogleAccounts;
    company.maxStorage         = planDef.maxStorageMB;

    // Grant demo credits on very first activation
    const shouldGrantDemo = !company.demoCreditGranted && finalStatus === "active";
    if (shouldGrantDemo) {
      company.demoCreditGranted = true;
    }

    await company.save();

    // Create demo credit addons (non-blocking)
    if (shouldGrantDemo) {
      setImmediate(async () => {
        try {
          await CompanyAddon.create([
            {
              companyId,
              addonType:     "transcriptions_100",
              quantity:      1,
              startDate:     now,
              expiryDate:    null,
              status:        "active",
              paymentStatus: "free",
              notes:         "Demo credits — granted on first activation",
            },
            {
              companyId,
              addonType:     "summaries_100",
              quantity:      1,
              startDate:     now,
              expiryDate:    null,
              status:        "active",
              paymentStatus: "free",
              notes:         "Demo credits — granted on first activation",
            },
          ]);
          console.log(`[activateSubscription] 🎁 Demo credits granted to ${companyId}`);
        } catch (e) {
          console.error("[activateSubscription] Demo credit grant failed:", e.message);
        }
      });
    }

    await logAudit({
      companyId,
      actorId,
      actorRole,
      action:   "plan_changed",
      field:    "plan",
      oldValue: { plan: oldPlan, status: oldStatus },
      newValue: { plan: finalPlan, status: finalStatus, expiresAt: expiry },
      reason:   `Activated ${finalPlan} for ${months} month(s)`,
    });

    res.json({
      success: true,
      message:       `Subscription activated for ${company.name}`,
      plan:          finalPlan,
      status:        finalStatus,
      expiresAt:     expiry,
      daysRemaining: calcDaysRemaining(company),
      demoCreditGranted: shouldGrantDemo,
    });
  } catch (err) {
    console.error("[activateSubscription]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/subscription/features/:companyId ─────────────────────────────────
const updatePlanFeatures = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { features }  = req.body;
    const { actorId, actorRole } = getActor(req);

    if (!Array.isArray(features)) {
      return res.status(400).json({ success: false, message: "features must be an array" });
    }

    const company = await Company.findByIdAndUpdate(
      companyId,
      { planFeatures: features },
      { new: true }
    ).select("name plan planFeatures");

    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    await logAudit({
      companyId, actorId, actorRole,
      action:   "plan_features_updated",
      newValue: features,
      reason:   "Plan feature overrides updated",
    });

    res.json({
      success:          true,
      message:          `Plan features updated for ${company.name}`,
      resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
    });
  } catch (err) {
    console.error("[updatePlanFeatures]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/cancel/:companyId ─────────────────────────────────
const cancelSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { reason }    = req.body;
    const { actorId, actorRole } = getActor(req);

    const company = await Company.findByIdAndUpdate(
      companyId,
      { subscriptionStatus: "cancelled", isActive: false },
      { new: true }
    ).select("name subscriptionStatus");

    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    await logAudit({
      companyId, actorId, actorRole,
      action:   "subscription_status_changed",
      field:    "subscriptionStatus",
      newValue: "cancelled",
      reason:   reason || "Subscription cancelled",
    });

    res.json({ success: true, message: `Subscription cancelled for ${company.name}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/extend-trial/:companyId ───────────────────────────
const extendTrial = async (req, res) => {
  try {
    const { companyId } = req.params;
    const days = Math.max(1, parseInt(req.body.days || 7, 10));
    const { actorId, actorRole } = getActor(req);

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const base   = company.trialEndsAt && new Date(company.trialEndsAt) > new Date()
      ? new Date(company.trialEndsAt) : new Date();
    const newEnd = new Date(base);
    newEnd.setDate(newEnd.getDate() + days);

    const oldEnd = company.trialEndsAt;
    company.trialEndsAt        = newEnd;
    company.subscriptionStatus = "trial";
    company.isActive           = true;
    await company.save();

    await logAudit({
      companyId, actorId, actorRole,
      action:   "trial_extended",
      field:    "trialEndsAt",
      oldValue: oldEnd,
      newValue: newEnd,
      reason:   `Trial extended by ${days} day(s)`,
    });

    res.json({
      success: true,
      message:       `Trial extended by ${days} days for ${company.name}`,
      newTrialEnd:   newEnd,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/status — for admin panel (backward compat) ──────────
// Now returns full entitlements object from entitlementService
const getMySubscriptionStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id ?? req.admin?.company;
    const company   = await Company.findById(companyId)
      .select("name plan subscriptionStatus subscriptionExpiry trialEndsAt isActive planFeatures");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Auto-suspend check
    const now = new Date();
    if (company.subscriptionStatus === "active" && company.subscriptionExpiry && now > company.subscriptionExpiry) {
      await Company.findByIdAndUpdate(companyId, { subscriptionStatus: "expired", isActive: false });
      company.subscriptionStatus = "expired";
    }
    if (company.subscriptionStatus === "trial" && company.trialEndsAt && now > company.trialEndsAt) {
      await Company.findByIdAndUpdate(companyId, { subscriptionStatus: "expired", isActive: false });
      company.subscriptionStatus = "expired";
    }

    // Get full entitlements from service
    let entitlements = null;
    try {
      entitlements = await getCompanyEntitlements(companyId);
    } catch (_) {
      // Fallback: return resolved features only
    }

    const daysRemaining = calcDaysRemaining(company);

    res.json({
      success: true,
      plan:             company.plan,
      status:           company.subscriptionStatus,
      daysRemaining,
      expiresAt:        company.subscriptionExpiry || company.trialEndsAt,
      expiringSoon:     daysRemaining <= 5 && daysRemaining > 0 && ["active","trial"].includes(company.subscriptionStatus),
      suspended:        ["expired","cancelled","suspended","paused"].includes(company.subscriptionStatus),
      readOnly:         !["active","trial"].includes(company.subscriptionStatus),
      // Full entitlements (new — replaces resolvedFeatures)
      entitlements,
      // Legacy — keep for backward compat with older frontend
      resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/my/entitlements — full entitlements for calling company ──
const getMyEntitlements = async (req, res) => {
  try {
    const companyId =
      req.admin?.company?._id ??
      req.admin?.company ??
      req.user?.companyId ??
      req.user?.company ??
      null;
    if (!companyId) return res.status(400).json({ success: false, message: "Company not found in token" });

    const [entitlements, remaining] = await Promise.all([
      getCompanyEntitlements(companyId),
      getRemainingUsage(companyId),
    ]);

    res.json({ success: true, entitlements, remaining });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/:companyId ─────────────────────────────────────────
const getCompanySubscription = async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId)
      .select("name plan subscriptionStatus subscriptionExpiry trialEndsAt isActive planFeatures");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    let entitlements = null;
    try {
      entitlements = await getCompanyEntitlements(req.params.companyId);
    } catch (_) {}

    res.json({
      success: true,
      company: {
        ...company.toObject(),
        daysRemaining:    calcDaysRemaining(company),
        resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
        entitlements,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/subscription/override/:companyId ─────────────────────────────────
// NEW: Store devOverrides on company (resource limits + feature toggles)
const applyDevOverride = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { actorId, actorRole } = getActor(req);

    const {
      admins, users, leads, websites,
      metaCampaigns, googleAccounts, storageMB,
      featureToggles,
      reason = "",
    } = req.body;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Serialize the current devOverrides to a plain JS object.
    // Explicitly convert featureToggles Map to plain object before spreading.
    const rawOverrides = company.devOverrides?.toObject?.() || company.devOverrides || {};
    const oldOverrides = {
      ...rawOverrides,
      featureToggles: rawOverrides.featureToggles instanceof Map
        ? Object.fromEntries(rawOverrides.featureToggles)
        : (rawOverrides.featureToggles || {}),
    };

    // Build update — only set fields that were explicitly provided
    const newOverrides = { ...oldOverrides };
    if (admins         != null) newOverrides.admins         = parseInt(admins, 10);
    if (users          != null) newOverrides.users          = parseInt(users, 10);
    if (leads          != null) newOverrides.leads          = parseInt(leads, 10);
    if (websites       != null) newOverrides.websites       = parseInt(websites, 10);
    if (metaCampaigns  != null) newOverrides.metaCampaigns  = parseInt(metaCampaigns, 10);
    if (googleAccounts != null) newOverrides.googleAccounts = parseInt(googleAccounts, 10);
    if (storageMB      != null) newOverrides.storageMB      = parseInt(storageMB, 10);
    if (featureToggles && typeof featureToggles === "object") {
      newOverrides.featureToggles = featureToggles;
    }

    company.devOverrides = newOverrides;
    await company.save();

    await logAudit({
      companyId, actorId, actorRole,
      action:   "dev_override_applied",
      field:    "devOverrides",
      oldValue: oldOverrides,
      newValue: newOverrides,
      reason:   reason || "Dev override applied",
    });

    // Return refreshed entitlements after override
    const entitlements = await getCompanyEntitlements(companyId);
    res.json({ success: true, devOverrides: newOverrides, entitlements });
  } catch (err) {
    console.error("[applyDevOverride]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/full/:companyId — for Developer Panel ───────────────
// Returns subscription + usage + addons + benefits + audit log summary
const getCompanyFullDetails = async (req, res) => {
  try {
    const { companyId } = req.params;

    const now   = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const [company, entitlements, addons, benefits, usage, auditLogs] = await Promise.all([
      Company.findById(companyId)
        .select("-brevoApiKey -encryptionKeyHash -customerOpenAiKey -customerGeminiKey")
        .lean(),
      getCompanyEntitlements(companyId),
      CompanyAddon.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyBenefit.find({ companyId }).sort({ createdAt: -1 }).lean(),
      CompanyUsage.findOne({ companyId, month }).lean(),
      EntitlementAuditLog.find({ companyId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    res.json({
      success: true,
      company,
      entitlements,
      addons,
      benefits,
      usage: usage || { month, recordingsUsed: 0, transcriptionsUsed: 0, summariesUsed: 0, voiceBotUsed: 0 },
      auditLogs,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    console.error("[getCompanyFullDetails]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getPlans,
  getAllSubscriptions,
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getCompanySubscription,
  updatePlanFeatures,
  getMySubscriptionStatus,
  getMyEntitlements,
  applyDevOverride,
  getCompanyFullDetails,
  // Keep these exports for other controllers that import them
  DEFAULT_PLAN_FEATURES,
  resolvePlanFeatures,
  calcDaysRemaining,
};
