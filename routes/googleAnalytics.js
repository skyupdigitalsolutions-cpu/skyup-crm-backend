// routes/googleAnalytics.js
const express = require("express");
const router  = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getStatus, getConnectUrl, oauthCallback, listProperties, saveProperty, disconnect, getDashboard,
} = require("../controllers/googleAnalyticsController");

// PUBLIC: Google redirects the browser here (no app JWT). Secured by signed `state`.
router.get("/callback", oauthCallback);

// Admin-only
router.get("/status",      protectAdmin, getStatus);
router.get("/connect-url", protectAdmin, getConnectUrl);
router.get("/properties",  protectAdmin, listProperties);
router.post("/property",   protectAdmin, saveProperty);
router.get("/dashboard",   protectAdmin, getDashboard);
router.delete("/",         protectAdmin, disconnect);

module.exports = router;