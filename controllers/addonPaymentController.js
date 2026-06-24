// controllers/addonPaymentController.js — NEW FILE
// Self-serve add-on purchase via Razorpay, for company admins.
//
//   POST /api/razorpay/addon/create-order   { addonType, quantity? }
//   POST /api/razorpay/addon/verify-payment  { razorpay_*, addonType, quantity? }
//
// SECURITY: the price is ALWAYS read from AddonCatalog on the server. The client
// never sends an amount — it only names the addonType + quantity. This prevents
// a tampered client from buying a ₹699 feature for ₹1.
//
// On verified payment we create a CompanyAddon (paymentStatus:"paid"), which the
// existing entitlementService aggregates into the company's live entitlements —
// so the feature/limit turns on immediately, no extra wiring needed.

const Razorpay = require("razorpay");
const crypto   = require("crypto");

const AddonCatalog = require("../models/AddonCatalog");
const CompanyAddon = require("../models/CompanyAddon");
const { computeAddonExpiry } = require("../models/CompanyAddon");
const { sendAddonReceipt }   = require("../services/addonReceiptService");
const Company      = require("../models/Company");
const Payment      = require("../models/Payment");
const { logAudit } = require("../services/entitlementService");
const { nextInvoiceNumber, fallbackInvoiceNumber } = require("../utils/invoiceNumber");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Resolve a buyable catalogue row for this company's plan, or null.
async function resolveBuyableAddon(addonType, planKey) {
  const item = await AddonCatalog.findOne({ addonType, isPublic: true, isActive: true });
  if (!item) return null;
  if (!item.isVisibleForPlan(planKey)) return null;
  return item;
}

// ── POST /api/razorpay/addon/create-order ─────────────────────────────────────
const createAddonOrder = async (req, res) => {
  try {
    const { addonType, quantity = 1, autoRenew = false } = req.body;
    if (!addonType) {
      return res.status(400).json({ success: false, message: "addonType is required" });
    }

    const company = req.admin?.company;
    if (!company?._id) {
      return res.status(401).json({ success: false, message: "No company context" });
    }

    const item = await resolveBuyableAddon(addonType, company.plan);
    if (!item) {
      return res.status(400).json({ success: false, message: "This add-on is not available for purchase on your plan." });
    }

    const qty = Math.min(
      Math.max(1, parseInt(quantity, 10) || 1),
      item.maxQuantity || 1
    );

    // Credit packs never auto-renew — enforce server-side regardless of client value.
    const wantsAutoRenew = item.category !== "credit" && !!autoRenew &&
      (item.renewalMode === "optional" || item.renewalMode === "required");

    const amount = Math.round(item.price * qty);
    if (amount <= 0) {
      return res.status(400).json({ success: false, message: "This add-on has no purchasable price set." });
    }

    const order = await razorpay.orders.create({
      amount:   amount * 100,           // paise
      currency: item.currency || "INR",
      receipt:  `addon_${Date.now()}`,
      notes: {
        kind:        "addon",
        addonType,
        quantity:    String(qty),
        autoRenew:   String(wantsAutoRenew),
        companyId:   company._id.toString(),
      },
    });

    return res.status(200).json({
      success:     true,
      orderId:     order.id,
      amount:      order.amount,
      currency:    order.currency,
      keyId:       process.env.RAZORPAY_KEY_ID,
      addonName:   item.name,
      quantity:    qty,
      autoRenew:   wantsAutoRenew,
      renewalMode: item.renewalMode || "none",
    });
  } catch (err) {
    console.error("[createAddonOrder]", err);
    return res.status(500).json({ success: false, message: "Failed to create add-on order" });
  }
};

