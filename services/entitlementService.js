// services/entitlementService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// THE CORE ENGINE.
//
// getCompanyEntitlements(companyId) → resolves the full entitlements object for
// a company by merging four layers in priority order:
//
//   Plan (PlanConfig)
//     ↓  addon stack (CompanyAddon, active, not expired)
//       ↓  benefit stack (CompanyBenefit, active, not expired)
//         ↓  devOverrides (company.devOverrides — highest priority, always wins)
//
// All controllers / middlewares must call THIS function instead of doing their
// own plan checks.  That eliminates all hardcoded `if plan === "basic"` logic.
//
// Also exports:
//   consumeUsage(companyId, field, amount)  — increments CompanyUsage counter
//   getRemainingUsage(companyId)            — limits minus used this month
//   logAudit(payload)                       — writes EntitlementAuditLog record
// ─────────────────────────────────────────────────────────────────────────────

const mongoose       = require("mongoose");
const Company        = require("../models/Company");
const PlanConfig     = require("../models/PlanConfig");
const CompanyAddon   = require("../models/CompanyAddon");
const CompanyBenefit = require("../models/CompanyBenefit");
const CompanyUsage   = require("../models/CompanyUsage");
const EntitlementAuditLog = require("../models/EntitlementAuditLog");
const { redisClient } = require("../middlewares/rateLimiter");

// ── Entitlement cache (Redis) ─────────────────────────────────────────────────
// getCompanyEntitlements() is called on practically every authenticated
// request (via attachEntitlements / requireFeature / requireNotReadOnly), and
// recomputes by hitting Company + CompanyAddon + CompanyBenefit + PlanConfig
// (4 DB round-trips) every single time. A short TTL cache removes that cost
// for the overwhelming majority of requests, since entitlements rarely change
// request-to-request.
//
// TTL is intentionally short (60s) so a plan/addon/benefit change becomes
// visible quickly even if invalidateEntitlementCache() is missed somewhere.
const ENTITLEMENT_CACHE_TTL_SECONDS = 60;
const entitlementCacheKey = (companyId) => `ent:${companyId}`;

async function getCachedEntitlements(companyId) {
  try {
    if (!redisClient.isReady) return null; // Redis down — fall through to DB
    const cached = await redisClient.get(entitlementCacheKey(companyId));
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    console.error("[entitlements] cache read failed:", err.message);
    return null;
  }
}

async function setCachedEntitlements(companyId, ent) {
  try {
    if (!redisClient.isReady) return; // Redis down — skip silently
    await redisClient.set(
      entitlementCacheKey(companyId),
      JSON.stringify(ent),
      { EX: ENTITLEMENT_CACHE_TTL_SECONDS }
    );
  } catch (err) {
    console.error("[entitlements] cache write failed:", err.message);
  }
}

/**
 * Invalidates the cached entitlements for a company. Call this anywhere a
 * company's plan, addons, benefits, planFeatures, or devOverrides change —
 * e.g. after subscription upgrade/downgrade, addon purchase/cancel, benefit
 * grant/revoke, or a developer devOverride edit — so the next request
 * recomputes fresh instead of serving stale data for up to the TTL window.
 *
 * @param {string|ObjectId} companyId
 */
async function invalidateEntitlementCache(companyId) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.del(entitlementCacheKey(companyId));
  } catch (err) {
    console.error("[entitlements] cache invalidate failed:", err.message);
  }
}

