const express = require("express");
const router  = express.Router();
const { receiveWebsiteWebhook } = require("../controllers/websiteWebhookController");

router.post("/", receiveWebsiteWebhook); // ✅ was "/website-webhook" — caused double path

module.exports = router;