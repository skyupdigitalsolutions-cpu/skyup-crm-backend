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
  transcriptions_100:  { field: "transcriptionsLimit", delta: 100 },
  transcriptions_500:  { field: "transcriptionsLimit", delta: 500 },
  summaries_100:       { field: "summariesLimit",      delta: 100 },
  summaries_500:       { field: "summariesLimit",      delta: 500 },
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
};

// DEFAULT_PLAN_LIMITS — fallback when PlanConfig record is missing from DB.
// Mirrors the spec and DEFAULT_PLAN_FEATURES in subscriptionController.
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
    },
  },
  basic: {
    admins: 1, users: 5, leads: 1000, websites: 1,
    metaCampaigns: 1, googleAccounts: 1, storageMB: 100,
    transcriptionsPerMonth: 0, summariesPerMonth: 0, voiceBotPerMonth: 0,
    recordingEnabled: false, dataRetentionDays: 15,
    features: {
      leadManagement: true, contacts: true, basicReports: true,
      attendance: true, dailyReport: true, smsBlast: false,
      whatsappBlast: false, emailBlast: false, campaigns: false,
      googleAds: false, metaAds: false, callRecording: false,
      apiAccess: false, customReports: false, whiteLabel: false,
      callTranscription: false, aiSummary: false, voiceBot: false,
      whatsappAutomation: false, webhookAccess: false,
      customDomain: false, customBranding: false,
    },
  },
  pro: {
    admins: 3, users: 20, leads: 10000, websites: 3,
    metaCampaigns: 5, googleAccounts: 3, storageMB: 5120,
    transcriptionsPerMonth: 200, summariesPerMonth: 200, voiceBotPerMonth: 100,
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
    },
  },
  enterprise: {
    admins: 10, users: 999, leads: 999999, websites: 999,
    metaCampaigns: 999, googleAccounts: 999, storageMB: 51200,
    transcriptionsPerMonth: 2000, summariesPerMonth: 2000, voiceBotPerMonth: 1000,
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
  for (const addon of addons) {
    const qty = addon.quantity || 1;

    // Resource addon — add delta × quantity to the numeric limit
    if (RESOURCE_ADDON_DELTA[addon.addonType]) {
      const { field, delta } = RESOURCE_ADDON_DELTA[addon.addonType];
      ent[field] = (ent[field] || 0) + delta * qty;
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
  consumeUsage,
  getRemainingUsage,
  logAudit,
  // Export constants so other modules can reference them
  RESOURCE_ADDON_DELTA,
  FEATURE_ADDON_FLAG,
  DEFAULT_PLAN_LIMITS,
};
