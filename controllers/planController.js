// controllers/planController.js
// Developer-only CRUD for plan configurations.
// Plans created here are read by subscriptionController.getPlans
// and drive the upgrade page and feature-gate system.

const PlanConfig = require('../models/PlanConfig');
const { DEFAULT_PLAN_FEATURES } = require('./subscriptionController');

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
    const { planKey, name, description, color, price, maxUsers, maxLeads, features, sortOrder, isActive } = req.body;

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
      price:       {
        monthly: Number(price?.monthly ?? 0),
        yearly:  Number(price?.yearly  ?? 0),
      },
      maxUsers: Number(maxUsers ?? 5),
      maxLeads: Number(maxLeads ?? 1000),
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

    const { name, description, color, price, maxUsers, maxLeads, features, sortOrder, isActive } = req.body;

    if (name       !== undefined) plan.name        = name.trim();
    if (description!== undefined) plan.description = description.trim();
    if (color      !== undefined) plan.color        = color;
    if (maxUsers   !== undefined) plan.maxUsers     = Number(maxUsers);
    if (maxLeads   !== undefined) plan.maxLeads     = Number(maxLeads);
    if (features   !== undefined) plan.features     = features;
    if (sortOrder  !== undefined) plan.sortOrder    = Number(sortOrder);
    if (isActive   !== undefined) plan.isActive     = Boolean(isActive);

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

module.exports = { getPlans, createPlan, updatePlan, deletePlan, getPlan };
