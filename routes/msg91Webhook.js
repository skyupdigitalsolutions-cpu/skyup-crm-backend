// routes/msg91Webhook.js
const express = require("express");
const router  = express.Router();
const { receiveMSG91Webhook } = require("../controllers/msg91WebhookController");

// ── DEBUG endpoint — logs the raw payload MSG91 sends ──────────────────────
// HOW TO USE:
//   1. Temporarily point your MSG91 webhook to:
//      https://skyup-crm-backend.onrender.com/msg91-webhook/debug
//   2. Have a lead send a WhatsApp message to your number
//   3. Check your Render logs — you'll see the EXACT payload MSG91 sends
//   4. Once confirmed working, switch the URL back to /msg91-webhook/
// ──────────────────────────────────────────────────────────────────────────
router.post("/debug", (req, res) => {
  console.log("🔍 MSG91 DEBUG PAYLOAD ─────────────────────────────");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:",    JSON.stringify(req.body,    null, 2));
  console.log("────────────────────────────────────────────────────");
  res.status(200).json({ received: true, body: req.body, headers: req.headers });
});

// ── Main inbound webhook ───────────────────────────────────────────────────
// MSG91 dashboard webhook URL: https://your-backend.onrender.com/msg91-webhook/
router.post("/",      receiveMSG91Webhook);
router.post("/msg91", receiveMSG91Webhook);  // backward compat

module.exports = router;