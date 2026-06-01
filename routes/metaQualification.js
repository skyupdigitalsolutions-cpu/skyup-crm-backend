// routes/metaQualification.js
const express  = require("express");
const router   = express.Router();
const { getRules, saveRules } = require("../controllers/metaQualificationController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/meta-qualification/:adSetId  → fetch saved rules
// POST /api/meta-qualification/:adSetId  → upsert rules
router.get( "/:adSetId", protectAdmin, getRules);
router.post("/:adSetId", protectAdmin, saveRules);

module.exports = router;
