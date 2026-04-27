// controllers/subscriptionController.js
// ─────────────────────────────────────────────────────────────────────────────
// Subscription management — SuperAdmin controls client subscriptions
// ─────────────────────────────────────────────────────────────────────────────

const Company = require("../models/Company");

const PLANS = {
  basic: {
    name: "Basic",
    price: { monthly: 999, yearly: 9990 },
    features: ["leads", "contacts", "basic-reports"],
    maxUsers: 5,
    maxLeads: 1000,
  },
  pro: {
    name: "Pro",
    price: { monthly: 2999, yearly: 29990 },
    features: ["leads", "contacts", "reports", "email-campaigns", "meta-ads", "twilio"],
    maxUsers: 20,
    maxLeads: 10000,
  },
  enterprise: {
    name: "Enterprise",
    price: { monthly: 9999, yearly: 99990 },
    features: ["everything", "dedicated-support", "custom-domain", "api-access"],
    maxUsers: 999,
    maxLeads: 999999,
  },
};

// ── Activate / Renew subscription (SuperAdmin only) ───────────────────────────
const activateSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { plan, billing = "monthly", durationMonths } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ message: "Invalid plan. Choose: basic, pro, enterprise" });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    // Calculate expiry
    const months = durationMonths || (billing === "yearly" ? 12 : 1);
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + months);

    company.plan = plan;
    company.subscriptionStatus = "active";
    company.subscriptionExpiry = expiry;
    company.isActive = true;
    await company.save();

    res.status(200).json({
      success: true,
      message: `Subscription activated for ${company.name}`,
      plan,
      expiresAt: expiry,
      daysRemaining: months * 30,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Cancel subscription ───────────────────────────────────────────────────────
const cancelSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    company.subscriptionStatus = "cancelled";
    await company.save();

    res.status(200).json({ success: true, message: "Subscription cancelled" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Extend trial ──────────────────────────────────────────────────────────────
const extendTrial = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { days = 7 } = req.body;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const newTrialEnd = new Date(company.trialEndsAt || Date.now());
    newTrialEnd.setDate(newTrialEnd.getDate() + days);

    company.trialEndsAt = newTrialEnd;
    company.subscriptionStatus = "trial";
    await company.save();

    res.status(200).json({
      success: true,
      message: `Trial extended by ${days} days`,
      newTrialEnd,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Get all subscriptions status ──────────────────────────────────────────────
const getAllSubscriptions = async (req, res) => {
  try {
    const companies = await Company.find({}).select(
      "name email plan subscriptionStatus subscriptionExpiry trialEndsAt isActive dataEncryptionEnabled createdAt"
    );

    const now = new Date();
    const enriched = companies.map(c => ({
      ...c.toObject(),
      daysRemaining: c.subscriptionExpiry
        ? Math.max(0, Math.ceil((c.subscriptionExpiry - now) / (1000 * 60 * 60 * 24)))
        : c.subscriptionStatus === "trial"
          ? Math.max(0, Math.ceil((c.trialEndsAt - now) / (1000 * 60 * 60 * 24)))
          : 0,
    }));

    res.status(200).json({ companies: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Get plan details ──────────────────────────────────────────────────────────
const getPlans = async (req, res) => {
  res.status(200).json({ plans: PLANS });
};

module.exports = {
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getAllSubscriptions,
  getPlans,
};