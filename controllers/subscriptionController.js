// backend/controllers/subscriptionController.js
const Company    = require('../models/Company');
const PlanConfig = require('../models/PlanConfig');

// ── Plan feature definitions — developer can override per-company via planFeatures ──
const DEFAULT_PLAN_FEATURES = {
  basic: {
    name: 'Basic',
    price: { monthly: 999, yearly: 9990 },
    color: '#6B7280',
    maxUsers: 5,
    maxLeads: 1000,
    features: [
      { key: 'leads',          label: 'Lead Management',      enabled: true  },
      { key: 'contacts',       label: 'Contacts',             enabled: true  },
      { key: 'basic-reports',  label: 'Basic Reports',        enabled: true  },
      { key: 'attendance',     label: 'Attendance',           enabled: true  },
      { key: 'daily-report',   label: 'Daily Report (Email)', enabled: true  },
      { key: 'sms-blast',      label: 'SMS Blast',            enabled: false },
      { key: 'whatsapp-blast', label: 'WhatsApp Blast',       enabled: false },
      { key: 'email-blast',    label: 'Email Blast',          enabled: false },
      { key: 'campaigns',      label: 'Campaigns',            enabled: false },
      { key: 'google-ads',     label: 'Google Ads',           enabled: false },
      { key: 'meta-ads',       label: 'Facebook / Meta Ads',  enabled: false },
      { key: 'call-recording', label: 'Call Recordings',      enabled: false },
      { key: 'api-access',     label: 'API / Webhooks',       enabled: false },
      { key: 'custom-reports', label: 'Custom Reports',       enabled: false },
      { key: 'white-label',    label: 'White Label',          enabled: false },
    ],
  },
  pro: {
    name: 'Pro',
    price: { monthly: 2999, yearly: 29990 },
    color: '#2563EB',
    maxUsers: 20,
    maxLeads: 10000,
    features: [
      { key: 'leads',          label: 'Lead Management',      enabled: true  },
      { key: 'contacts',       label: 'Contacts',             enabled: true  },
      { key: 'basic-reports',  label: 'Basic Reports',        enabled: true  },
      { key: 'attendance',     label: 'Attendance',           enabled: true  },
      { key: 'daily-report',   label: 'Daily Report (Email)', enabled: true  },
      { key: 'sms-blast',      label: 'SMS Blast',            enabled: true  },
      { key: 'whatsapp-blast', label: 'WhatsApp Blast',       enabled: true  },
      { key: 'email-blast',    label: 'Email Blast',          enabled: true  },
      { key: 'campaigns',      label: 'Campaigns',            enabled: true  },
      { key: 'google-ads',     label: 'Google Ads',           enabled: true  },
      { key: 'meta-ads',       label: 'Facebook / Meta Ads',  enabled: true  },
      { key: 'call-recording', label: 'Call Recordings',      enabled: true  },
      { key: 'api-access',     label: 'API / Webhooks',       enabled: true  },
      { key: 'custom-reports', label: 'Custom Reports',       enabled: false },
      { key: 'white-label',    label: 'White Label',          enabled: false },
    ],
  },
  enterprise: {
    name: 'Enterprise',
    price: { monthly: 9999, yearly: 99990 },
    color: '#7C3AED',
    maxUsers: 999,
    maxLeads: 999999,
    features: [
      { key: 'leads',          label: 'Lead Management',      enabled: true },
      { key: 'contacts',       label: 'Contacts',             enabled: true },
      { key: 'basic-reports',  label: 'Basic Reports',        enabled: true },
      { key: 'attendance',     label: 'Attendance',           enabled: true },
      { key: 'daily-report',   label: 'Daily Report (Email)', enabled: true },
      { key: 'sms-blast',      label: 'SMS Blast',            enabled: true },
      { key: 'whatsapp-blast', label: 'WhatsApp Blast',       enabled: true },
      { key: 'email-blast',    label: 'Email Blast',          enabled: true },
      { key: 'campaigns',      label: 'Campaigns',            enabled: true },
      { key: 'google-ads',     label: 'Google Ads',           enabled: true },
      { key: 'meta-ads',       label: 'Facebook / Meta Ads',  enabled: true },
      { key: 'call-recording', label: 'Call Recordings',      enabled: true },
      { key: 'api-access',     label: 'API / Webhooks',       enabled: true },
      { key: 'custom-reports', label: 'Custom Reports',       enabled: true },
      { key: 'white-label',    label: 'White Label',          enabled: true },
    ],
  },
};

