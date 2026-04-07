const express = require("express");
const router  = express.Router();
const { receiveGoogleWebhook } = require("../controllers/googleWebhookController");

// Google Ads POSTs leads here — no GET verification unlike Meta
router.post("/google-webhook", receiveGoogleWebhook);

module.exports = router;