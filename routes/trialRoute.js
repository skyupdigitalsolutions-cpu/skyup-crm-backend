// routes/trialRoute.js
// Endpoints for the 7-day Pro trial + Razorpay auto-billing flow.
// All routes require a logged-in admin (super_admin manages billing).

const express = require("express");
const router  = express.Router();

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getTrialStatus,
  createMandateOrder,
  verifyMandate,
  selectPlanAndCharge,
} = require("../controllers/trialController");

router.use(protectAdmin);

// Which gate to show (needs payment method / trial active / expired)
router.get("/status", getTrialStatus);

// Register a reusable payment method (mandate) and start the 7-day trial
router.post("/mandate/create-order", createMandateOrder);
router.post("/mandate/verify",       verifyMandate);

// Pick a plan after (or during) the trial → auto-charge the saved method
router.post("/select-plan", selectPlanAndCharge);

module.exports = router;