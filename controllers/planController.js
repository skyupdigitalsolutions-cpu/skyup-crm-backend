// controllers/planController.js
// Developer-only CRUD for plan configurations.
// Plans created here are read by subscriptionController.getPlans
// and drive the upgrade page and feature-gate system.
//
// ADDED: getPlansConfig / savePlansConfig
//   GET  /api/developer/plans/config  — returns flat { basic, pro, enterprise } shape
//   POST /api/developer/plans/config  — accepts the same flat shape and upserts each plan
//   These endpoints are consumed by PlanCustomization.jsx on the developer frontend.

const PlanConfig = require('../models/PlanConfig');
const { DEFAULT_PLAN_FEATURES } = require('./subscriptionController');

// Full feature catalogue (key + label) used when persisting plan feature flags.
// MUST stay in sync with ALL_FEATURES in PlanCustomization.jsx and the
// PLAN_FEATURE_KEY_MAP in entitlementService.js. Listing every feature here
// ensures none are silently dropped on save (the old code only knew 15).
const FEATURE_CATALOG = [
  { key: 'leads',               label: 'Lead Management'     },
  { key: 'contacts',            label: 'Contacts'            },
  { key: 'basic-reports',       label: 'Basic Reports'       },
  { key: 'attendance',          label: 'Attendance'          },
  { key: 'daily-report',        label: 'Daily Report'        },
  { key: 'sms-blast',           label: 'SMS Blast'           },
  { key: 'whatsapp-blast',      label: 'WhatsApp Blast'      },
  { key: 'email-blast',         label: 'Email Blast'         },
  { key: 'campaigns',           label: 'Campaigns'           },
  { key: 'google-ads',          label: 'Google Ads'          },
  { key: 'meta-ads',            label: 'Meta Ads'            },
  { key: 'call-recording',      label: 'Call Recording'      },
  { key: 'call-transcription',  label: 'Call Transcription'  },
  { key: 'ai-summary',          label: 'AI Summary'          },
  { key: 'whatsapp-automation', label: 'WhatsApp Automation' },
  // Operations features
  { key: 'projects',            label: 'Projects'            },
  { key: 'tasks',               label: 'Tasks'               },
  { key: 'payroll',             label: 'Payroll'             },
  { key: 'website-tracking',    label: 'Website Tracking'    },
];

// ── Seed helper — called lazily on first GET /plans so the DB always
//    has the three default plans even on a fresh install. ─────────────────────
async function seedDefaultsIfEmpty() {
  const count = await PlanConfig.countDocuments();
  if (count > 0) return;

  const seeds = Object.entries(DEFAULT_PLAN_FEATURES).map(([key, plan], idx) => ({
    planKey:     key,
    name:        plan.name,
    description: '',
    color:       plan.color,
    price:       plan.price,
    maxUsers:    plan.maxUsers,
    maxLeads:    plan.maxLeads,
    features:    plan.features,
    sortOrder:   idx,
    isActive:    true,
  }));

  await PlanConfig.insertMany(seeds);
  console.log('[planController] Seeded', seeds.length, 'default plans from hardcoded defaults.');
}

