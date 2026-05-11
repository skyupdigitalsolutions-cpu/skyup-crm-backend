// routes/msg91Webhook.js
// Public route — MSG91 calls this with no auth header
// Register this URL in MSG91 Dashboard → WhatsApp → Webhook Settings

const express = require("express");
const router  = express.Router();

const { receiveMSG91Webhook } = require("../controllers/msg91WebhookController");

// POST /msg91-webhook/msg91
router.post("/msg91", receiveMSG91Webhook);

module.exports = router;