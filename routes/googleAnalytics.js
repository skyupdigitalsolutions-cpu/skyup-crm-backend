// routes/googleAnalytics.js
const express = require("express");
const router  = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getStatus, getOAuthConfig, saveOAuthConfig, clearOAuthConfig,
  getConnectUrl, oauthCallback, listProperties, saveProperty, disconnect, getDashboard,
} = require("../controllers/googleAnalyticsController");

// PUBLIC: Google redirects the browser here (no app JWT). Secured by signed `state`.
router.get("/callback", oauthCallback);

// Admin-only
router.get("/status",       protectAdmin, getStatus);

// OAuth app credentials (Client ID / Secret / Redirect URI) — set from the CRM UI
router.get("/oauth-config",    protectAdmin, getOAuthConfig);
router.post("/oauth-config",   protectAdmin, saveOAuthConfig);
router.delete("/oauth-config", protectAdmin, clearOAuthConfig);

router.get("/connect-url",  protectAdmin, getConnectUrl);
router.get("/properties",   protectAdmin, listProperties);
router.post("/property",    protectAdmin, saveProperty);
router.get("/dashboard",    protectAdmin, getDashboard);
router.delete("/",          protectAdmin, disconnect);

module.exports = router;
