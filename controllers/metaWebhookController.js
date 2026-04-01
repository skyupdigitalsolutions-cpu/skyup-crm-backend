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
const verifyWebhook = (req, res) => {
  const {
    "hub.mode":         mode,
    "hub.verify_token": token,
    "hub.challenge":    challenge,
  } = req.query;

  if (mode === "subscribe") {
    if (!VERIFY_TOKEN || token === VERIFY_TOKEN) {
      console.log("Meta webhook verified ✅");
      return res.status(200).send(challenge);
    }
  }

  console.warn(`Meta webhook verification failed ❌ — received: "${token}", expected: "${VERIFY_TOKEN}"`);
  res.sendStatus(403);
};

// POST - Receive lead events from Meta
const receiveWebhook = async (req, res) => {
  res.sendStatus(200); // respond immediately — Meta requires < 5 s

  try {
    const { object, entry } = req.body;

    // BUG FIX: Full logging so every step is visible in Render logs
    console.log(`📨 Webhook received — object: "${object}", entries: ${entry?.length || 0}`);

    if (object !== "page") {
      console.warn(`⚠️  Unexpected webhook object: "${object}" — expected "page". Check your Meta App webhook subscription.`);
      return;
    }

    for (const e of entry) {
      const pageId = e.id;
      console.log(`  → pageId: ${pageId}, changes: ${e.changes?.length || 0}`);

      const config = await MetaConfig.findOne({ pageId, isActive: true });
      if (!config) {
        // BUG FIX: Print ALL registered pageIds so you can spot the mismatch instantly
        const allConfigs = await MetaConfig.find({}).select("pageId campaignName isActive").lean();
        console.warn(`❌ No active MetaConfig for pageId: "${pageId}"`);
        console.warn(`   Registered: ${JSON.stringify(allConfigs.map(c => ({ pageId: c.pageId, campaign: c.campaignName, active: c.isActive })))}`);
        continue;
      }

      for (const change of e.changes) {
        console.log(`  → change.field: "${change.field}"`);
        if (change.field !== "leadgen") continue;

        const { leadgen_id, form_id } = change.value;
        console.log(`  → leadgen_id: ${leadgen_id}, form_id: ${form_id}`);

        if (config.formIds.length > 0 && !config.formIds.includes(form_id)) {
          console.log(`  → Form ${form_id} skipped — not in allowlist for: ${config.campaignName}`);
          continue;
        }

        const duplicate = await Lead.findOne({ leadgenId: leadgen_id });
        if (duplicate) {
          console.log(`  → Duplicate skipped — leadgenId: ${leadgen_id}`);
          continue;
        }

        console.log(`  → Fetching from Meta Graph API (${config.graphApiVersion || "default"})...`);
        const leadData     = await fetchLeadData(leadgen_id, config.pageAccessToken, config.graphApiVersion);
        const parsedFields = parseFieldData(leadData.field_data);
        console.log(`  → Parsed fields: ${JSON.stringify(parsedFields)}`);

        const assignedUserId = await getNextAssignedUser(config);
        console.log(`  → Assigned to: ${assignedUserId || "unassigned (no users in company)"}`);

        const leadPayload = mapToLeadSchema(parsedFields, config, leadgen_id, assignedUserId);
        const newLead     = await Lead.create(leadPayload);

        console.log(`✅ Lead saved — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | user: ${assignedUserId || "unassigned"}`);
      }
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    console.error(err.stack);
  }
};

module.exports = { verifyWebhook, receiveWebhook };