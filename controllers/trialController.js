// controllers/trialController.js
// ─────────────────────────────────────────────────────────────────────────────
// 7-DAY PRO FREE TRIAL + RAZORPAY AUTO-BILLING
//
// Flow:
//   1. A company is created in "trial_pending" status on the Pro plan (locked /
//      read-only) until the customer registers a payment method.
//   2. POST /api/trial/mandate/create-order
//        → creates a Razorpay customer + an authorization order (a small,
//          configurable auth amount) that registers a recurring mandate token.
//   3. Frontend opens Razorpay Checkout with { order_id, customer_id, recurring:1 }.
//   4. POST /api/trial/mandate/verify
//        → verifies the signature, fetches the saved token_id, stores it on the
//          company, and STARTS the 7-day Pro trial (status → "trial").
//   5. Cron (jobs/trialExpiryJob.js) expires the trial after 7 days and emails
//      the customer ("trial expired — pick a plan").
//   6. POST /api/trial/select-plan
//        → server-side recurring charge against the saved token (NO customer
//          interaction), then upgrades the plan + sets a real expiry.
//
// PREREQUISITES (Razorpay dashboard):
//   • "Recurring Payments" must be enabled on the account.
//   • Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (already used elsewhere).
//   • Optional env:
//       TRIAL_MANDATE_AUTH_AMOUNT  (paise, default 500 = ₹5 authorization)
//       TRIAL_MANDATE_MAX_AMOUNT   (paise, default 1000000 = ₹10,000 max debit)
//       TRIAL_DAYS                 (default 7)
//   The auth amount is the standard token-registration transaction required by
//   card networks; many merchants refund it. Set to your account's policy.
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

const TRIAL_DAYS         = Number(process.env.TRIAL_DAYS || 7);
const AUTH_AMOUNT_PAISE  = Number(process.env.TRIAL_MANDATE_AUTH_AMOUNT || 500);      // ₹5
const MAX_AMOUNT_PAISE   = Number(process.env.TRIAL_MANDATE_MAX_AMOUNT  || 1000000);  // ₹10,000

// Plan source-of-truth (mirrors razorpayController.PLANS). frontend planId →
// Company plan enum mapping is handled below.
const PLANS = {
  starter: { id: "starter", name: "Starter", monthlyPrice: 999,  yearlyPrice: 799  },
  growth:  { id: "growth",  name: "Pro",     monthlyPrice: 2499, yearlyPrice: 1999 },
  advance: { id: "advance", name: "Advance", monthlyPrice: 5999, yearlyPrice: 4799 },
};
const PLAN_ENUM_MAP = { starter: "basic", growth: "pro", advance: "advance" };

const _companyId = (req) => req.admin?.company?._id ?? req.admin?.company;

// Razorpay's `contact` field only accepts digits and an optional leading "+".
// Phone numbers in the CRM may contain spaces, dashes, parentheses, etc., which
// trigger: "Contact number contains invalid characters". This normalises the
// value and returns undefined if nothing usable remains, so we simply omit the
// (optional) contact rather than send an invalid one.
const sanitizeContact = (raw) => {
  if (!raw) return undefined;
  let s = String(raw).trim();
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");        // strip everything non-digit
  if (digits.length < 8 || digits.length > 15) return undefined; // not a valid phone
  return hasPlus ? `+${digits}` : digits;
};

