// routes/customizationRoute.js — per-company CRM customization (READ ONLY)
// Mounted at /api/customization (see server.js).
//
// Companies only READ their configuration here. All editing happens in the
// developer panel: /api/developer/companies/:id/customization/* (developerRoutes.js).
const express = require("express");
const router  = express.Router();
const { protectAny } = require("../middlewares/authMiddleware");
const c = require("../controllers/customizationController");

// Read — every signed-in user (admin web, employee web, mobile app).
router.get("/",     protectAny, c.getMine);
router.get("/meta", protectAny, c.getMeta);

module.exports = router;
