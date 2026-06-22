// controllers/cartController.js
// Single-payment checkout for Plan + Add-ons together.
//
//   POST /api/razorpay/cart/create-order
//     Body: { plan?, billing?, addons: [{addonType, quantity, autoRenew}] }
//     → creates ONE Razorpay order for the combined total
//
//   POST /api/razorpay/cart/verify-payment
//     Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
//             plan?, billing?, addons: [{addonType, quantity, autoRenew}] }
//     → verifies signature, activates plan upgrade + all addons atomically,
//       creates a single combined Payment invoice record.
//
// Security: prices are ALWAYS read from AddonCatalog / PLANS on the server.
// The client only sends names + quantities — never amounts.

const Razorpay  = require("razorpay");
const crypto    = require("crypto");

const Company       = require("../models/Company");
const Payment       = require("../models/Payment");
const AddonCatalog  = require("../models/AddonCatalog");
const CompanyAddon  = require("../models/CompanyAddon");
const { computeAddonExpiry } = require("../models/CompanyAddon");
const { logAudit }  = require("../services/entitlementService");
const { sendAddonReceipt } = require("../services/addonReceiptService");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Plan pricing — mirrors razorpayController.js PLANS
const PLANS = {
  starter: { id: "starter", name: "Starter",  monthlyPrice: 999,  yearlyPrice: 799,  dbPlan: "basic"   },
  growth:  { id: "growth",  name: "Growth",   monthlyPrice: 2499, yearlyPrice: 1999, dbPlan: "pro"     },
  advance: { id: "advance", name: "Advance",  monthlyPrice: 5999, yearlyPrice: 4799, dbPlan: "advance" },
};

// Resolve a buyable catalogue row (same guard as addonPaymentController)
async function resolveBuyableAddon(addonType, planKey) {
  const item = await AddonCatalog.findOne({ addonType, isPublic: true, isActive: true });
  if (!item) return null;
  if (typeof item.isVisibleForPlan === "function" && !item.isVisibleForPlan(planKey)) return null;
  return item;
}

function makeInvoiceId(prefix = "CART") {
  const now = new Date();
  return `${prefix}-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-5)}`;
}

// ── POST /api/razorpay/cart/create-order ──────────────────────────────────────
const createCartOrder = async (req, res) => {
  try {
    const { plan, billing = "monthly", addons = [] } = req.body;

    const company = req.admin?.company;
    if (!company?._id) {
      return res.status(401).json({ success: false, message: "No company context" });
    }

    // Must have at least a plan or one addon
    if (!plan && (!Array.isArray(addons) || addons.length === 0)) {
      return res.status(400).json({ success: false, message: "Cart is empty — add a plan or at least one add-on." });
    }

    let totalAmount = 0;
    const lineItems = [];

    // ── Plan line item ────────────────────────────────────────────────────────
    if (plan) {
      if (plan === "enterprise") {
        return res.status(400).json({ success: false, message: "Enterprise is a custom plan. Please contact sales." });
      }
      const planDef = PLANS[plan];
      if (!planDef) {
        return res.status(400).json({ success: false, message: `Unknown plan: ${plan}` });
      }
      const planPrice = billing === "yearly" ? planDef.yearlyPrice : planDef.monthlyPrice;
      totalAmount += planPrice;
      lineItems.push({ type: "plan", planId: plan, planName: planDef.name, billing, price: planPrice });
    }

    // ── Addon line items ──────────────────────────────────────────────────────
    const resolvedAddons = [];
    for (const a of addons) {
      if (!a.addonType) continue;
      const item = await resolveBuyableAddon(a.addonType, company.plan);
      if (!item) {
        return res.status(400).json({
          success: false,
          message: `Add-on "${a.addonType}" is not available for purchase on your plan.`,
        });
      }
      const qty = Math.min(Math.max(1, parseInt(a.quantity, 10) || 1), item.maxQuantity || 1);
      const wantsAutoRenew = item.category !== "credit" && !!a.autoRenew &&
        (item.renewalMode === "optional" || item.renewalMode === "required");
      const linePrice = Math.round(item.price * qty);
      if (linePrice <= 0) {
        return res.status(400).json({ success: false, message: `Add-on "${item.name}" has no purchasable price set.` });
      }
      totalAmount += linePrice;
      resolvedAddons.push({ item, qty, autoRenew: wantsAutoRenew, price: linePrice });
      lineItems.push({
        type: "addon", addonType: a.addonType, addonName: item.name,
        quantity: qty, autoRenew: wantsAutoRenew,
        billingPeriod: item.billingPeriod, price: linePrice,
      });
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Order total must be greater than zero." });
    }

    // Create ONE Razorpay order for the full cart total
    const order = await razorpay.orders.create({
      amount:   totalAmount * 100,   // paise
      currency: "INR",
      receipt:  `cart_${Date.now()}`,
      notes: {
        kind:      "cart",
        companyId: company._id.toString(),
        plan:      plan || "",
        billing,
        addons:    JSON.stringify(addons.map(a => ({ t: a.addonType, q: a.quantity || 1 }))),
      },
    });

    return res.status(200).json({
      success:     true,
      orderId:     order.id,
      amount:      order.amount,           // paise
      currency:    order.currency,
      keyId:       process.env.RAZORPAY_KEY_ID,
      totalAmount,                          // rupees
      lineItems,
    });
  } catch (err) {
    console.error("[createCartOrder]", err);
    return res.status(500).json({ success: false, message: "Failed to create cart order" });
  }
};