// ─── GET /api/trial/status ────────────────────────────────────────────────────
// Tells the frontend which gate (if any) to show.
const getTrialStatus = async (req, res) => {
  try {
    const company = await Company.findById(_companyId(req))
      .select(
        "name email plan subscriptionStatus subscriptionExpiry trialEndsAt " +
        "paymentMethodProvided trialPlan trialStartedAt"
      );
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const now = new Date();
    const trialActive  = company.subscriptionStatus === "trial" && company.trialEndsAt && now < company.trialEndsAt;
    const trialExpired =
      company.paymentMethodProvided &&
      (company.subscriptionStatus === "expired" ||
        (company.trialEndsAt && now >= company.trialEndsAt && company.subscriptionStatus !== "active"));

    const daysRemaining = company.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(company.trialEndsAt) - now) / 86_400_000))
      : null;

    res.json({
      success: true,
      status:                company.subscriptionStatus,
      plan:                  company.plan,
      trialPlan:             company.trialPlan || "pro",
      paymentMethodProvided: company.paymentMethodProvided,
      // What the UI should do:
      needsPaymentMethod:    company.subscriptionStatus === "trial_pending" && !company.paymentMethodProvided,
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

// ─── POST /api/trial/mandate/create-order ─────────────────────────────────────
// Creates a Razorpay customer + an authorization order that registers a
// recurring mandate token. Returns what the frontend needs for Checkout.
const createMandateOrder = async (req, res) => {
  try {
    const company = await Company.findById(_companyId(req)).select("name email phone razorpayCustomerId");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Reuse an existing Razorpay customer if we already have one for this company.
    let customerId = company.razorpayCustomerId;
    if (!customerId) {
      const customer = await razorpay.customers.create({
        name:          company.name,
        email:         company.email,
        contact:       sanitizeContact(company.phone),
        fail_existing: 0, // return the existing customer instead of erroring
      });
      customerId = customer.id;
      company.razorpayCustomerId = customerId;
      await company.save();
    }

    // Authorization order with a token block → registers a reusable mandate.
    const order = await razorpay.orders.create({
      amount:      AUTH_AMOUNT_PAISE,
      currency:    "INR",
      customer_id: customerId,
      method:      "card",                 // card mandate; UPI Autopay also supported by Checkout
      receipt:     `mandate_${Date.now()}`,
      token: {
        max_amount: MAX_AMOUNT_PAISE,
        expire_at:  Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60, // ~10 years
        frequency:  "monthly",
      },
      notes: { companyId: String(company._id), purpose: "trial_mandate" },
    });

    res.json({
      success:     true,
      orderId:     order.id,
      customerId,
      amount:      order.amount,
      currency:    order.currency,
      keyId:       process.env.RAZORPAY_KEY_ID,
      recurring:   1,
      authAmount:  AUTH_AMOUNT_PAISE,
    });
  } catch (err) {
    console.error("[Trial] create-mandate-order error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to create mandate authorization order" });
  }
};

// ─── POST /api/trial/mandate/verify ───────────────────────────────────────────
// Verifies the authorization, stores the saved token, starts the 7-day trial.
const verifyMandate = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing verification fields" });
    }

    // 1. Verify signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    // 2. Resolve the saved token from the authorization payment
    let tokenId = null;
    let customerId = null;
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      tokenId    = payment?.token_id || null;
      customerId = payment?.customer_id || null;
    } catch (e) {
      console.error("[Trial] fetch payment for token failed:", e?.error || e.message);
    }

    const company = await Company.findById(_companyId(req))
      .select("name email razorpayCustomerId razorpayTokenId paymentMethodProvided trialPlan");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    // Fallback: if token_id wasn't on the payment, pull the latest token for the customer.
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

    // 3. Start the 7-day Pro trial
    const now         = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const trialPlan   = company.trialPlan || "pro";

    company.razorpayCustomerId    = customerId || company.razorpayCustomerId;
    company.razorpayTokenId       = tokenId;
    company.paymentMethodProvided = true;
    company.plan                  = trialPlan;
    company.subscriptionStatus    = "trial";
    company.trialStartedAt        = now;
    company.trialEndsAt           = trialEndsAt;
    company.trialExpiredEmailSent = false;
    company.isActive              = true;
    await company.save();

    // 4. Welcome / trial-started email (non-blocking)
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

    res.json({
      success:     true,
      message:     `Payment method saved. Your ${TRIAL_DAYS}-day free trial is now active.`,
      plan:        trialPlan,
      status:      "trial",
      trialEndsAt,
    });
  } catch (err) {
    console.error("[Trial] verify-mandate error:", err?.error || err);
    res.status(500).json({ success: false, message: "Mandate verification failed" });
  }
};