// ── Addon / Benefit → entitlement delta maps ──────────────────────────────────
// Resource addons — each unit added to the numeric limit
const RESOURCE_ADDON_DELTA = {
  extra_admin:         { field: "admins",         delta: 1     },
  extra_users_5:       { field: "users",          delta: 5     },
  extra_leads_5000:    { field: "leads",          delta: 5000  },
  extra_website:       { field: "websites",       delta: 1     },
  extra_meta_campaign: { field: "metaCampaigns",  delta: 1     },
  extra_google_account:{ field: "googleAccounts", delta: 1     },
  storage_1gb:         { field: "storageMB",      delta: 1024  },
  storage_5gb:         { field: "storageMB",      delta: 5120  },
  storage_10gb:        { field: "storageMB",      delta: 10240 },
  // ── Retired credit packs (NOT sold any more) ─────────────────────────────
  // These old single-pool packs are kept ONLY so any company that already
  // purchased/was granted one before retirement keeps working (renew/disable,
  // entitlement calc). They are not in the catalog or any picker. New sales use
  // the combined minute pack in MULTI_FIELD_ADDON_DELTA below.
  transcriptions_100:  { field: "transcriptionsLimit", delta: 100 },
  transcriptions_500:  { field: "transcriptionsLimit", delta: 500 },
  summaries_100:       { field: "summariesLimit",      delta: 100 },
  summaries_500:       { field: "summariesLimit",      delta: 500 },
  transcriptions_5000mins:  { field: "transcriptionsLimit", delta: 5000  },
  transcriptions_20000mins: { field: "transcriptionsLimit", delta: 20000 },
  summaries_5000mins:       { field: "summariesLimit",      delta: 5000  },
  summaries_20000mins:      { field: "summariesLimit",      delta: 20000 },
};

// Multi-field addons — a single addonType that bumps more than one entitlement
// field at once. The combined AI minute pack is the only credit pack sold now:
// one purchase adds the same number of MINUTES to BOTH the transcription and
// summary monthly pools (1 unit = 1 minute in each). quantity multiplies it, so
// buying ×2 of the 100-min pack gives +200 to each pool.
const MULTI_FIELD_ADDON_DELTA = {
  transcription_summary_100mins: [
    { field: "transcriptionsLimit", delta: 100 },
    { field: "summariesLimit",      delta: 100 },
  ],
};

// Feature addons — unlock a boolean flag
const FEATURE_ADDON_FLAG = {
  call_recording:      "callRecording",
  call_transcription:  "callTranscription",
  ai_summary:          "aiSummary",
  voice_bot:           "voiceBot",
  whatsapp_automation: "whatsappAutomation",
  api_access:          "apiAccess",
  webhook_access:      "webhookAccess",
  white_label:         "whiteLabel",
  custom_domain:       "customDomain",
  custom_branding:     "customBranding",
};

// Feature key map — PlanConfig feature keys → entitlements keys
const PLAN_FEATURE_KEY_MAP = {
  "leads":          "leadManagement",
  "contacts":       "contacts",
  "basic-reports":  "basicReports",
  "attendance":     "attendance",
  "daily-report":   "dailyReport",
  "sms-blast":      "smsBlast",
  "whatsapp-blast": "whatsappBlast",
  "email-blast":    "emailBlast",
  "campaigns":      "campaigns",
  "google-ads":     "googleAds",
  "meta-ads":       "metaAds",
  "call-recording": "callRecording",
  "api-access":     "apiAccess",
  "custom-reports": "customReports",
  "white-label":    "whiteLabel",
  // Extended features — so plan-level toggles map to the same entitlement keys
  // used by addons / benefits / devOverrides (otherwise these silently no-op).
  "call-transcription":  "callTranscription",
  "ai-summary":          "aiSummary",
  "voice-bot":           "voiceBot",
  "whatsapp-automation": "whatsappAutomation",
  "webhook-access":      "webhookAccess",
  "custom-domain":       "customDomain",
  "custom-branding":     "customBranding",
  // NEW: Operations features
  "projects":            "projects",
  "tasks":               "tasks",
  "payroll":             "payroll",
  "website-tracking":    "websiteTracking",
  "telegram-notification": "telegramNotification",
};

