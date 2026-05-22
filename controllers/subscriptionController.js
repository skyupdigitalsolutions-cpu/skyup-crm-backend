// backend/controllers/subscriptionController.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX: Added pagination, standardized API responses, optimized queries,
// and added developer role support alongside superadmin.
// ─────────────────────────────────────────────────────────────────────────────

const Company = require('../models/Company');

const PLANS = {
  basic: {
    name: 'Basic',
    price: { monthly: 999, yearly: 9990 },
    features: ['leads', 'contacts', 'basic-reports'],
    maxUsers: 5,
    maxLeads: 1000,
  },
  pro: {
    name: 'Pro',
    price: { monthly: 2999, yearly: 29990 },
    features: ['leads', 'contacts', 'reports', 'email-campaigns', 'meta-ads'],
    maxUsers: 20,
    maxLeads: 10000,
  },
  enterprise: {
    name: 'Enterprise',
    price: { monthly: 9999, yearly: 99990 },
    features: ['everything', 'dedicated-support', 'custom-domain', 'api-access'],
    maxUsers: 999,
    maxLeads: 999999,
  },
};

// ── Helper: days remaining for a company ──────────────────────────────────────
// Uses Math.floor so "2.9 days left" shows as 2, not 3 — avoids showing
// a count that looks wrong compared to the actual expiry date displayed.
function calcDaysRemaining(company) {
  const now = Date.now();
  if (company.subscriptionStatus === 'active' && company.subscriptionExpiry) {
    const ms = new Date(company.subscriptionExpiry) - now;
    return ms <= 0 ? 0 : Math.floor(ms / 86400000);
  }
  if (company.subscriptionStatus === 'trial' && company.trialEndsAt) {
    const ms = new Date(company.trialEndsAt) - now;
    return ms <= 0 ? 0 : Math.floor(ms / 86400000);
  }
  return 0;
}

// ── GET /api/subscription/plans ───────────────────────────────────────────────
const getPlans = (req, res) => {
  res.json({ success: true, plans: PLANS });
};

// ── GET /api/subscription/all ─────────────────────────────────────────────────
// Query params: ?page=1&limit=20&status=active&search=<name>
const getAllSubscriptions = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;
    const search = req.query.search?.trim() || null;

    // ── Build filter ──────────────────────────────────────────────────────────
    const filter = {};
    if (status && status !== 'all') filter.subscriptionStatus = status;
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    // ── Single aggregation — counts + paginated list ──────────────────────────
    const [result] = await Company.aggregate([
      { $match: filter },
      {
        $facet: {
          total: [{ $count: 'count' }],
          companies: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, email: 1, plan: 1, isActive: 1,
                subscriptionStatus: 1, subscriptionExpiry: 1,
                trialEndsAt: 1, dataEncryptionEnabled: 1, createdAt: 1,
              },
            },
          ],
          // Status summary counts
          statusCounts: [
            {
              $group: {
                _id: '$subscriptionStatus',
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const total     = result?.total?.[0]?.count ?? 0;
    const companies = result?.companies ?? [];
    const pages     = Math.ceil(total / limit);

    // Attach daysRemaining in JS (simpler than complex $expr in aggregation)
    const enriched = companies.map(c => ({
      ...c,
      daysRemaining: calcDaysRemaining(c),
    }));

    // Build status summary map
    const statusSummary = {};
    for (const s of (result?.statusCounts ?? [])) {
      statusSummary[s._id] = s.count;
    }

    res.json({
      success: true,
      companies: enriched,
      pagination: { total, page, pages, limit },
      summary: statusSummary,
    });
  } catch (err) {
    console.error('[subscriptionController.getAllSubscriptions]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/activate/:companyId ────────────────────────────────
const activateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { plan, billing = 'monthly', durationMonths } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: `Invalid plan. Choose: ${Object.keys(PLANS).join(', ')}` });
    }

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    const months = Math.max(1, parseInt(durationMonths || (billing === 'yearly' ? 12 : 1), 10));
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + months);

    company.plan               = plan;
    company.subscriptionStatus = 'active';
    company.subscriptionExpiry = expiry;
    company.isActive           = true;
    await company.save();

    res.json({
      success: true,
      message: `Subscription activated for ${company.name}`,
      plan,
      expiresAt:     expiry,
      daysRemaining: months * 30,
    });
  } catch (err) {
    console.error('[subscriptionController.activateSubscription]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/subscription/cancel/:companyId ──────────────────────────────────
const cancelSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findByIdAndUpdate(
      companyId,
      { subscriptionStatus: 'cancelled' },
      { new: true }
    ).select('name subscriptionStatus');

    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    res.json({ success: true, message: `Subscription cancelled for ${company.name}` });
  } catch (err) {
    console.error('[subscriptionController.cancelSubscription]', err.message);
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

    const base       = company.trialEndsAt && new Date(company.trialEndsAt) > new Date()
      ? new Date(company.trialEndsAt)
      : new Date();
    const newEnd     = new Date(base);
    newEnd.setDate(newEnd.getDate() + days);

    company.trialEndsAt        = newEnd;
    company.subscriptionStatus = 'trial';
    await company.save();

    res.json({
      success: true,
      message: `Trial extended by ${days} days for ${company.name}`,
      newTrialEnd:   newEnd,
      daysRemaining: calcDaysRemaining(company),
    });
  } catch (err) {
    console.error('[subscriptionController.extendTrial]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/:companyId ─────────────────────────────────────────
const getCompanySubscription = async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId)
      .select('name plan subscriptionStatus subscriptionExpiry trialEndsAt isActive');

    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });

    const planInfo = PLANS[company.plan] || null;

    res.json({
      success: true,
      company: {
        ...company.toObject(),
        planInfo,
        daysRemaining: calcDaysRemaining(company),
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
};
