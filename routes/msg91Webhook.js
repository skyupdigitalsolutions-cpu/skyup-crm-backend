// routes/msg91Webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// MSG91 inbound WhatsApp webhook.
//
// MSG91 POSTs here for EVERY incoming WhatsApp event tied to your integrated
// number: customer replies (inbound messages) AND delivery/status updates
// (sent / delivered / read / failed).
//
// This endpoint must be PUBLIC (no auth) because MSG91's servers call it
// directly and cannot present a CRM login token.
//
// Mounted in server.js as:  app.use('/msg91-webhook', msg91WebhookRoute);
// So the URL you configure in the MSG91 dashboard (WhatsApp → Webhook) is:
//     https://<your-backend-domain>/msg91-webhook
//
// NOTE: the previous version of this file had been overwritten with the
// website-config routes by mistake, so inbound messages were being routed to
// admin-protected handlers and silently rejected — which is why lead replies
// never appeared in Communications. This wires the webhook to its real handler.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { receiveMSG91Webhook } = require("../controllers/msg91WebhookController");

// Health check / verification — some dashboards ping the URL with a GET first.
router.get("/", (req, res) => res.status(200).send("MSG91 WhatsApp webhook OK"));

// Inbound messages + delivery reports from MSG91 (public — no auth).
router.post("/", receiveMSG91Webhook);

module.exports = router;