// DEFAULT_PLAN_LIMITS — fallback when PlanConfig record is missing from DB.
// Mirrors the spec and DEFAULT_PLAN_FEATURES in subscriptionController.
//
// PLAN STRUCTURE (kept in sync with subscriptionController.DEFAULT_PLAN_FEATURES
// and the frontend UpgradePlan.PLAN_DEFAULTS):
//   • The MOBILE APP (dashboard, notifications, reports, lead management, daily
//     report, attendance, live employee status) is included on EVERY paid plan
//     and is NOT a toggleable feature — the corresponding feature flags below
//     (leadManagement, attendance, dailyReport, basicReports) are always true.
//   • COMMUNICATION = the 3 blasts (email/whatsapp/sms) — Pro, Advance, Enterprise.
//   • TELEGRAM NOTIFICATION — toggleable; Pro, Advance, Enterprise.
//   • transcriptionsPerMonth / summariesPerMonth are expressed in MINUTES/month
//     of call transcription + summary (0 = not available on this plan).
//   • ENTERPRISE is a fully-custom "Contact us" tier: unlimited defaults here,
//     tailored per company by the developer via PlanConfig / devOverrides.
const DEFAULT_PLAN_LIMITS = {
  trial: {
    admins: 1, users: 3, leads: 100, websites: 1,
    metaCampaigns: 0, googleAccounts: 0, storageMB: 50,
    transcriptionsPerMonth: 0, summariesPerMonth: 0, voiceBotPerMonth: 0,
    recordingEnabled: false, dataRetentionDays: 7,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: false, dailyReport: false, smsBlast: false,
      whatsappBlast: false, emailBlast: false, campaigns: false,
      googleAds: false, metaAds: false, callRecording: false,
      apiAccess: false, customReports: false, whiteLabel: false,
      callTranscription: false, aiSummary: false, voiceBot: false,
      whatsappAutomation: false, webhookAccess: false,
      customDomain: false, customBranding: false,
      projects: false, tasks: false, payroll: false, websiteTracking: false,
      telegramNotification: false,
    },
  },
  // BASIC — mobile app + core CRM. 1 admin, 5 users, 1000 leads,
  // 1 meta / 1 website / 1 google. No communication blasts, no telegram, no AI.
  basic: {
    admins: 1, users: 5, leads: 1000, websites: 1,
    metaCampaigns: 1, googleAccounts: 1, storageMB: 100,
    transcriptionsPerMonth: 0, summariesPerMonth: 0, voiceBotPerMonth: 0,
    recordingEnabled: false, dataRetentionDays: 15,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: true, dailyReport: true, smsBlast: false,
      whatsappBlast: false, emailBlast: false, campaigns: true,
      googleAds: true, metaAds: true, callRecording: false,
      apiAccess: false, customReports: false, whiteLabel: false,
      callTranscription: false, aiSummary: false, voiceBot: false,
      whatsappAutomation: false, webhookAccess: false,
      customDomain: false, customBranding: false,
      projects: false, tasks: false, payroll: false, websiteTracking: true,
      telegramNotification: false,
    },
  },
  // PRO — everything in Basic + Communication (3 blasts) + Telegram +
  // 6000 min transcription/summary. 3 admins, 20 users, 2000 leads,
  // 3 meta / 3 website / 3 google.
  pro: {
    admins: 3, users: 20, leads: 2000, websites: 3,
    metaCampaigns: 3, googleAccounts: 3, storageMB: 5120,
    transcriptionsPerMonth: 6000, summariesPerMonth: 6000, voiceBotPerMonth: 100,
    recordingEnabled: true, dataRetentionDays: 60,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: true, dailyReport: true, smsBlast: true,
      whatsappBlast: true, emailBlast: true, campaigns: true,
      googleAds: true, metaAds: true, callRecording: true,
      apiAccess: true, customReports: false, whiteLabel: false,
      callTranscription: true, aiSummary: true, voiceBot: false,
      whatsappAutomation: true, webhookAccess: true,
      customDomain: false, customBranding: false,
      projects: true, tasks: true, payroll: false, websiteTracking: true,
      telegramNotification: true,
    },
  },
  // ADVANCE — everything in Pro, larger limits + 15000 min transcription/summary.
  // 5 admins, 50 users, 5000 leads, 5 meta / 5 website / 5 google.
  advance: {
    admins: 5, users: 50, leads: 5000, websites: 5,
    metaCampaigns: 5, googleAccounts: 5, storageMB: 51200,
    transcriptionsPerMonth: 15000, summariesPerMonth: 15000, voiceBotPerMonth: 1000,
    recordingEnabled: true, dataRetentionDays: 365,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: true, dailyReport: true, smsBlast: true,
      whatsappBlast: true, emailBlast: true, campaigns: true,
      googleAds: true, metaAds: true, callRecording: true,
      apiAccess: true, customReports: true, whiteLabel: true,
      callTranscription: true, aiSummary: true, voiceBot: true,
      whatsappAutomation: true, webhookAccess: true,
      customDomain: true, customBranding: true,
      projects: true, tasks: true, payroll: true, websiteTracking: true,
      telegramNotification: true,
    },
  },
  // Custom "Contact us" tier. Unlimited ceiling by default — the developer
  // tailors each enterprise company via devOverrides / PlanConfig.
  enterprise: {
    admins: 999, users: 999, leads: 999999, websites: 999,
    metaCampaigns: 999, googleAccounts: 999, storageMB: 512000,
    transcriptionsPerMonth: 999999, summariesPerMonth: 999999, voiceBotPerMonth: 999999,
    recordingEnabled: true, dataRetentionDays: 3650,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: true, dailyReport: true, smsBlast: true,
      whatsappBlast: true, emailBlast: true, campaigns: true,
      googleAds: true, metaAds: true, callRecording: true,
      apiAccess: true, customReports: true, whiteLabel: true,
      callTranscription: true, aiSummary: true, voiceBot: true,
      whatsappAutomation: true, webhookAccess: true,
      customDomain: true, customBranding: true,
      projects: true, tasks: true, payroll: true, websiteTracking: true,
      telegramNotification: true,
    },
  },
};

