// routes/googleAdsApi.js
const express = require("express");
const router  = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getStatus, getOAuthConfig, saveOAuthConfig, clearOAuthConfig,
  getConnectUrl, oauthCallback, listAccounts, saveAccount, sync, getReport, disconnect,
} = require("../controllers/googleAdsApiController");

// PUBLIC: Google redirects the browser here (secured by signed state)
router.get("/callback", oauthCallback);

// Admin-only
router.get("/status", protectAdmin, getStatus);

router.get("/oauth-config",    protectAdmin, getOAuthConfig);
router.post("/oauth-config",   protectAdmin, saveOAuthConfig);
router.delete("/oauth-config", protectAdmin, clearOAuthConfig);

router.get("/connect-url", protectAdmin, getConnectUrl);
router.get("/accounts",    protectAdmin, listAccounts);
router.post("/account",    protectAdmin, saveAccount);
router.post("/sync",       protectAdmin, sync);
router.get("/report",      protectAdmin, getReport);
router.delete("/",         protectAdmin, disconnect);

module.exports = router;
