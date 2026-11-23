// routes/quotationRoutes.js — quotation endpoints for the web app. Behind the CRM's protect auth.
const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const c = require("../controllers/quotationController");

router.use(protect);
router.get("/", c.listQuotations);
router.post("/", c.createQuotation);
router.post("/upload", c.uploadQuotation);
router.get("/:id", c.getQuotation);
router.put("/:id", c.updateQuotation);
router.delete("/:id", c.deleteQuotation);

module.exports = router;
