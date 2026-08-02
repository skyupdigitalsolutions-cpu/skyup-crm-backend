// services/metaConversionService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// SEND-BACK to Meta (Conversions API) — the missing half of your Meta
// integration. Everything else in this codebase (metaInsightsService.js,
// metaSyncService.js) only PULLS data from Meta. This tells Meta which leads
// actually turned into something, so ad delivery optimizes toward real
// customers instead of raw form fills.
//
// Mapping (matches "The Status Mapping Matrix"):
//   CRM status        → Meta CAPI event
//   New                 Lead
//   In Progress         Contact
//   Interested          Schedule
//   Converted           Purchase
//   Not Interested      (never sent)
//
// GATING — THIS MUST STAY SILENT FOR EVERY COMPANY EXCEPT THE ONE ENABLED:
//   1. Company.devOverrides.featureToggles.metaConversionSync must be true
//      (checked by the caller — see controllers/leadController.js — via
//      entitlementService.getCompanyEntitlements before this is ever called)
//   2. The lead's MetaConfig must have both pixelId AND capiAccessToken set
//      (blank = this specific campaign hasn't been wired up yet, skip quietly)
//
// MATCHING — no fbc/fbp captured yet (see chat), so this uses SHA-256 hashed
// email + phone ("advanced matching") per Meta's CAPI spec. Decent match
// quality; will improve automatically later if fbc/fbp capture is added to
// the lead-intake forms without any change needed here.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require("axios");
const crypto = require("crypto");
const MetaConfig = require("../models/MetaConfig");

const DEFAULT_GRAPH_VERSION = "v21.0";

// CRM status → Meta Standard Event. Not configurable per-company (yet) —
// deliberately hardcoded to the agreed matrix so every company that turns
// this on gets the same, correct mapping. Ping me if a company needs a
// different mapping and I'll move this into MetaConfig instead.
const STATUS_TO_META_EVENT = {
  "New":            "Lead",
  "In Progress":    "Contact",
  "Interested":     "Schedule",
  "Converted":      "Purchase",
  // "Not Interested" intentionally omitted — never sent, matches the matrix.
};

function sha256Lower(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

// Meta wants phone numbers in E.164-ish digits only (no +, spaces, dashes)
// before hashing, and defaults to assuming Indian numbers here since that's
// this agency's client base — adjust the default country code if a client
// operates outside India.
function normalizePhoneForHash(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`; // bare 10-digit Indian mobile
  return digits;
}

/**
 * Send one Meta CAPI event for a lead's new CRM status.
 * Fire-and-forget from the caller's perspective — never throws, always
 * resolves with a { sent, reason } shape so the caller can log it.
 *
 * @param {object} lead   - full lead doc/lean object (needs metaConfigId, mobile, email, name)
 * @param {string} status - the NEW status just set on this lead
 */
async function sendMetaConversionEvent(lead, status) {
  const eventName = STATUS_TO_META_EVENT[status];
  if (!eventName) {
    return { sent: false, reason: `Status "${status}" is not mapped to a Meta event (by design)` };
  }

  if (!lead?.metaConfigId) {
    return { sent: false, reason: "Lead has no metaConfigId — not a Meta-sourced lead" };
  }

  const config = await MetaConfig.findById(lead.metaConfigId).select("pixelId capiAccessToken graphApiVersion company").lean();
  if (!config) {
    return { sent: false, reason: "MetaConfig not found for this lead" };
  }
  if (!config.pixelId || !config.capiAccessToken) {
    return { sent: false, reason: "This campaign has no pixelId/capiAccessToken configured yet" };
  }

  const hashedEmail = sha256Lower(lead.email);
  const hashedPhone = sha256Lower(normalizePhoneForHash(lead.mobile));

  if (!hashedEmail && !hashedPhone) {
    return { sent: false, reason: "Lead has neither email nor phone — nothing to match on" };
  }

  const userData = {};
  if (hashedEmail) userData.em = [hashedEmail];
  if (hashedPhone) userData.ph = [hashedPhone];

  const ver = config.graphApiVersion || DEFAULT_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${ver}/${config.pixelId}/events`;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated", // this event originates from CRM status changes, not a browser/app event
        user_data: userData,
        custom_data: {
          lead_id: String(lead._id || lead.id || ""),
          status,
        },
      },
    ],
    access_token: config.capiAccessToken,
  };

  try {
    const res = await axios.post(url, payload, { timeout: 10000 });
    const eventsReceived = res.data?.events_received ?? 0;
    if (eventsReceived < 1) {
      return { sent: false, reason: `Meta accepted the request but events_received=${eventsReceived}`, raw: res.data };
    }
    return { sent: true, eventName, eventsReceived };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[metaConversionService] Failed to send "${eventName}" for lead ${lead._id}:`, detail);
    return { sent: false, reason: detail };
  }
}

module.exports = { sendMetaConversionEvent, STATUS_TO_META_EVENT };
