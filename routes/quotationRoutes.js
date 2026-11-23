// routes/quotationRoutes.js — quotation endpoints. protectAny so both the
// employee web app AND the admin Lead Management page can use them (plain
// `protect` rejects admin / super_admin tokens with 403).
const express = require("express");
const router = express.Router();
const { protectAny } = require("../middlewares/authMiddleware");
const c = require("../controllers/quotationController");

router.use(protectAny);
router.get("/", c.listQuotations);
router.post("/", c.createQuotation);
router.post("/upload", c.uploadQuotation);
router.get("/:id", c.getQuotation);
router.put("/:id", c.updateQuotation);
router.delete("/:id", c.deleteQuotation);

module.exports = router;
