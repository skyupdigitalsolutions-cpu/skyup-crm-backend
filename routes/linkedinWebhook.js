const express = require("express");
const router = express.Router();
const { verifyWebhook, receiveWebhook } = require("../controllers/linkedinWebhookController");

// LinkedIn's webhook registration challenge handshake
router.get("/webhook", verifyWebhook);

// Receive lead notifications from LinkedIn's Lead Sync API
router.post("/webhook", receiveWebhook);

module.exports = router;
