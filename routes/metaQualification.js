// routes/metaQualification.js
const express = require("express");
const router  = express.Router();
const {
  getQualificationRules,
  saveQualificationRules,
  getFormQuestions,
} = require("../controllers/metaQualificationController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// All routes are admin-protected; company is derived from req.admin inside the controller.

// GET  /api/meta-qualification/:adSetId  — fetch saved rules for an ad set
router.get("/:adSetId",  protectAdmin, getQualificationRules);

// POST /api/meta-qualification/:adSetId  — create or replace rules for an ad set
router.post("/:adSetId", protectAdmin, saveQualificationRules);

module.exports = router;
