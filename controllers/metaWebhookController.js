const MetaConfig = require("../models/MetaConfig");
const Lead       = require("../models/Leads");
const {
  fetchLeadData,
  parseFieldData,
  mapToLeadSchema,
  getNextAssignedUser,
} = require("../utils/metaHelper");
const { VERIFY_TOKEN } = require("../config/meta");

// GET - Meta webhook verification handshake
// BUG FIX: Meta sends the same verify_token that was entered when registering
// the webhook in the App Dashboard. The global .env VERIFY_TOKEN is used for
// the subscription, so we check against it. If it is blank we fall back to
// accepting any token so the handshake still completes during development.
const verifyWebhook = (req, res) => {
  const {
    "hub.mode":         mode,
    "hub.verify_token": token,
    "hub.challenge":    challenge,
  } = req.query;

  if (mode === "subscribe") {
    // Accept if it matches the env token OR if no env token is set (dev mode)
    if (!VERIFY_TOKEN || token === VERIFY_TOKEN) {
      console.log("Meta webhook verified ✅");
      return res.status(200).send(challenge);
    }
  }

  console.warn(`Meta webhook verification failed ❌ — received token: "${token}", expected: "${VERIFY_TOKEN}"`);
  res.sendStatus(403);
};

// POST - Receive lead events from Meta
const receiveWebhook = async (req, res) => {
  res.sendStatus(200); // respond immediately — Meta requires < 5 s

  try {
    const { object, entry } = req.body;
    if (object !== "page") return;

    for (const e of entry) {
      const pageId = e.id;

      const config = await MetaConfig.findOne({ pageId, isActive: true });
      if (!config) {
        console.warn(`No active Meta config found for pageId: ${pageId}`);
        continue;
      }

      for (const change of e.changes) {
        if (change.field !== "leadgen") continue;

        const { leadgen_id, form_id } = change.value;

        // Skip forms not in the allowed list (if a list was configured)
        if (config.formIds.length > 0 && !config.formIds.includes(form_id)) {
          console.log(`Form ${form_id} skipped — not in allowed list for: ${config.campaignName}`);
          continue;
        }

        // Deduplicate
        const duplicate = await Lead.findOne({ leadgenId: leadgen_id });
        if (duplicate) {
          console.log(`Duplicate lead skipped — leadgenId: ${leadgen_id}`);
          continue;
        }

        // Fetch full lead data from Meta
        const leadData     = await fetchLeadData(leadgen_id, config.pageAccessToken, config.graphApiVersion);
        const parsedFields = parseFieldData(leadData.field_data);

        // ── Round-robin: pick next user for this company ──────────────────────
        const assignedUserId = await getNextAssignedUser(config);

        // Build and save the lead
        const leadPayload = mapToLeadSchema(parsedFields, config, leadgen_id, assignedUserId);
        const newLead     = await Lead.create(leadPayload);

        console.log(
          `✅ Lead saved — Name: ${newLead.name} | Campaign: ${config.campaignName} | Assigned to: ${assignedUserId || "unassigned"}`
        );
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
};

module.exports = { verifyWebhook, receiveWebhook };