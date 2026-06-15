const Razorpay   = require("razorpay");
const crypto     = require("crypto");
const Company    = require("../models/Company");
const Payment    = require("../models/Payment");
const SuperAdmin = require("../models/SuperAdmin");
const Admin      = require("../models/Admin");
const Developer  = require("../models/Developer");
const { sendEmail }          = require("../utils/brevoMailer");
const { planInvoiceEmail }   = require("../utils/emailTemplates");

// ─── Helper: collect SuperAdmin + Developer emails and send invoice ───────────
// Called after every successful payment (renewal or upgrade).
const _sendPlanInvoiceEmails = async ({
  companyName,
  companyEmail,
  planName,
  billing,
  newExpiry,
  invoiceId,
  amount,
  transactionId,
  paymentDate,
}) => {
  const seen      = new Set();
  const dashboard = process.env.FRONTEND_URL
    ? `${process.env.FRONTEND_URL}/developer/subscriptions`
    : "https://app.skyupcrm.com/developer/subscriptions";

  const buildPayload = (recipientName, recipientRole) =>
    planInvoiceEmail({
      recipientName,
      recipientRole,
      companyName,
      companyEmail,
      planName,
      billing,
      newExpiry,
      actionType: "renewal",   // Razorpay = customer self-pay (renewal / upgrade)
      invoiceId,
      amount,
      transactionId,
      paymentDate,
      dashboardUrl: dashboard,
    });

  // ── 1. Legacy global SuperAdmin docs ──────────────────────────────────────
  try {
    const legacyAdmins = await SuperAdmin.find({}).select("email name").lean();
    for (const sa of legacyAdmins) {
      const key = sa.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const mail = buildPayload(sa.name || "Super Admin", "superadmin");
      await sendEmail({ to: sa.email.trim(), toName: sa.name || "Super Admin", ...mail });
    }
  } catch (e) {
    console.error("[Razorpay] Failed to email legacy SuperAdmins:", e.message);
  }

  // ── 2. Company-level super_admins from Admin model ────────────────────────
  try {
    const companyAdmins = await Admin.find({ role: "super_admin" })
      .select("email name")
      .lean();
    for (const sa of companyAdmins) {
      const key = sa.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const mail = buildPayload(sa.name || "Super Admin", "superadmin");
      await sendEmail({ to: sa.email.trim(), toName: sa.name || "Super Admin", ...mail });
    }
  } catch (e) {
    console.error("[Razorpay] Failed to email company SuperAdmins:", e.message);
  }

  // ── 3. All registered developers ─────────────────────────────────────────
  try {
    const devs = await Developer.find({}).select("email name").lean();
    for (const dev of devs) {
      const key = dev.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const mail = buildPayload(dev.name || "Developer", "developer");
      await sendEmail({ to: dev.email.trim(), toName: dev.name || "Developer", ...mail });
    }
  } catch (e) {
    console.error("[Razorpay] Failed to email Developers:", e.message);
  }
};

// ─── Razorpay instance ────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Plan definitions (source of truth on backend) ────────────────────────────
const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPrice: 999,
    yearlyPrice: 799,
    admins: 1,
    agents: 10,
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPrice: 2499,
    yearlyPrice: 1999,
    admins: 3,
    agents: 30,
  },
  advance: {
    id: "advance",
    name: "Advance",
    monthlyPrice: 5999,
    yearlyPrice: 4799,
    admins: 5,
    agents: 50,
  },
};

// ─── POST /api/razorpay/create-order ─────────────────────────────────────────
// Creates a Razorpay order and returns the order_id + key to the frontend
const createOrder = async (req, res) => {
  try {
    const { planId, billing } = req.body;

    if (!planId || !billing) {
      return res.status(400).json({ message: "planId and billing are required" });
    }

    if (planId === "enterprise") {
      return res.status(400).json({ message: "Enterprise is a custom plan. Please contact sales." });
    }

    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ message: "Invalid plan selected" });
    }

    const amountInPaise =
      (billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice) * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: {
        planId,
        billing,
        companyId: req.admin.company._id.toString(),
      },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planName: plan.name,
    });
  } catch (err) {
    console.error("[Razorpay] create-order error:", err);
    return res.status(500).json({ message: "Failed to create payment order" });
  }
};