// ── POST /api/razorpay/addon/verify-payment ───────────────────────────────────
const verifyAddonPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      addonType,
      quantity = 1,
      autoRenew = false,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !addonType) {
      return res.status(400).json({ success: false, message: "Missing payment verification fields" });
    }

    // ── Verify signature ─────────────────────────────────────────────────────
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

    // Re-resolve price server-side (never trust client amount).
    const item = await resolveBuyableAddon(addonType, company.plan);
    if (!item) {
      return res.status(400).json({ success: false, message: "Add-on no longer available for purchase." });
    }

    const qty = Math.min(
      Math.max(1, parseInt(quantity, 10) || 1),
      item.maxQuantity || 1
    );
    const amount = Math.round(item.price * qty);

    // Credit packs NEVER auto-renew — enforce server-side.
    const willAutoRenew = item.category !== "credit" && !!autoRenew &&
      (item.renewalMode === "optional" || item.renewalMode === "required");

    // ── Compute expiry ───────────────────────────────────────────────────────
    const startDate  = new Date();
    const expiryDate = computeAddonExpiry({
      addonType,
      billingPeriod: item.billingPeriod,
      startDate,
    });

    // ── Create the addon (turns the entitlement on) ──────────────────────────
    const addon = await CompanyAddon.create({
      companyId:      company._id,
      addonType,
      quantity:       qty,
      startDate,
      expiryDate,
      status:         "active",
      paymentStatus:  "paid",
      price:          amount,
      currency:       item.currency || "INR",
      autoRenew:      willAutoRenew,
      createdBy:      req.admin?._id || null,
      createdByModel: "Admin",
      notes:          `Self-serve purchase via Razorpay (${razorpay_payment_id})${willAutoRenew ? " — auto-renew enabled" : ""}`,
    });

    // ── Invoice record (mirrors plan payments) ───────────────────────────────
    const now = new Date();
    let invoiceId;
    try {
      invoiceId = await nextInvoiceNumber();
    } catch (e) {
      console.error("[addonPayment] invoice numbering failed:", e.message);
      invoiceId = fallbackInvoiceNumber();
    }

    try {
      await Payment.create({
        company:           company._id,
        invoiceId,
        planId:            "addon",
        planName:          `Add-on: ${item.name}${qty > 1 ? ` × ${qty}` : ""}`,
        billing:           item.billingPeriod,
        amount,
        razorpayOrderId:   razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        status:            "paid",
      });
    } catch (e) {
      // Non-fatal: addon is already active; invoice row is best-effort.
      console.error("[verifyAddonPayment] invoice create failed:", e.message);
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    logAudit({
      companyId: company._id,
      actorId:   req.admin?._id || null,
      actorRole: "super_admin",
      action:    "addon_purchased",
      field:     "addonType",
      newValue:  addonType,
      reason:    `Self-serve paid: ${item.name} × ${qty} @ ${item.currency} ${amount}`,
    }).catch(e => console.error("[verifyAddonPayment] audit failed:", e.message));

    // ── Email receipt to the customer (company email + super_admins) ──────────
    // Fire-and-forget: the add-on is already active and the invoice row exists,
    // so a receipt failure must not affect the purchase response.
    sendAddonReceipt({
      companyId:     company._id,
      addonName:     item.name,
      quantity:      qty,
      billing:       item.billingPeriod,
      expiryDate,
      actionType:    "purchase",
      invoiceId,
      amount,
      transactionId: razorpay_payment_id,
      paymentDate:   now,
    }).catch(e => console.error("[verifyAddonPayment] receipt failed:", e.message));

    return res.status(200).json({
      success:    true,
      invoiceId,
      addonType,
      addonName:  item.name,
      quantity:   qty,
      amount,
      currency:   item.currency || "INR",
      expiryDate,
      autoRenew:  willAutoRenew,
      transactionId: razorpay_payment_id,
    });
  } catch (err) {
    console.error("[verifyAddonPayment]", err);
    return res.status(500).json({ success: false, message: "Add-on payment verification server error" });
  }
};

module.exports = { createAddonOrder, verifyAddonPayment };
