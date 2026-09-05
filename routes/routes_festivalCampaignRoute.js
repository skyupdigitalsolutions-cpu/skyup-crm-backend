// routes/festivalCampaignRoute.js
// Company-admin routes for scheduling festive WhatsApp/Email template blasts.
// Gated behind the same "whatsappBlast" entitlement as the manual WhatsApp
// bulk-blast feature, since this is fundamentally a scheduled variant of it.

const express = require("express");
const router  = express.Router();

const {
  getCatalog,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  toggleCampaign,
  deleteCampaign,
  cancelCampaign,
  testCampaign,
} = require("../controllers/festivalCampaignController");

const {
  getSettings: getAutoBlastSettings,
  updateSettings: updateAutoBlastSettings,
  testSettings: testAutoBlastSettings,
} = require("../controllers/festivalAutoBlastController");

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

router.use(protectAdmin, requireFeature("whatsappBlast"));

// ── Festival Auto-Blast — the "flip it on once" fully-automatic path ─────────
// No manual per-festival campaign needed: every template in
// utils/festivalTemplateCatalog.js fires automatically on its date once this
// is enabled. Registered BEFORE the "/:id" routes below so "auto-blast" is
// never swallowed as an :id param.
router.get("/auto-blast",       getAutoBlastSettings);
router.put("/auto-blast",       updateAutoBlastSettings);
router.post("/auto-blast/test", testAutoBlastSettings);

router.get("/catalog",        getCatalog);
router.get("/",                listCampaigns);
router.get("/:id",             getCampaign);
router.post("/",               createCampaign);
router.put("/:id",             updateCampaign);
router.patch("/:id/toggle",    toggleCampaign);
router.post("/:id/cancel",     cancelCampaign);
router.post("/:id/test",       testCampaign);
router.delete("/:id",          deleteCampaign);

module.exports = router;
