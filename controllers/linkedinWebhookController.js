const crypto = require("crypto");
const LinkedInConfig = require("../models/LinkedInConfig");
const Lead            = require("../models/Leads");
const { fetchLeadData, parseFieldData, mapToLeadSchema, getNextAssignedUser } = require("../utils/linkedinHelper");

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT — verify against LinkedIn's current docs before going live:
//
// This implements LinkedIn's documented Lead Sync API webhook validation
// pattern (challenge-response via HMAC-SHA256 of a challenge code, using the
// webhook secret issued at registration time). LinkedIn's exact wire format
// (query param names, response shape, header vs body) has changed across API
// versions in the past and I cannot test this against real LinkedIn
// credentials from here — this is built from documented behavior, not a
// live-verified integration. Confirm the exact current shape at
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/organizations/lead-sync-api
// before relying on this in production, and adjust the two spots marked
// VERIFY below if LinkedIn's docs show something different.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET — LinkedIn's webhook registration challenge handshake ────────────────
// VERIFY: query param name and response shape against LinkedIn's current docs.
const verifyWebhook = async (req, res) => {
  try {
    const challengeCode = req.query.challengeCode || req.body?.challengeCode;
    const organizationUrn = req.query.organizationUrn || req.body?.organizationUrn;

    if (!challengeCode) {
      return res.status(400).json({ message: "Missing challengeCode" });
    }

    // Resolve the webhook secret for this organization to compute the
    // expected HMAC response — mirrors metaSignature.js's DB-lookup-first
    // pattern rather than relying on a single global secret.
    const config = organizationUrn
      ? await LinkedInConfig.findOne({ organizationUrn }).select("webhookSecret").lean()
      : await LinkedInConfig.findOne({}).select("webhookSecret").lean(); // fallback if org not passed

    if (!config?.webhookSecret) {
      console.warn("[LinkedIn] No webhookSecret found to answer challenge — cannot verify webhook");
      return res.status(400).json({ message: "No LinkedIn campaign configured for this organization" });
    }

    // VERIFY: confirm LinkedIn expects hex (not base64) encoding of the HMAC.
    const challengeResponse = crypto
      .createHmac("sha256", config.webhookSecret)
      .update(challengeCode)
      .digest("hex");

    console.log("✅ LinkedIn webhook challenge answered");
    return res.status(200).json({ challengeCode, challengeResponse });
  } catch (err) {
    console.error("[LinkedIn] verifyWebhook error:", err.message);
    res.sendStatus(500);
  }
};

// ── Idempotency tracker for webhooks that arrive more than once ──────────────
// LinkedIn explicitly documents that the same leadFormResponse notification
// can be delivered multiple times (e.g. a lead re-registering reuses the same
// URN) — same class of "webhook retries" problem Meta's webhook has, solved
// here the identical way: check Lead.leadgenId (shared, company-scoped
// unique-indexed field) before creating, never trust "we haven't seen this
// before" from memory alone.
async function alreadyProcessed(leadFormResponseUrn, companyId) {
  const existing = await Lead.findOne({ leadgenId: leadFormResponseUrn, company: companyId }).select("_id").lean();
  return !!existing;
}

// ── POST — receive a lead notification from LinkedIn ──────────────────────────
// VERIFY: exact notification payload shape against LinkedIn's current docs —
// this assumes a leadFormResponse URN + organization + leadType arrive in the
// body, per their documented Lead Sync API notification schema.
const receiveWebhook = async (req, res) => {
  try {
    const {
      leadFormResponseUrn,
      organizationUrn,
      leadType,
    } = req.body || {};

    if (!leadFormResponseUrn || !organizationUrn) {
      console.warn("[LinkedIn] Webhook payload missing leadFormResponseUrn/organizationUrn — ignoring");
      return res.sendStatus(200); // ack anyway — LinkedIn will retry a real 5xx, not a malformed payload
    }

    // Find the matching config for this organization + leadType (+ form URN
    // if configs are scoped to specific forms) — same "most specific match
    // wins, empty list = catch-all" convention as MetaConfig.formIds.
    const candidates = await LinkedInConfig.find({
      organizationUrn,
      isActive: true,
      ...(leadType ? { leadType } : {}),
    });

    const config =
      candidates.find((c) => c.formUrns?.length && req.body.leadGenFormUrn && c.formUrns.includes(req.body.leadGenFormUrn)) ||
      candidates.find((c) => !c.formUrns?.length) || // catch-all config
      candidates[0];

    if (!config) {
      console.warn(`[LinkedIn] No active config found for organization ${organizationUrn} — ignoring lead`);
      return res.sendStatus(200);
    }

    // Idempotency — ack immediately if we've already processed this exact URN.
    if (await alreadyProcessed(leadFormResponseUrn, config.company)) {
      console.log(`[LinkedIn] Duplicate notification for ${leadFormResponseUrn} — already processed, skipping`);
      return res.sendStatus(200);
    }

    // Fetch the actual answers — the notification itself only carries the URN.
    const leadData = await fetchLeadData(leadFormResponseUrn, config.accessToken);
    const parsedFields = parseFieldData(leadData);

    const assignedUserId = await getNextAssignedUser(config);
    const leadPayload = mapToLeadSchema(parsedFields, config, leadFormResponseUrn, assignedUserId);

    const lead = await Lead.create(leadPayload);

    console.log(`[LinkedIn] ✅ Lead created: ${lead.name} (${lead.mobile || lead.email}) from "${config.campaignName}"`);

    // Real-time push to the CRM UI — same event name/room convention as the
    // Meta webhook path, so the frontend's existing socket listeners pick
    // this up with zero changes.
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(`company_${String(config.company)}`).emit("lead:new", { lead });
      }
    } catch (e) {
      console.warn("[LinkedIn] Socket emit failed (non-fatal):", e.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[LinkedIn] receiveWebhook error:", err?.response?.data || err.message);
    // Ack with 200 even on our own processing error for a well-formed
    // notification we couldn't complete — returning 5xx here would make
    // LinkedIn retry the SAME notification indefinitely for what might be a
    // permanent error (e.g. an expired token), spamming retries rather than
    // surfacing the real problem. The error is already logged above for
    // investigation.
    res.sendStatus(200);
  }
};

module.exports = { verifyWebhook, receiveWebhook };