// Calendar-accurate days remaining (UTC midnight comparison)
function calcDaysRemaining(company) {
  const now    = new Date();
  let expiry   = null;
  if (company.subscriptionStatus === 'active' && company.subscriptionExpiry)
    expiry = new Date(company.subscriptionExpiry);
  else if (company.subscriptionStatus === 'trial' && company.trialEndsAt)
    expiry = new Date(company.trialEndsAt);
  if (!expiry) return 0;
  const nowMid    = Date.UTC(now.getUTCFullYear(),    now.getUTCMonth(),    now.getUTCDate());
  const expiryMid = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  const diff      = Math.round((expiryMid - nowMid) / 86_400_000);
  return diff > 0 ? diff : 0;
}

// Merge developer-saved planFeatures overrides onto defaults
function resolvePlanFeatures(planKey, savedOverrides) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PLAN_FEATURES[planKey] || DEFAULT_PLAN_FEATURES.basic));
  if (!savedOverrides || !Array.isArray(savedOverrides)) return base;
  // Apply developer overrides by key
  for (const override of savedOverrides) {
    const feat = base.features.find(f => f.key === override.key);
    if (feat) feat.enabled = !!override.enabled;
  }
  return base;
}

// ── GET /api/subscription/plans ───────────────────────────────────────────────
// Returns plan definitions — optionally enriched with per-plan developer overrides
// stored on a "master config" (we store them on a sentinel Company doc or env, but
// simplest: store in a separate PlanConfig collection). For now we return defaults +
// any overrides stored in process-level cache set by the developer.
const getPlans = async (req, res) => {
  try {
    const dbPlans = await PlanConfig.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
    if (dbPlans.length > 0) {
      // Convert array to keyed object so existing clients work unchanged
      const plansMap = {};
      for (const p of dbPlans) {
        plansMap[p.planKey] = {
          name:     p.name,
          price:    p.price,
          color:    p.color,
          maxUsers: p.maxUsers,
          maxLeads: p.maxLeads,
          features: p.features,
        };
      }
      return res.json({ success: true, plans: plansMap });
    }
    // Fallback: no DB plans yet — return hardcoded defaults
    res.json({ success: true, plans: DEFAULT_PLAN_FEATURES });
  } catch (err) {
    // Graceful degradation
    res.json({ success: true, plans: DEFAULT_PLAN_FEATURES });
  }
};

