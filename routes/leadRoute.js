const express = require("express");
const router = express.Router();
const Lead = require("../models/Leads");
const { getLead, getLeads, createLead, updateLead, deleteLead } = require("../controllers/leadController");
const { protect } = require("../middlewares/authMiddleware");

router.get("/:id", protect, getLead);

router.get("/", protect ,getLeads);

router.post("/", protect, createLead);

router.delete("/:id", protect ,deleteLead);

router.put("/:id", protect ,updateLead);

module.exports = router;