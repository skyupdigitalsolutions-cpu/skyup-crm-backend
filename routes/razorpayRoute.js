const express = require("express");
const router = express.Router();

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  createOrder,
  verifyPayment,
  getInvoices,
  getSubscription,
} = require("../controllers/razorpayController");

// All routes require a logged-in admin
router.use(protectAdmin);

// Create a Razorpay order (called before showing the payment modal)
router.post("/create-order", createOrder);

// Verify payment after Razorpay callback + upgrade plan
router.post("/verify-payment", verifyPayment);

// Get invoice history for the company
router.get("/invoices", getInvoices);

// Get current subscription summary
router.get("/subscription", getSubscription);

module.exports = router;