// ── POST /api/razorpay/cart/verify-payment ────────────────────────────────────
const verifyCartPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan,
      billing = "monthly",
      addons = [],
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification fields" });
    }

    // Verify signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification failed: invalid signature" });
    }

    const company = req.admin?.company;
    if (!company?._id) {
      return res.status(401).json({ success: false, message: "No company context" });
    }

    const companyId = company._id;
    const now = new Date();
    let totalAmount = 0;
    const activatedItems = [];

    // ── Activate plan upgrade ─────────────────────────────────────────────────
    if (plan) {
      const planDef = PLANS[plan];
      if (!planDef) {
        return res.status(400).json({ success: false, message: `Unknown plan: ${plan}` });
      }
      const planPrice = billing === "yearly" ? planDef.yearlyPrice : planDef.monthlyPrice;
      totalAmount += planPrice;

      const existingCompany = await Company.findById(companyId).select("subscriptionExpiry subscriptionStatus");
      const currentExpiry   = existingCompany?.subscriptionExpiry ? new Date(existingCompany.subscriptionExpiry) : null;
      const baseDate        = currentExpiry && currentExpiry > now ? currentExpiry : now;
      const newExpiry       = new Date(baseDate);
      if (billing === "yearly") newExpiry.setFullYear(newExpiry.getFullYear() + 1);
      else                       newExpiry.setMonth(newExpiry.getMonth() + 1);

      await Company.findByIdAndUpdate(companyId, {
        plan:               planDef.dbPlan,
        subscriptionStatus: "active",
        subscriptionExpiry: newExpiry,
        isActive:           true,
      });

      activatedItems.push({ type: "plan", name: planDef.name, billing, price: planPrice, newExpiry });

      logAudit({
        companyId,
        actorId:   req.admin?._id || null,
        actorRole: "super_admin",
        action:    "plan_changed",
        field:     "plan",
        newValue:  { plan: planDef.dbPlan, billing, expiresAt: newExpiry },
        reason:    `Cart checkout: upgraded to ${planDef.name} (${billing})`,
      }).catch(() => {});
    }

    // ── Activate addons ───────────────────────────────────────────────────────
    const activatedAddonNames = [];
    for (const a of addons) {
      if (!a.addonType) continue;
      const item = await resolveBuyableAddon(a.addonType, company.plan);
      if (!item) continue;   // skip unavailable; plan was already upgraded above

      const qty = Math.min(Math.max(1, parseInt(a.quantity, 10) || 1), item.maxQuantity || 1);
      const willAutoRenew = item.category !== "credit" && !!a.autoRenew &&
        (item.renewalMode === "optional" || item.renewalMode === "required");
      const linePrice  = Math.round(item.price * qty);
      const startDate  = now;
      const expiryDate = computeAddonExpiry({ addonType: a.addonType, billingPeriod: item.billingPeriod, startDate });

      await CompanyAddon.create({
        companyId,
        addonType:      a.addonType,
        quantity:       qty,
        startDate,
        expiryDate,
        status:         "active",
        paymentStatus:  "paid",
        price:          linePrice,
        currency:       item.currency || "INR",
        autoRenew:      willAutoRenew,
        createdBy:      req.admin?._id || null,
        createdByModel: "Admin",
        notes:          `Cart checkout via Razorpay (${razorpay_payment_id})${willAutoRenew ? " — auto-renew" : ""}`,
      });

      totalAmount += linePrice;
      activatedItems.push({ type: "addon", name: item.name, quantity: qty, price: linePrice, expiryDate, autoRenew: willAutoRenew });
      activatedAddonNames.push(`${item.name}${qty > 1 ? ` × ${qty}` : ""}`);

      logAudit({
        companyId,
        actorId:   req.admin?._id || null,
        actorRole: "super_admin",
        action:    "addon_purchased",
        field:     "addonType",
        newValue:  a.addonType,
        reason:    `Cart checkout: ${item.name} × ${qty} @ ${item.currency} ${linePrice}`,
      }).catch(() => {});
    }

    // ── Single combined payment record ────────────────────────────────────────
    const invoiceId = makeInvoiceId("CART");
    const planItem  = activatedItems.find(i => i.type === "plan");
    const planLabel = planItem ? planItem.name : "Add-ons only";
    const addonLabel = activatedAddonNames.length ? ` + ${activatedAddonNames.join(", ")}` : "";

    await Payment.create({
      company:           companyId,
      invoiceId,
      planId:            plan || "addon",
      planName:          `${planLabel}${addonLabel}`,
      billing:           billing || "one_time",
      amount:            totalAmount,
      razorpayOrderId:   razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      status:            "paid",
    }).catch(e => console.error("[verifyCartPayment] payment record failed:", e.message));

    // ── Notify frontend to refresh entitlements ───────────────────────────────
    // (The client fires window "entitlements_updated" after receiving success)

    return res.status(200).json({
      success:       true,
      invoiceId,
      totalAmount,
      transactionId: razorpay_payment_id,
      activatedItems,
      planActivated:   !!plan,
      addonsActivated: activatedAddonNames,
    });
  } catch (err) {
    console.error("[verifyCartPayment]", err);
    return res.status(500).json({ success: false, message: "Cart payment verification server error" });
  }
};

module.exports = { createCartOrder, verifyCartPayment };