// ── Helper — current YYYY-MM string ──────────────────────────────────────────
function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── getCompanyEntitlements ────────────────────────────────────────────────────
/**
 * Returns the fully resolved entitlements for a company.
 *
 * Merge order (lowest → highest priority):
 *   1. PlanConfig (or DEFAULT_PLAN_LIMITS fallback)
 *   2. Active CompanyAddons
 *   3. Active CompanyBenefits
 *   4. company.devOverrides  (developer can override anything)
 *
 * @param {string|ObjectId} companyId
 * @returns {Promise<Object>} entitlements
 */
async function getCompanyEntitlements(companyId) {
  const idStr = String(companyId);

  // ── 0. Serve from cache if present ─────────────────────────────────────────
  const cached = await getCachedEntitlements(idStr);
  if (cached) return cached;

  // ── 1. Load company + active addons + active benefits in parallel ──────────
  const now = new Date();

  const [company, addons, benefits] = await Promise.all([
    Company.findById(companyId).lean(),
    CompanyAddon.find({
      companyId,
      status: "active",
      $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }],
    }).lean(),
    CompanyBenefit.find({
      companyId,
      active: true,
      $or: [{ validUntil: null }, { validUntil: { $gt: now } }],
    }).lean(),
  ]);

  if (!company) throw new Error(`Company ${companyId} not found`);

  // ── 2. Base limits from PlanConfig (or fallback) ──────────────────────────
  let planLimits = DEFAULT_PLAN_LIMITS[company.plan] || DEFAULT_PLAN_LIMITS.trial;

  try {
    const dbPlan = await PlanConfig.findOne({ planKey: company.plan, isActive: true }).lean();
    if (dbPlan) {
      // Build feature map from DB plan features array
      const dbFeatures = {};
      for (const f of dbPlan.features || []) {
        const mapped = PLAN_FEATURE_KEY_MAP[f.key] || f.key;
        dbFeatures[mapped] = f.enabled;
      }
      planLimits = {
        admins:                 dbPlan.maxAdmins              ?? planLimits.admins,
        users:                  dbPlan.maxUsers               ?? planLimits.users,
        leads:                  dbPlan.maxLeads               ?? planLimits.leads,
        websites:               dbPlan.maxWebsites            ?? planLimits.websites,
        metaCampaigns:          dbPlan.maxMetaCampaigns        ?? planLimits.metaCampaigns,
        googleAccounts:         dbPlan.maxGoogleAccounts       ?? planLimits.googleAccounts,
        storageMB:              dbPlan.maxStorageMB            ?? planLimits.storageMB,
        transcriptionsPerMonth: dbPlan.transcriptionsPerMonth  ?? planLimits.transcriptionsPerMonth,
        summariesPerMonth:      dbPlan.summariesPerMonth       ?? planLimits.summariesPerMonth,
        voiceBotPerMonth:       dbPlan.voiceBotPerMonth        ?? planLimits.voiceBotPerMonth,
        recordingEnabled:       dbPlan.recordingEnabled        ?? planLimits.recordingEnabled,
        dataRetentionDays:      dbPlan.dataRetentionDays       ?? planLimits.dataRetentionDays,
        features: { ...planLimits.features, ...dbFeatures },
      };
    }
  } catch (_) {
    // DB unavailable — use fallback silently
  }

  // Mutable entitlements object — layers will be applied on top
  const ent = {
    // Numeric resource limits
    admins:         planLimits.admins,
    users:          planLimits.users,
    leads:          planLimits.leads,
    websites:       planLimits.websites,
    metaCampaigns:  planLimits.metaCampaigns,
    googleAccounts: planLimits.googleAccounts,
    storageMB:      planLimits.storageMB,

    // Monthly AI quotas (plan base — addons/benefits add on top)
    transcriptionsLimit: planLimits.transcriptionsPerMonth,
    summariesLimit:      planLimits.summariesPerMonth,
    voiceBotLimit:       planLimits.voiceBotPerMonth,

    // Feature flags from plan
    ...planLimits.features,

    // ── Company-scoped features (default OFF for everyone; enabled per
    //    company only via devOverrides.featureToggles from Developer panel) ──
    leadNurtureSequence: false,
    callOutcomesReport:  false,

    // Recording / retention meta
    recordingEnabled:  planLimits.recordingEnabled,
    dataRetentionDays: planLimits.dataRetentionDays,

    // Subscription state
    subscriptionStatus: company.subscriptionStatus,
    readOnly: !["active", "trial"].includes(company.subscriptionStatus),
  };

  // Apply company.planFeatures overrides (legacy per-company feature toggles)
  if (Array.isArray(company.planFeatures)) {
    for (const override of company.planFeatures) {
      const mapped = PLAN_FEATURE_KEY_MAP[override.key] || override.key;
      if (mapped in ent) ent[mapped] = !!override.enabled;
    }
  }

  // ── 3. Apply addon stack ──────────────────────────────────────────────────
  // Pre-fetch grant specs for any CUSTOM addons present (custom_* types created
  // by the developer). Built-in types use the hardcoded maps above; custom ones
  // store their {field, delta} on the AddonCatalog record.
  const customTypes = [
    ...new Set([
      ...addons.map((a) => a.addonType),
      ...benefits.map((b) => b.benefitType),
    ].filter((t) => typeof t === "string" && t.startsWith("custom_"))),
  ];
  const customGrants = {};
  if (customTypes.length) {
    try {
      const AddonCatalog = require("../models/AddonCatalog");
      const rows = await AddonCatalog.find({ addonType: { $in: customTypes } })
        .select("addonType grant").lean();
      for (const r of rows) {
        if (r.grant && r.grant.field && r.grant.delta) {
          customGrants[r.addonType] = { field: r.grant.field, delta: r.grant.delta };
        }
      }
    } catch (e) {
      console.error("[entitlements] custom addon grant lookup failed:", e.message);
    }
  }

  for (const addon of addons) {
    const qty = addon.quantity || 1;

    // Resource addon — add delta × quantity to the numeric limit
    if (RESOURCE_ADDON_DELTA[addon.addonType]) {
      const { field, delta } = RESOURCE_ADDON_DELTA[addon.addonType];
      ent[field] = (ent[field] || 0) + delta * qty;
    }

    // Custom resource addon — grant comes from the catalog record.
    if (customGrants[addon.addonType]) {
      const { field, delta } = customGrants[addon.addonType];
      ent[field] = (ent[field] || 0) + delta * qty;
    }

    // Multi-field addon — e.g. the combined transcription+summary minute pack
    // bumps BOTH pools from one addonType.
    if (MULTI_FIELD_ADDON_DELTA[addon.addonType]) {
      for (const { field, delta } of MULTI_FIELD_ADDON_DELTA[addon.addonType]) {
        ent[field] = (ent[field] || 0) + delta * qty;
      }
    }

    // Feature addon — unlock the boolean flag
    if (FEATURE_ADDON_FLAG[addon.addonType]) {
      ent[FEATURE_ADDON_FLAG[addon.addonType]] = true;
    }
  }

  // ── 4. Apply benefit stack (same logic, additive on top of addons) ────────
  for (const benefit of benefits) {
    const qty = benefit.quantity || 1;

    if (RESOURCE_ADDON_DELTA[benefit.benefitType]) {
      const { field, delta } = RESOURCE_ADDON_DELTA[benefit.benefitType];
      ent[field] = (ent[field] || 0) + delta * qty;
    }

    if (customGrants[benefit.benefitType]) {
      const { field, delta } = customGrants[benefit.benefitType];
      ent[field] = (ent[field] || 0) + delta * qty;
    }

    if (MULTI_FIELD_ADDON_DELTA[benefit.benefitType]) {
      for (const { field, delta } of MULTI_FIELD_ADDON_DELTA[benefit.benefitType]) {
        ent[field] = (ent[field] || 0) + delta * qty;
      }
    }

    if (FEATURE_ADDON_FLAG[benefit.benefitType]) {
      ent[FEATURE_ADDON_FLAG[benefit.benefitType]] = true;
    }
  }

  // ── 5. Apply devOverrides — highest priority, always wins ─────────────────
  const overrides = company.devOverrides || {};

  if (overrides.admins         != null) ent.admins         = overrides.admins;
  if (overrides.users          != null) ent.users          = overrides.users;
  if (overrides.leads          != null) ent.leads          = overrides.leads;
  if (overrides.websites       != null) ent.websites       = overrides.websites;
  if (overrides.metaCampaigns  != null) ent.metaCampaigns  = overrides.metaCampaigns;
  if (overrides.googleAccounts != null) ent.googleAccounts = overrides.googleAccounts;
  if (overrides.storageMB      != null) ent.storageMB      = overrides.storageMB;

  // NEW: per-company AI / feature LIMIT overrides (highest priority, always win).
  // null = inherit the plan+addon value; a number = absolute cap for this company.
  if (overrides.transcriptionsLimit != null) ent.transcriptionsLimit = overrides.transcriptionsLimit;
  if (overrides.summariesLimit      != null) ent.summariesLimit      = overrides.summariesLimit;
  if (overrides.voiceBotLimit       != null) ent.voiceBotLimit       = overrides.voiceBotLimit;
  if (overrides.recordingEnabled    != null) ent.recordingEnabled    = !!overrides.recordingEnabled;

  // Feature toggles from devOverrides (Map<String, Boolean>)
  if (overrides.featureToggles) {
    const toggles = overrides.featureToggles instanceof Map
      ? Object.fromEntries(overrides.featureToggles)
      : overrides.featureToggles;

    for (const [key, value] of Object.entries(toggles)) {
      ent[key] = !!value;
    }
  }

  // Re-derive readOnly after all overrides (devOverride cannot change subscriptionStatus directly)
  ent.readOnly = !["active", "trial"].includes(ent.subscriptionStatus);

  // ── 6. Write through to cache for subsequent requests ──────────────────────
  await setCachedEntitlements(idStr, ent);

  return ent;
}

