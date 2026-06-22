const express = require("express");
const router  = express.Router();

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { createOrder, verifyPayment, getInvoices, getSubscription } = require("../controllers/razorpayController");
const { createAddonOrder, verifyAddonPayment } = require("../controllers/addonPaymentController");
const { createCartOrder, verifyCartPayment }   = require("../controllers/cartController");

router.use(protectAdmin);

// ── Plan-only checkout (legacy — kept for backward compat) ────────────────────
router.post("/create-order",   createOrder);
router.post("/verify-payment", verifyPayment);

// ── Billing history ───────────────────────────────────────────────────────────
router.get("/invoices",     getInvoices);
router.get("/subscription", getSubscription);

// ── Addon-only self-serve (legacy — kept for direct addon buys) ───────────────
router.post("/addon/create-order",   createAddonOrder);
router.post("/addon/verify-payment", verifyAddonPayment);

// ── Cart checkout: plan + addons in ONE payment ───────────────────────────────
router.post("/cart/create-order",   createCartOrder);
router.post("/cart/verify-payment", verifyCartPayment);

module.exports = router;
