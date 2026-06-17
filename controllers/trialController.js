// controllers/trialController.js
// ─────────────────────────────────────────────────────────────────────────────
// 7-DAY PRO FREE TRIAL — supports TWO billing modes via env TRIAL_BILLING_MODE:
//
//   "onetime" (default — works on ANY Razorpay account):
//     • Trial starts with NO payment (card not collected up front).
//     • After the trial, the customer picks a plan and pays via a normal
//       one-time Razorpay Checkout (they confirm the card once).
//     • Does NOT require the Razorpay "Recurring Payments" feature.
//
//   "mandate" (true silent auto-billing — requires Recurring Payments enabled):
//     • Trial starts by registering a card/UPI mandate (saved token).
//     • After the trial, the saved token is charged server-side, no customer
//       interaction. Requires Razorpay to have enabled recurring on the account.
//
// Switch modes with:  TRIAL_BILLING_MODE=onetime   (or)   TRIAL_BILLING_MODE=mandate
//
// Env:
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET            (required)
//   TRIAL_BILLING_MODE   = "onetime" | "mandate"    (default "onetime")
//   TRIAL_DAYS           = 7
//   TRIAL_MANDATE_AUTH_AMOUNT = 500   (paise, mandate mode only)
//   TRIAL_MANDATE_MAX_AMOUNT  = 1000000
//   TRIAL_FALLBACK_CONTACT    = "9999999999"
// ─────────────────────────────────────────────────────────────────────────────

const Razorpay = require("razorpay");
const crypto   = require("crypto");
const Company  = require("../models/Company");
const Payment  = require("../models/Payment");
const { sendEmail }        = require("../utils/brevoMailer");
const { trialStartedEmail } = require("../utils/trialEmailTemplates");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// "onetime" by default so it works on accounts WITHOUT recurring enabled.
const BILLING_MODE      = (process.env.TRIAL_BILLING_MODE || "onetime").toLowerCase();
const IS_MANDATE_MODE   = BILLING_MODE === "mandate";

const TRIAL_DAYS         = Number(process.env.TRIAL_DAYS || 7);
const AUTH_AMOUNT_PAISE  = Number(process.env.TRIAL_MANDATE_AUTH_AMOUNT || 500);      // ₹5
const MAX_AMOUNT_PAISE   = Number(process.env.TRIAL_MANDATE_MAX_AMOUNT  || 1000000);  // ₹10,000

// Plan source-of-truth (mirrors razorpayController.PLANS).
const PLANS = {
  starter: { id: "starter", name: "Starter", monthlyPrice: 999,  yearlyPrice: 799  },
  growth:  { id: "growth",  name: "Pro",     monthlyPrice: 2499, yearlyPrice: 1999 },
  advance: { id: "advance", name: "Advance", monthlyPrice: 5999, yearlyPrice: 4799 },
};
const PLAN_ENUM_MAP = { starter: "basic", growth: "pro", advance: "advance" };

const _companyId = (req) => req.admin?.company?._id ?? req.admin?.company;

// Razorpay's `contact` only accepts digits and an optional leading "+".
const sanitizeContact = (raw) => {
  if (!raw) return undefined;
  let s = String(raw).trim();
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return undefined;
  return hasPlus ? `+${digits}` : digits;
};
const FALLBACK_CONTACT = sanitizeContact(process.env.TRIAL_FALLBACK_CONTACT) || "9999999999";
const mandateContact   = (raw) => sanitizeContact(raw) || FALLBACK_CONTACT;

// Shared helper — activate a plan + extend expiry + record the invoice.
async function activatePlan(company, planId, billing, paymentId, orderId) {
  const plan        = PLANS[planId];
  const amountRupee  = billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

  const now       = new Date();
  const invoiceId = `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-4)}`;
  await Payment.create({
    company:           company._id,
    invoiceId,
    planId,
    planName:          plan.name,
    billing,
    amount:            amountRupee,
    razorpayOrderId:   orderId   || null,
    razorpayPaymentId: paymentId || null,
    status:            "paid",
  });

  const currentExpiry = company.subscriptionExpiry ? new Date(company.subscriptionExpiry) : null;
  const baseDate      = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry     = new Date(baseDate);
  if (billing === "yearly") newExpiry.setFullYear(newExpiry.getFullYear() + 1);
  else                      newExpiry.setMonth(newExpiry.getMonth() + 1);

  company.plan                  = PLAN_ENUM_MAP[planId] || "basic";
  company.subscriptionStatus    = "active";
  company.subscriptionExpiry    = newExpiry;
  company.isActive              = true;
  company.pendingPlanId         = null;
  company.trialExpiredEmailSent = false;
  await company.save();

  return { invoiceId, amount: amountRupee, planName: plan.name, newExpiry };
}

