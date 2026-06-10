// routes/msg91Webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// MSG91 inbound WhatsApp webhook.
//
// MSG91 POSTs here for EVERY incoming WhatsApp event tied to your integrated
// number: customer replies (inbound messages) AND delivery/status updates.
// Without this, lead replies never reach the CRM and never appear in
// Communications.
//
// This endpoint MUST be public (no auth) — MSG91's servers call it directly.
//
// Mounted in server.js as:  app.use('/msg91-webhook', msg91WebhookRoute);
//
// DIAGNOSTIC:
//   Every hit is recorded in an in-memory ring buffer. To confirm whether MSG91
//   is actually calling this server (and to see the exact payload it sends),
//   open in a browser:
//     GET /msg91-webhook/_debug/recent?key=<WEBHOOK_DEBUG_KEY>
//   If "count" is 0 right after a lead replies, MSG91 is NOT delivering to this
//   URL → fix the inbound/"Response" webhook URL in the MSG91 dashboard.
//
// Express 5 note: the bare "*" wildcard no longer works as a path string, so we
// use a RegExp (/.*/) which matches every sub-path under the mount point.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();

const { receiveMSG91Webhook } = require("../controllers/msg91WebhookController");
const { recordHit, recentHits } = require("../utils/webhookDebug");
const { probeLogsApi } = require("../utils/msg91Probe");

// ── Discovery probe: server-side test of MSG91 log/report endpoints ───────────
// Gated by WEBHOOK_DEBUG_KEY. Open in a browser:
//   /msg91-webhook/_probe/logs?key=KEY                      (try candidate endpoints)
//   /msg91-webhook/_probe/logs?key=KEY&url=<ENC>&method=GET (confirm a specific one)
router.get("/_probe/logs", async (req, res) => {
  const key = process.env.WEBHOOK_DEBUG_KEY;
  if (!key) return res.status(404).json({ error: "diagnostics disabled (set WEBHOOK_DEBUG_KEY)" });
  if (req.query.key !== key) return res.status(403).json({ error: "bad key" });
  try {
    const out = await probeLogsApi({ overrideUrl: req.query.url, overrideMethod: req.query.method });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnostic viewer (must be registered BEFORE the catch-all GET) ───────────
// Gated by WEBHOOK_DEBUG_KEY so it isn't world-readable. If the env var is unset
// the endpoint is disabled (returns 404-style message).
router.get("/_debug/recent", (req, res) => {
  const key = process.env.WEBHOOK_DEBUG_KEY;
  if (!key) return res.status(404).json({ error: "diagnostics disabled (set WEBHOOK_DEBUG_KEY)" });
  if (req.query.key !== key) return res.status(403).json({ error: "bad key" });
  res.json(recentHits());
});

// Health check / verification — some dashboards ping the URL with a GET first.
router.get(/.*/, (req, res) => res.status(200).send("MSG91 WhatsApp webhook OK"));

// Inbound messages + delivery reports from MSG91 (public — no auth).
// Record the hit first (for diagnostics), then hand off to the controller.
router.post(/.*/, (req, res, next) => { recordHit(req); next(); }, receiveMSG91Webhook);

module.exports = router;