// ─── POST /api/razorpay/verify-payment ───────────────────────────────────────
// Verifies Razorpay signature, saves payment record, and upgrades company plan
const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId,
      billing,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !planId ||
      !billing
    ) {
      return res.status(400).json({ message: "Missing payment verification fields" });
    }

    // ── Verify signature ─────────────────────────────────────────────────────
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Payment verification failed: invalid signature" });
    }

    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    const amountPaid =
      billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

    const companyId = req.admin.company._id;

    // ── Generate invoice ID ──────────────────────────────────────────────────
    const now = new Date();
    const invoiceId = `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-4)}`;

    // ── Save payment record ──────────────────────────────────────────────────
    const payment = await Payment.create({
      company: companyId,
      invoiceId,
      planId,
      planName: plan.name,
      billing,
      amount: amountPaid,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      status: "paid",
    });

    // ── Upgrade / Renew company plan + extend expiry ─────────────────────────
    // Map plan IDs to Company model enum values
    const planEnumMap = {
      starter: "basic",
      growth: "pro",
      advance: "advance",
    };

    // Determine new expiry:
    // If company still has a future expiry, extend FROM that date (not today).
    // This ensures early renewals don't lose any remaining days.
    const company = await Company.findById(companyId).select('subscriptionExpiry subscriptionStatus');
    const currentExpiry = company?.subscriptionExpiry ? new Date(company.subscriptionExpiry) : null;
    const baseDate = (currentExpiry && currentExpiry > now) ? currentExpiry : now;

    const newExpiry = new Date(baseDate);
    if (billing === 'yearly') {
      newExpiry.setFullYear(newExpiry.getFullYear() + 1);
    } else {
      newExpiry.setMonth(newExpiry.getMonth() + 1);
    }

    const updatedCompany = await Company.findByIdAndUpdate(companyId, {
      plan: planEnumMap[planId] || 'basic',
      subscriptionStatus: 'active',
      subscriptionExpiry: newExpiry,
      isActive: true,
    }, { new: true }).select('name email').lean();

    // ── Send invoice email to SuperAdmins + Developers (non-blocking) ────────
    _sendPlanInvoiceEmails({
      companyName:   updatedCompany?.name  || "Company",
      companyEmail:  updatedCompany?.email || "",
      planName:      plan.name,
      billing,
      newExpiry,
      invoiceId:     payment.invoiceId,
      amount:        amountPaid,
      transactionId: razorpay_payment_id,
      paymentDate:   now,
    }).catch((err) =>
      console.error("[Razorpay] Invoice email dispatch failed:", err.message)
    );

    return res.status(200).json({
      success: true,
      invoiceId: payment.invoiceId,
      transactionId: razorpay_payment_id,
      planName: plan.name,
      amount: amountPaid,
      billing,
      newExpiry: newExpiry,
    });
  } catch (err) {
    console.error("[Razorpay] verify-payment error:", err);
    return res.status(500).json({ message: "Payment verification server error" });
  }
};

// ─── GET /api/razorpay/invoices ───────────────────────────────────────────────
// Returns payment history for the authenticated admin's company
const getInvoices = async (req, res) => {
  try {
    const companyId = req.admin.company._id;

    const payments = await Payment.find({ company: companyId })
      .sort({ createdAt: -1 })
      .lean();

    const invoices = payments.map((p) => ({
      id: p.invoiceId,
      date: new Date(p.createdAt).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
      amount: `₹${p.amount.toLocaleString("en-IN")}`,
      baseAmount: p.amount,
      status: p.status === "paid" ? "Paid" : "Pending",
      planName: p.planName,
      billingCycle: p.billing,
      transactionId: p.razorpayPaymentId,
    }));

    return res.status(200).json(invoices);
  } catch (err) {
    console.error("[Razorpay] get-invoices error:", err);
    return res.status(500).json({ message: "Failed to fetch invoices" });
  }
};

// ─── GET /api/razorpay/subscription ──────────────────────────────────────────
// Returns current subscription summary for the admin's company
const getSubscription = async (req, res) => {
  try {
    const company = req.admin.company;

    // Get last successful payment
    const lastPayment = await Payment.findOne({
      company: company._id,
      status: "paid",
    })
      .sort({ createdAt: -1 })
      .lean();

    // Calculate total paid
    const totalResult = await Payment.aggregate([
      { $match: { company: company._id, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalPaid = totalResult[0]?.total || 0;

    // Map Company plan enum to display name
    const planDisplayMap = {
      basic: "Basic",
      pro: "Pro",
      advance: "Advance",
      enterprise: "Enterprise",
    };

    // Calculate renewal date (30 days from last payment, or yearly)
    let renewsOn = "—";
    if (lastPayment) {
      const renewDate = new Date(lastPayment.createdAt);
      if (lastPayment.billing === "yearly") {
        renewDate.setFullYear(renewDate.getFullYear() + 1);
      } else {
        renewDate.setMonth(renewDate.getMonth() + 1);
      }
      renewsOn = renewDate.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    }

    return res.status(200).json({
      planName: planDisplayMap[company.plan] || "Starter",
      renewsOn,
      totalPaid: `₹${totalPaid.toLocaleString("en-IN")}`,
      paymentMethod: lastPayment ? "Razorpay" : "—",
    });
  } catch (err) {
    console.error("[Razorpay] get-subscription error:", err);
    return res.status(500).json({ message: "Failed to fetch subscription" });
  }
};

module.exports = { createOrder, verifyPayment, getInvoices, getSubscription };