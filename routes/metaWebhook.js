const express = require("express");
const router = express.Router();
const verifyMetaSignature = require("../middlewares/metaSignature");
const { verifyWebhook, receiveWebhook } = require("../controllers/metaWebhookController");

// Meta verification handshake
router.get("/webhook", verifyWebhook);

// Receive lead events from Meta
router.post("/webhook", verifyMetaSignature, receiveWebhook);

module.exports = router;