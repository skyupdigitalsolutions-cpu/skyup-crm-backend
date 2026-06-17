// routes/trialRoute.js
// Endpoints for the 7-day Pro trial. Supports two billing modes (see
// controllers/trialController.js → TRIAL_BILLING_MODE):
//   • onetime  — start trial free, pay per-plan via one-time Checkout
//   • mandate  — save a card mandate up front, auto-charge later (needs recurring)
// All routes require a logged-in admin (super_admin manages billing).

const express = require("express");
const router  = express.Router();

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getTrialStatus,
  // onetime mode
  startTrial,
  createPlanOrder,
  verifyPlanPayment,
  // mandate mode
  createMandateOrder,
  verifyMandate,
  selectPlanAndCharge,
} = require("../controllers/trialController");

router.use(protectAdmin);

// Which gate to show + which billing mode is active
router.get("/status", getTrialStatus);

// ── Onetime mode ──────────────────────────────────────────────────────────────
// Start the free trial immediately (no card collected)
router.post("/start", startTrial);
// Pick a plan after the trial → one-time Razorpay Checkout
router.post("/select-plan/create-order", createPlanOrder);
router.post("/select-plan/verify",       verifyPlanPayment);

// ── Mandate mode (requires Razorpay Recurring Payments enabled) ────────────────
router.post("/mandate/create-order", createMandateOrder);
router.post("/mandate/verify",       verifyMandate);
// Silent auto-charge against the saved mandate token
router.post("/select-plan", selectPlanAndCharge);

module.exports = router;