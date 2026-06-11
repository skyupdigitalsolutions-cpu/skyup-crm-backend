// jobs/msg91InboundPollJob.js
// ─────────────────────────────────────────────────────────────────────────────
// POLLING IS DISABLED — inbound messages are now handled exclusively via the
// MSG91 inbound webhook (POST /msg91-webhook).
//
// The MSG91 webhook delivers lead replies in <1-2 seconds with zero polling
// overhead. The old pull-based approach introduced 30–50s delays because
// MSG91's Logs API has inherent buffering lag.
//
// HOW TO CONFIRM THE WEBHOOK IS ACTIVE:
//   1. In MSG91 dashboard → WhatsApp → Integrated Numbers
//   2. Click your number → Settings
//   3. Under "Response Webhook" paste:
//        https://<your-backend-domain>/msg91-webhook
//   4. Save. Lead replies will now arrive in <2s.
//
// AUTO-REGISTRATION:
//   The CRM tries to register this URL automatically via
//   POST /api/admin/company/msg91-register-webhook
//   (called when admin opens the Communications page).
// ─────────────────────────────────────────────────────────────────────────────

function startMsg91InboundPollJob() {
  console.log("✅ MSG91 inbound: webhook-only mode — no polling (replies arrive in <2s via POST /msg91-webhook)");
}

module.exports = { startMsg91InboundPollJob, pollOnce: async () => {} };