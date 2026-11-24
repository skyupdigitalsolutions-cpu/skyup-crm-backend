// routes/quotationRoutes.js — quotation endpoints. protectAny so both the
// employee web app AND the admin Lead Management page can use them (plain
// `protect` rejects admin / super_admin tokens with 403).
const express = require("express");
const router = express.Router();
const { protectAny } = require("../middlewares/authMiddleware");
const multer = require("multer");
const c = require("../controllers/quotationController");

// Ready-made quotation file (PDF or image), held in memory and streamed to the
// company's Cloudinary by the controller. JSON bodies (fileUrl) still work.
const ALLOWED = /\.(pdf|jpe?g|png|webp)$/i;
const quotationFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    ALLOWED.test(file.originalname || "")
      ? cb(null, true)
      : cb(new Error("Only PDF, JPG, PNG or WEBP files can be uploaded.")),
}).single("file");
const acceptFile = (req, res, next) =>
  quotationFile(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 15 MB." : err.message;
    res.status(400).json({ success: false, message });
  });

// Letterhead image only (printed behind every quotation page).
const letterheadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /\.(png|jpe?g|webp)$/i.test(file.originalname || "")
      ? cb(null, true)
      : cb(new Error("Upload the letterhead as a PNG, JPG or WEBP image. A PDF letterhead can be exported as an image first.")),
}).single("file");
const acceptLetterhead = (req, res, next) =>
  letterheadFile(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "The image is larger than 5 MB." : err.message });
  });

router.use(protectAny);
// settings routes must stay above "/:id"
router.get("/settings", c.getSettings);
router.get("/lead/:leadId/prefill", c.leadPrefill);   // client details for a new quotation
router.put("/settings", c.updateSettings);
router.post("/settings/letterhead", acceptLetterhead, c.uploadLetterhead);           // kind = letterhead
router.post("/settings/image/:kind", acceptLetterhead, c.uploadLetterhead);          // kind = letterhead | stamp

router.get("/", c.listQuotations);
router.post("/", c.createQuotation);
router.post("/upload", acceptFile, c.uploadQuotation);
router.get("/:id", c.getQuotation);
router.put("/:id", c.updateQuotation);
router.delete("/:id", c.deleteQuotation);

module.exports = router;