// ─── GET /api/trial/status ────────────────────────────────────────────────────
const getTrialStatus = async (req, res) => {
  try {
    const company = await Company.findById(_companyId(req))
      .select(
        "name email plan subscriptionStatus subscriptionExpiry trialEndsAt " +
        "paymentMethodProvided trialPlan trialStartedAt"
      );
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const now = new Date();
    const trialStarted = !!company.trialStartedAt;
    const trialActive  = company.subscriptionStatus === "trial" && company.trialEndsAt && now < company.trialEndsAt;
    // A trial counts as "expired" once it was started and has now lapsed without
    // converting to an active paid plan. Works for BOTH billing modes.
    const trialExpired =
      trialStarted &&
      (company.subscriptionStatus === "expired" ||
        (company.trialEndsAt && now >= company.trialEndsAt && company.subscriptionStatus !== "active"));

    const daysRemaining = company.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(company.trialEndsAt) - now) / 86_400_000))
      : null;

    res.json({
      success: true,
      billingMode:           IS_MANDATE_MODE ? "mandate" : "onetime",
      status:                company.subscriptionStatus,
      plan:                  company.plan,
      trialPlan:             company.trialPlan || "pro",
      paymentMethodProvided: company.paymentMethodProvided,
      // The gate to show: in mandate mode this means "add payment method";
      // in onetime mode it means "start your trial" (no card needed).
      needsPaymentMethod:    company.subscriptionStatus === "trial_pending",
      trialActive,
      trialExpired,
      daysRemaining,
      trialEndsAt:           company.trialEndsAt,
    });
  } catch (err) {
    console.error("[Trial] status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Internal — start the 7-day trial on a company doc ─────────────────────────
async function beginTrial(company) {
  const now         = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const trialPlan   = company.trialPlan || "pro";

  company.plan                  = trialPlan;
  company.subscriptionStatus    = "trial";
  company.trialStartedAt        = now;
  company.trialEndsAt           = trialEndsAt;
  company.trialExpiredEmailSent = false;
  company.isActive              = true;
  await company.save();

  setImmediate(async () => {
    try {
      const tpl = trialStartedEmail({
        companyName: company.name,
        planName:    trialPlan === "pro" ? "Pro" : trialPlan,
        trialEndsAt,
      });
      await sendEmail({ to: company.email, toName: company.name, ...tpl });
    } catch (e) {
      console.error("[Trial] trial-started email failed:", e.message);
    }
  });

  return trialEndsAt;
}

// ════════════════════════════════════════════════════════════════════════════
// ONETIME MODE
// ════════════════════════════════════════════════════════════════════════════

// ─── POST /api/trial/start ────────────────────────────────────────────────────
// Onetime mode: start the 7-day trial immediately, no payment required.
const startTrial = async (req, res) => {
  try {
    const company = await Company.findById(_companyId(req))
      .select("name email plan subscriptionStatus trialPlan trialStartedAt trialEndsAt subscriptionExpiry isActive");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    if (company.subscriptionStatus === "active") {
      return res.status(400).json({ success: false, message: "Subscription is already active." });
    }

    const trialEndsAt = await beginTrial(company);
    res.json({
      success:     true,
      message:     `Your ${TRIAL_DAYS}-day free trial is now active.`,
      plan:        company.plan,
      status:      "trial",
      trialEndsAt,
    });
  } catch (err) {
    console.error("[Trial] start error:", err);
    res.status(500).json({ success: false, message: "Could not start the trial" });
  }
};

// ─── POST /api/trial/select-plan/create-order ─────────────────────────────────
// Onetime mode: create a normal one-time Razorpay order for the chosen plan.
// Body: { planId, billing }
const createPlanOrder = async (req, res) => {
  try {
    const { planId, billing = "monthly" } = req.body;
    if (!planId || !PLANS[planId]) return res.status(400).json({ success: false, message: "Invalid plan selected" });
    if (!["monthly", "yearly"].includes(billing)) return res.status(400).json({ success: false, message: "Invalid billing cycle" });

    const company = await Company.findById(_companyId(req)).select("name email phone");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const plan        = PLANS[planId];
    const amountRupee  = billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
    const amountPaise  = amountRupee * 100;

    const order = await razorpay.orders.create({
      amount:          amountPaise,
      currency:        "INR",
      payment_capture: 1,
      receipt:         `plan_${Date.now()}`,
      notes:           { companyId: String(company._id), planId, billing, purpose: "trial_plan_onetime" },
    });

    res.json({
      success:  true,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
      planId,
      billing,
      planName: plan.name,
      prefill:  { email: company.email, contact: sanitizeContact(company.phone) },
    });
  } catch (err) {
    console.error("[Trial] create-plan-order error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
};

// ─── POST /api/trial/select-plan/verify ───────────────────────────────────────
// Onetime mode: verify the one-time payment and activate the plan.
// Body: { planId, billing, razorpay_order_id, razorpay_payment_id, razorpay_signature }
const verifyPlanPayment = async (req, res) => {
  try {
    const { planId, billing = "monthly", razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!planId || !PLANS[planId]) return res.status(400).json({ success: false, message: "Invalid plan" });
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    const company = await Company.findById(_companyId(req))
      .select("name email subscriptionExpiry subscriptionStatus plan trialExpiredEmailSent pendingPlanId");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const result = await activatePlan(company, planId, billing, razorpay_payment_id, razorpay_order_id);

    res.json({
      success:       true,
      message:       `${result.planName} plan activated.`,
      invoiceId:     result.invoiceId,
      transactionId: razorpay_payment_id,
      planName:      result.planName,
      amount:        result.amount,
      billing,
      newExpiry:     result.newExpiry,
      status:        "active",
    });
  } catch (err) {
    console.error("[Trial] verify-plan-payment error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to activate plan" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// MANDATE MODE (requires Razorpay Recurring Payments enabled)
// ════════════════════════════════════════════════════════════════════════════

// ─── POST /api/trial/mandate/create-order ─────────────────────────────────────
const createMandateOrder = async (req, res) => {
  try {
    if (!IS_MANDATE_MODE) {
      return res.status(400).json({ success: false, message: "Mandate mode is disabled. Use /api/trial/start." });
    }
    const company = await Company.findById(_companyId(req)).select("name email phone razorpayCustomerId");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const contact = mandateContact(company.phone);

    let customerId = company.razorpayCustomerId;
    if (!customerId) {
      const customer = await razorpay.customers.create({
        name: company.name, email: company.email, contact, fail_existing: 0,
      });
      customerId = customer.id;
      company.razorpayCustomerId = customerId;
      await company.save();
    } else {
      try { await razorpay.customers.edit(customerId, { contact }); }
      catch (e) { console.warn("[Trial] update customer contact:", e?.error?.description || e.message); }
    }

    const order = await razorpay.orders.create({
      amount:      AUTH_AMOUNT_PAISE,
      currency:    "INR",
      customer_id: customerId,
      method:      "card",
      receipt:     `mandate_${Date.now()}`,
      token: {
        max_amount: MAX_AMOUNT_PAISE,
        expire_at:  Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60,
        frequency:  "monthly",
      },
      notes: { companyId: String(company._id), purpose: "trial_mandate" },
    });

    res.json({
      success: true, orderId: order.id, customerId,
      amount: order.amount, currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, recurring: 1, authAmount: AUTH_AMOUNT_PAISE,
    });
  } catch (err) {
    console.error("[Trial] create-mandate-order error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to create mandate authorization order" });
  }
};

// ─── POST /api/trial/mandate/verify ───────────────────────────────────────────
const verifyMandate = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing verification fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    let tokenId = null, customerId = null;
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      tokenId    = payment?.token_id || null;
      customerId = payment?.customer_id || null;
    } catch (e) {
      console.error("[Trial] fetch payment for token failed:", e?.error || e.message);
    }

    const company = await Company.findById(_companyId(req))
      .select("name email plan razorpayCustomerId razorpayTokenId paymentMethodProvided trialPlan subscriptionExpiry");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    if (!tokenId && (customerId || company.razorpayCustomerId)) {
      try {
        const cid = customerId || company.razorpayCustomerId;
        const tokens = await razorpay.customers.fetchTokens(cid);
        tokenId = tokens?.items?.[0]?.id || null;
      } catch (e) {
        console.error("[Trial] fetchTokens fallback failed:", e?.error || e.message);
      }
    }

    if (!tokenId) {
      return res.status(400).json({
        success: false,
        message: "Could not register a reusable payment method. Please try a card or UPI Autopay mandate.",
      });
    }

    company.razorpayCustomerId    = customerId || company.razorpayCustomerId;
    company.razorpayTokenId       = tokenId;
    company.paymentMethodProvided = true;
    const trialEndsAt = await beginTrial(company);

    res.json({
      success: true,
      message: `Payment method saved. Your ${TRIAL_DAYS}-day free trial is now active.`,
      plan:    company.plan,
      status:  "trial",
      trialEndsAt,
    });
  } catch (err) {
    console.error("[Trial] verify-mandate error:", err?.error || err);
    res.status(500).json({ success: false, message: "Mandate verification failed" });
  }
};

// ─── POST /api/trial/select-plan ──────────────────────────────────────────────
// Mandate mode: silent server-side recurring charge against the saved token.
const selectPlanAndCharge = async (req, res) => {
  try {
    const { planId, billing = "monthly" } = req.body;
    if (!planId || !PLANS[planId]) return res.status(400).json({ success: false, message: "Invalid plan selected" });
    if (!["monthly", "yearly"].includes(billing)) return res.status(400).json({ success: false, message: "Invalid billing cycle" });

    const company = await Company.findById(_companyId(req))
      .select("name email phone razorpayCustomerId razorpayTokenId paymentMethodProvided subscriptionExpiry subscriptionStatus plan trialExpiredEmailSent pendingPlanId");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    if (!company.paymentMethodProvided || !company.razorpayTokenId || !company.razorpayCustomerId) {
      return res.status(400).json({ success: false, code: "NO_PAYMENT_METHOD", message: "No saved payment method. Please add a payment method first." });
    }

    const plan        = PLANS[planId];
    const amountRupee  = billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
    const amountPaise  = amountRupee * 100;

    const order = await razorpay.orders.create({
      amount: amountPaise, currency: "INR", customer_id: company.razorpayCustomerId,
      payment_capture: 1, receipt: `plan_${Date.now()}`,
      notes: { companyId: String(company._id), planId, billing, purpose: "trial_auto_bill" },
    });

    let payment;
    try {
      payment = await razorpay.payments.createRecurringPayment({
        email: company.email, contact: mandateContact(company.phone),
        amount: amountPaise, currency: "INR", order_id: order.id,
        customer_id: company.razorpayCustomerId, token: company.razorpayTokenId,
        recurring: "1", description: `${plan.name} plan (${billing})`,
      });
    } catch (chargeErr) {
      console.error("[Trial] recurring charge failed:", chargeErr?.error || chargeErr);
      return res.status(402).json({
        success: false, code: "CHARGE_FAILED",
        message: chargeErr?.error?.description || "Automatic payment could not be completed. Please update your payment method.",
      });
    }

    const paymentId = payment?.razorpay_payment_id || payment?.id;
    if (!paymentId) return res.status(402).json({ success: false, code: "CHARGE_FAILED", message: "Payment was not captured." });

    const result = await activatePlan(company, planId, billing, paymentId, order.id);

    res.json({
      success: true, message: `${result.planName} plan activated.`,
      invoiceId: result.invoiceId, transactionId: paymentId,
      planName: result.planName, amount: result.amount, billing,
      newExpiry: result.newExpiry, status: "active",
    });
  } catch (err) {
    console.error("[Trial] select-plan error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to activate plan" });
  }
};

module.exports = {
  getTrialStatus,
  // onetime mode
  startTrial,
  createPlanOrder,
  verifyPlanPayment,
  // mandate mode
  createMandateOrder,
  verifyMandate,
  selectPlanAndCharge,
};