// ─── POST /api/trial/select-plan ──────────────────────────────────────────────
// Charges the saved token server-side (no customer interaction) and activates
// the chosen plan. Works both during the trial (early upgrade) and after it
// expired. Body: { planId: "starter"|"growth"|"advance", billing: "monthly"|"yearly" }
const selectPlanAndCharge = async (req, res) => {
  try {
    const { planId, billing = "monthly" } = req.body;
    if (!planId || !PLANS[planId]) {
      return res.status(400).json({ success: false, message: "Invalid plan selected" });
    }
    if (!["monthly", "yearly"].includes(billing)) {
      return res.status(400).json({ success: false, message: "Invalid billing cycle" });
    }

    const company = await Company.findById(_companyId(req))
      .select(
        "name email phone razorpayCustomerId razorpayTokenId paymentMethodProvided " +
        "subscriptionExpiry subscriptionStatus plan"
      );
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    if (!company.paymentMethodProvided || !company.razorpayTokenId || !company.razorpayCustomerId) {
      return res.status(400).json({
        success: false,
        code:    "NO_PAYMENT_METHOD",
        message: "No saved payment method. Please add a payment method first.",
      });
    }

    const plan       = PLANS[planId];
    const amountRupee = billing === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
    const amountPaise = amountRupee * 100;

    // 1. Create an order tied to the customer
    const order = await razorpay.orders.create({
      amount:         amountPaise,
      currency:       "INR",
      customer_id:    company.razorpayCustomerId,
      payment_capture: 1,
      receipt:        `plan_${Date.now()}`,
      notes:          { companyId: String(company._id), planId, billing, purpose: "trial_auto_bill" },
    });

    // 2. Server-side recurring charge against the saved token
    let payment;
    try {
      payment = await razorpay.payments.createRecurringPayment({
        email:       company.email,
        contact:     sanitizeContact(company.phone),
        amount:      amountPaise,
        currency:    "INR",
        order_id:    order.id,
        customer_id: company.razorpayCustomerId,
        token:       company.razorpayTokenId,
        recurring:   "1",
        description: `${plan.name} plan (${billing})`,
      });
    } catch (chargeErr) {
      console.error("[Trial] recurring charge failed:", chargeErr?.error || chargeErr);
      return res.status(402).json({
        success: false,
        code:    "CHARGE_FAILED",
        message:
          chargeErr?.error?.description ||
          "Automatic payment could not be completed. Please update your payment method.",
      });
    }

    const paymentId = payment?.razorpay_payment_id || payment?.id;
    if (!paymentId) {
      return res.status(402).json({ success: false, code: "CHARGE_FAILED", message: "Payment was not captured." });
    }

    // 3. Record the payment
    const now       = new Date();
    const invoiceId = `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-4)}`;
    await Payment.create({
      company:           company._id,
      invoiceId,
      planId,
      planName:          plan.name,
      billing,
      amount:            amountRupee,
      razorpayOrderId:   order.id,
      razorpayPaymentId: paymentId,
      status:            "paid",
    });

    // 4. Activate the plan + extend expiry (extend from existing future expiry if any)
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

    res.json({
      success:       true,
      message:       `${plan.name} plan activated.`,
      invoiceId,
      transactionId: paymentId,
      planName:      plan.name,
      amount:        amountRupee,
      billing,
      newExpiry,
      status:        "active",
    });
  } catch (err) {
    console.error("[Trial] select-plan error:", err?.error || err);
    res.status(500).json({ success: false, message: "Failed to activate plan" });
  }
};

module.exports = {
  getTrialStatus,
  createMandateOrder,
  verifyMandate,
  selectPlanAndCharge,
};