// ── GET /api/subscription/all ─────────────────────────────────────────────────
const getAllSubscriptions = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;
    const search = req.query.search?.trim() || null;

    const filter = {};
    if (status && status !== 'all') filter.subscriptionStatus = status;
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [result] = await Company.aggregate([
      { $match: filter },
      {
        $facet: {
          total:        [{ $count: 'count' }],
          companies: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, email: 1, plan: 1, isActive: 1,
                subscriptionStatus: 1, subscriptionExpiry: 1,
                trialEndsAt: 1, planFeatures: 1, createdAt: 1,
              },
            },
          ],
          statusCounts: [{ $group: { _id: '$subscriptionStatus', count: { $sum: 1 } } }],
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
    console.error('[getAllSubscriptions]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/activate/:companyId ────────────────────────────────
const activateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { plan, billing = 'monthly', durationMonths } = req.body;

    if (!DEFAULT_PLAN_FEATURES[plan]) {
      return res.status(400).json({ success: false, message: `Invalid plan. Choose: ${Object.keys(DEFAULT_PLAN_FEATURES).join(', ')}` });
    }

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    const months = Math.max(1, parseInt(durationMonths || (billing === 'yearly' ? 12 : 1), 10));
    // Calendar-accurate: same day next N months
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + months);

    company.plan               = plan;
    company.subscriptionStatus = 'active';
    company.subscriptionExpiry = expiry;
    company.isActive           = true;
    // Apply plan limits
    company.maxUsers = DEFAULT_PLAN_FEATURES[plan].maxUsers;
    company.maxLeads = DEFAULT_PLAN_FEATURES[plan].maxLeads;
    await company.save();

    res.json({
      success: true,
      message:      `Subscription activated for ${company.name}`,
      plan,
      expiresAt:    expiry,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    console.error('[activateSubscription]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/subscription/features/:companyId ─────────────────────────────────
// Developer sets which features are enabled for a specific company
const updatePlanFeatures = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { features }  = req.body; // array of { key, enabled }

    if (!Array.isArray(features)) {
      return res.status(400).json({ success: false, message: 'features must be an array' });
    }

    const company = await Company.findByIdAndUpdate(
      companyId,
      { planFeatures: features },
      { new: true }
    ).select('name plan planFeatures');

    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    res.json({
      success:          true,
      message:          `Plan features updated for ${company.name}`,
      resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
    });
  } catch (err) {
    console.error('[updatePlanFeatures]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/cancel/:companyId ──────────────────────────────────
const cancelSubscription = async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.companyId,
      { subscriptionStatus: 'cancelled', isActive: false },
      { new: true }
    ).select('name subscriptionStatus');
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
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
    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    const base   = company.trialEndsAt && new Date(company.trialEndsAt) > new Date()
      ? new Date(company.trialEndsAt) : new Date();
    const newEnd = new Date(base);
    newEnd.setDate(newEnd.getDate() + days);

    company.trialEndsAt        = newEnd;
    company.subscriptionStatus = 'trial';
    company.isActive           = true;
    await company.save();

    res.json({
      success: true,
      message:      `Trial extended by ${days} days for ${company.name}`,
      newTrialEnd:   newEnd,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/status — for admin/super_admin panel ────────────────
// Returns current subscription status + features for the calling company
const getMySubscriptionStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id ?? req.admin?.company;
    const company   = await Company.findById(companyId)
      .select('name plan subscriptionStatus subscriptionExpiry trialEndsAt isActive planFeatures');
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    const daysRemaining = calcDaysRemaining(company);
    // Auto-suspend: if expiry passed, mark expired + deactivate
    const now = new Date();
    let status = company.subscriptionStatus;
    if (status === 'active' && company.subscriptionExpiry && now > company.subscriptionExpiry) {
      await Company.findByIdAndUpdate(companyId, { subscriptionStatus: 'expired', isActive: false });
      status = 'expired';
    }
    if (status === 'trial' && company.trialEndsAt && now > company.trialEndsAt) {
      await Company.findByIdAndUpdate(companyId, { subscriptionStatus: 'expired', isActive: false });
      status = 'expired';
    }

    res.json({
      success: true,
      plan:             company.plan,
      status,
      daysRemaining,
      expiresAt:        company.subscriptionExpiry || company.trialEndsAt,
      expiringSoon:     daysRemaining <= 5 && daysRemaining > 0 && ['active','trial'].includes(status),
      suspended:        status === 'expired' || status === 'cancelled',
      resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/:companyId ─────────────────────────────────────────
const getCompanySubscription = async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId)
      .select('name plan subscriptionStatus subscriptionExpiry trialEndsAt isActive planFeatures');
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    res.json({
      success: true,
      company: {
        ...company.toObject(),
        daysRemaining:    calcDaysRemaining(company),
        resolvedFeatures: resolvePlanFeatures(company.plan, company.planFeatures),
      },
    });
  } catch (err) {
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
  DEFAULT_PLAN_FEATURES,
  resolvePlanFeatures,
  calcDaysRemaining,
};