// ── GET /api/developer/plans ──────────────────────────────────────────────────
const getPlans = async (req, res) => {
  try {
    await seedDefaultsIfEmpty();
    const plans = await PlanConfig.find().sort({ sortOrder: 1, createdAt: 1 });
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/developer/plans ─────────────────────────────────────────────────
const createPlan = async (req, res) => {
  try {
    const { planKey, name, description, color, price, maxUsers, maxAdmins, maxLeads, features, sortOrder, isActive } = req.body;

    if (!planKey || !name) {
      return res.status(400).json({ success: false, message: 'planKey and name are required.' });
    }

    // Normalise planKey to lowercase slug
    const slug = planKey.trim().toLowerCase().replace(/\s+/g, '-');

    const existing = await PlanConfig.findOne({ planKey: slug });
    if (existing) {
      return res.status(400).json({ success: false, message: `A plan with key "${slug}" already exists.` });
    }

    const plan = await PlanConfig.create({
      planKey:     slug,
      name:        name.trim(),
      description: description?.trim() || '',
      color:       color || '#6B7280',
      price: {
        monthly: Number(price?.monthly ?? 0),
        yearly:  Number(price?.yearly  ?? 0),
      },
      maxUsers:  Number(maxUsers  ?? 5),
      maxAdmins: Number(maxAdmins ?? 2),
      maxLeads:  Number(maxLeads  ?? 1000),
      features: features || [],
      sortOrder: Number(sortOrder ?? 99),
      isActive:  isActive !== undefined ? Boolean(isActive) : true,
    });

    res.status(201).json({ success: true, plan });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'A plan with this key already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/developer/plans/:id ──────────────────────────────────────────────
const updatePlan = async (req, res) => {
  try {
    const plan = await PlanConfig.findById(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });

    const {
      name, description, color, price,
      maxUsers, maxAdmins, maxLeads,
      maxWebsites, maxMetaCampaigns, maxGoogleAccounts, maxStorageMB,
      transcriptionsPerMonth, summariesPerMonth, voiceBotPerMonth,
      recordingEnabled, dataRetentionDays,
      features, sortOrder, isActive,
    } = req.body;

    if (name        !== undefined) plan.name        = name.trim();
    if (description !== undefined) plan.description = description.trim();
    if (color       !== undefined) plan.color        = color;
    if (maxUsers    !== undefined) plan.maxUsers     = Number(maxUsers);
    if (maxAdmins   !== undefined) plan.maxAdmins    = Number(maxAdmins);
    if (maxLeads    !== undefined) plan.maxLeads     = Number(maxLeads);
    // Extended resource limits
    if (maxWebsites       !== undefined) plan.maxWebsites       = Number(maxWebsites);
    if (maxMetaCampaigns  !== undefined) plan.maxMetaCampaigns  = Number(maxMetaCampaigns);
    if (maxGoogleAccounts !== undefined) plan.maxGoogleAccounts = Number(maxGoogleAccounts);
    if (maxStorageMB      !== undefined) plan.maxStorageMB      = Number(maxStorageMB);
    // AI quotas
    if (transcriptionsPerMonth !== undefined) plan.transcriptionsPerMonth = Number(transcriptionsPerMonth);
    if (summariesPerMonth      !== undefined) plan.summariesPerMonth      = Number(summariesPerMonth);
    if (voiceBotPerMonth       !== undefined) plan.voiceBotPerMonth       = Number(voiceBotPerMonth);
    // Flags
    if (recordingEnabled  !== undefined) plan.recordingEnabled  = Boolean(recordingEnabled);
    if (dataRetentionDays !== undefined) plan.dataRetentionDays = Number(dataRetentionDays);

    if (features  !== undefined) plan.features  = features;
    if (sortOrder !== undefined) plan.sortOrder  = Number(sortOrder);
    if (isActive  !== undefined) plan.isActive   = Boolean(isActive);

    if (price !== undefined) {
      plan.price = {
        monthly: Number(price.monthly ?? plan.price.monthly),
        yearly:  Number(price.yearly  ?? plan.price.yearly),
      };
    }

    await plan.save();
    res.json({ success: true, plan });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/developer/plans/:id ──────────────────────────────────────────
const deletePlan = async (req, res) => {
  try {
    const plan = await PlanConfig.findById(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    await plan.deleteOne();
    res.json({ success: true, message: `Plan "${plan.name}" deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/developer/plans/:id ─────────────────────────────────────────────
const getPlan = async (req, res) => {
  try {
    const plan = await PlanConfig.findById(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    res.json({ success: true, plan });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW: getPlansConfig
// GET /api/developer/plans/config
// Returns plans as a flat object keyed by planKey:
//   { basic: { name, monthlyPrice, yearlyPrice, maxUsers, maxLeads, maxAdmins, features }, ... }
// This is the shape PlanCustomization.jsx expects.
// ─────────────────────────────────────────────────────────────────────────────
const getPlansConfig = async (req, res) => {
  try {
    await seedDefaultsIfEmpty();
    const dbPlans = await PlanConfig.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });

    const config = {};
    for (const p of dbPlans) {
      config[p.planKey] = {
        name:         p.name,
        monthlyPrice: p.price?.monthly ?? 0,
        yearlyPrice:  p.price?.yearly  ?? 0,
        maxUsers:     p.maxUsers,
        maxAdmins:    p.maxAdmins,
        maxLeads:     p.maxLeads,

        // Extended resource limits
        maxWebsites:       p.maxWebsites,
        maxMetaCampaigns:  p.maxMetaCampaigns,
        maxGoogleAccounts: p.maxGoogleAccounts,
        maxStorageMB:      p.maxStorageMB,

        // AI / transcription monthly quotas (0 = feature not available on the plan)
        transcriptionsPerMonth: p.transcriptionsPerMonth,
        summariesPerMonth:      p.summariesPerMonth,
        voiceBotPerMonth:       p.voiceBotPerMonth,

        // Flags
        recordingEnabled:  p.recordingEnabled,
        dataRetentionDays: p.dataRetentionDays,

        // features is stored as [{ key, label, enabled }] in DB;
        // PlanCustomization expects a plain string[] of enabled keys.
        features: Array.isArray(p.features)
          ? p.features.filter(f => f.enabled).map(f => f.key)
          : [],
      };
    }

    res.json(config);
  } catch (err) {
    console.error('[getPlansConfig]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW: savePlansConfig
// POST /api/developer/plans/config
// Accepts the flat config object from PlanCustomization.jsx and upserts each
// plan into PlanConfig. Creates the plan if it doesn't exist.
// Body: { basic: { name, monthlyPrice, yearlyPrice, maxUsers, maxLeads, maxAdmins, features }, ... }
// ─────────────────────────────────────────────────────────────────────────────
const savePlansConfig = async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, message: 'Body must be a plan config object.' });
    }

    const results = [];

    for (const [planKey, cfg] of Object.entries(body)) {
      if (!cfg || typeof cfg !== 'object') continue;

      const slug = planKey.trim().toLowerCase();

      // Build the features array in the DB format [{ key, label, enabled }]
      // We pull existing feature definitions from the DB (or defaults) and
      // overlay the enabled/disabled state from the incoming string[] of enabled keys.
      const enabledSet = new Set(Array.isArray(cfg.features) ? cfg.features : []);

      // Use the FULL catalogue (22 features) so none are dropped on save.
      const featuresDoc = FEATURE_CATALOG.map(f => ({
        key:     f.key,
        label:   f.label,
        enabled: enabledSet.has(f.key),
      }));

      const update = {
        name:      cfg.name     || slug,
        isActive:  true,
        price: {
          monthly: Number(cfg.monthlyPrice ?? 0),
          yearly:  Number(cfg.yearlyPrice  ?? 0),
        },
        maxUsers:  Number(cfg.maxUsers  ?? 5),
        maxAdmins: Number(cfg.maxAdmins ?? 1),
        maxLeads:  Number(cfg.maxLeads  ?? 1000),
        features:  featuresDoc,
      };

      // NEW: extended limits / AI quotas / flags.
      // Only overwrite a field when the client actually sent it, so an older
      // or partial payload can never clobber an existing value with a default.
      const EXT_NUMERIC = [
        "maxWebsites", "maxMetaCampaigns", "maxGoogleAccounts", "maxStorageMB",
        "transcriptionsPerMonth", "summariesPerMonth", "voiceBotPerMonth",
        "dataRetentionDays",
      ];
      for (const key of EXT_NUMERIC) {
        if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== "") {
          const n = Number(cfg[key]);
          if (Number.isFinite(n)) update[key] = n;
        }
      }
      if (cfg.recordingEnabled !== undefined) {
        update.recordingEnabled = !!cfg.recordingEnabled;
      }

      const plan = await PlanConfig.findOneAndUpdate(
        { planKey: slug },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      results.push(plan);
    }

    // Signal clients to refresh their cached entitlements
    res.json({ success: true, saved: results.length });
  } catch (err) {
    console.error('[savePlansConfig]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getPlan,
  getPlansConfig,   // NEW
  savePlansConfig,  // NEW
};