// ── consumeUsage ──────────────────────────────────────────────────────────────
/**
 * Atomically increments a usage counter for the current month.
 * Creates the CompanyUsage document if it does not yet exist (upsert).
 *
 * @param {string|ObjectId} companyId
 * @param {"recordingsUsed"|"transcriptionsUsed"|"summariesUsed"|"voiceBotUsed"} field
 * @param {number} amount — defaults to 1
 * @returns {Promise<CompanyUsage>}
 */
async function consumeUsage(companyId, field, amount = 1) {
  const ALLOWED = ["recordingsUsed", "transcriptionsUsed", "summariesUsed", "voiceBotUsed"];
  if (!ALLOWED.includes(field)) {
    throw new Error(`consumeUsage: unknown field "${field}"`);
  }

  const month = currentMonth();
  const doc = await CompanyUsage.findOneAndUpdate(
    { companyId, month },
    { $inc: { [field]: amount } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

// ── getRemainingUsage ─────────────────────────────────────────────────────────
/**
 * Returns how many AI units are left this month (limit − used).
 * Includes demo credits (stored as free addon packs in CompanyAddon).
 *
 * @param {string|ObjectId} companyId
 * @returns {Promise<{ transcriptions: number, summaries: number, voiceBot: number, recordings: number }>}
 */
async function getRemainingUsage(companyId) {
  const month = currentMonth();

  const [ent, usage] = await Promise.all([
    getCompanyEntitlements(companyId),
    CompanyUsage.findOne({ companyId, month }).lean(),
  ]);

  const used = usage || {};

  return {
    transcriptions: Math.max(0, ent.transcriptionsLimit - (used.transcriptionsUsed || 0)),
    summaries:      Math.max(0, ent.summariesLimit      - (used.summariesUsed      || 0)),
    voiceBot:       Math.max(0, ent.voiceBotLimit       - (used.voiceBotUsed       || 0)),
    recordings:     Math.max(0, (ent.recordingEnabled ? 9999 : 0) - (used.recordingsUsed || 0)),
    // Raw used values for display
    used: {
      transcriptions: used.transcriptionsUsed || 0,
      summaries:      used.summariesUsed      || 0,
      voiceBot:       used.voiceBotUsed       || 0,
      recordings:     used.recordingsUsed     || 0,
    },
    limits: {
      transcriptions: ent.transcriptionsLimit,
      summaries:      ent.summariesLimit,
      voiceBot:       ent.voiceBotLimit,
    },
  };
}

// ── logAudit ──────────────────────────────────────────────────────────────────
/**
 * Writes an immutable EntitlementAuditLog record.
 * Never throws — audit failure should not break the main action.
 *
 * @param {Object} payload
 * @param {string|ObjectId} payload.companyId
 * @param {string|ObjectId} [payload.actorId]
 * @param {"developer"|"super_admin"|"system"} [payload.actorRole]
 * @param {string} payload.action
 * @param {string} [payload.field]
 * @param {*} [payload.oldValue]
 * @param {*} [payload.newValue]
 * @param {string} [payload.reason]
 */
async function logAudit(payload) {
  try {
    await EntitlementAuditLog.create({
      companyId:  payload.companyId,
      actorId:    payload.actorId   || null,
      actorRole:  payload.actorRole || "system",
      action:     payload.action,
      field:      payload.field     || "",
      oldValue:   payload.oldValue  ?? null,
      newValue:   payload.newValue  ?? null,
      reason:     payload.reason    || "",
    });
  } catch (err) {
    console.error("[logAudit] failed to write audit log:", err.message);
  }
}

module.exports = {
  getCompanyEntitlements,
  invalidateEntitlementCache,
  consumeUsage,
  getRemainingUsage,
  logAudit,
  // Export constants so other modules can reference them
  RESOURCE_ADDON_DELTA,
  MULTI_FIELD_ADDON_DELTA,
  FEATURE_ADDON_FLAG,
  DEFAULT_PLAN_LIMITS,
};
