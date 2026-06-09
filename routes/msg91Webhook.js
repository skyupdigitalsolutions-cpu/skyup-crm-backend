// routes/msg91Webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// MSG91 inbound WhatsApp webhook.
//
// MSG91 POSTs here for EVERY incoming WhatsApp event tied to your integrated
// number: customer replies (inbound messages) AND delivery/status updates
// (sent / delivered / read / failed). Without this, lead replies never reach
// the CRM and never appear in Communications.
//
// This endpoint MUST be public (no auth) — MSG91's servers call it directly and
// cannot present a CRM login token.
//
// Mounted in server.js as:  app.use('/msg91-webhook', msg91WebhookRoute);
//
// IMPORTANT — what broke before:
//   1) This file had been overwritten with the website-config routes, so the
//      webhook was never wired to its handler at all.
//   2) The handler documents two possible URLs — "/msg91-webhook/" AND
//      "/msg91-webhook/msg91". A route that only matched "/" would 404 the
//      sub-path variant. To be safe, we accept POST on ANY path under
//      /msg91-webhook, so it works no matter what exact URL is configured in
//      the MSG91 dashboard.
//
// Express 5 note: the bare "*" wildcard no longer works as a path string, so we
// use a RegExp (/.*/) which matches every sub-path under the mount point.
// (Verified against express@5.2.1.)
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { receiveMSG91Webhook } = require("../controllers/msg91WebhookController");

// Health check / verification — some dashboards ping the URL with a GET first.
router.get(/.*/, (req, res) => res.status(200).send("MSG91 WhatsApp webhook OK"));

// Inbound messages + delivery reports from MSG91 (public — no auth).
// Matches /msg91-webhook, /msg91-webhook/, /msg91-webhook/msg91, etc.
router.post(/.*/, receiveMSG91Webhook);

module.exports = router;