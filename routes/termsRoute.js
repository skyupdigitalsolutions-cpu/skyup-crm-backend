// routes/termsRoute.js
const express = require("express");
const router  = express.Router();

const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");
const {
  getCurrentTerms,
  acceptTerms,
  listTermsVersions,
  publishTerms,
} = require("../controllers/termsController");

// All terms routes require a logged-in identity of any panel.
router.use(protectUnified);

// Any logged-in user (developer included; controller exempts developers).
router.get("/current", getCurrentTerms);
router.post("/accept", acceptTerms);

// Developer-only management.
router.get("/admin/list",     authorizeRoles("developer"), listTermsVersions);
router.post("/admin/publish", authorizeRoles("developer"), publishTerms);

module.exports = router;
