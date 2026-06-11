// jobs/msg91InboundPollJob.js
// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK-ONLY MODE — polling is disabled.
//
// All inbound WhatsApp messages are received via MSG91's push webhook:
//   POST https://skyup-crm-backend.onrender.com/msg91-webhook
//
// When MSG91 receives a lead reply, it POSTs the payload directly to this
// server within 1-2 seconds. The server saves it to DB and emits via Socket.io
// so it appears in the CRM instantly — zero polling delay.
//
// HOW THE WEBHOOK IS ACTIVATED:
//   Option A (automatic): Admin opens Communications → Integrations → WhatsApp
//                         → click "⚡ Auto-Register Webhook" button
//   Option B (manual):    MSG91 dashboard → WhatsApp → Integrated Numbers
//                         → click your number → Settings
//                         → Response Webhook URL → paste:
//                            https://skyup-crm-backend.onrender.com/msg91-webhook
//                         → Save
//
// The webhook endpoint is at:  POST /msg91-webhook  (any sub-path works)
// Handler:                     controllers/msg91WebhookController.js
// ─────────────────────────────────────────────────────────────────────────────

function startMsg91InboundPollJob() {
  console.log("✅ MSG91 inbound: webhook-only mode active.");
  console.log("   Lead replies arrive via POST /msg91-webhook in <2 seconds.");
  console.log("   To activate: MSG91 dashboard → WhatsApp → Integrated Numbers");
  console.log("   → your number → Settings → Response Webhook URL →");
  console.log("   → paste: https://skyup-crm-backend.onrender.com/msg91-webhook");
}

async function pollOnce() {
  // No-op — webhook-only mode
}

module.exports = { startMsg91InboundPollJob, pollOnce };