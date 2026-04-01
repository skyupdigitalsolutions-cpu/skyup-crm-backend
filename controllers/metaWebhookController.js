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
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`🔐 Webhook verify attempt — mode: "${mode}", token: "${token}"`);

  if (mode === "subscribe") {
    if (!VERIFY_TOKEN || token === VERIFY_TOKEN) {
      console.log("✅ Meta webhook verified");
      return res.status(200).send(challenge);
    }
    console.warn(`❌ Token mismatch — received: "${token}", expected: "${VERIFY_TOKEN}"`);
  }
  res.sendStatus(403);
};

// POST - Receive lead events from Meta
const receiveWebhook = async (req, res) => {
  // CRITICAL: Always send 200 immediately — Meta marks as failed if > 5 seconds
  res.sendStatus(200);

  try {
    const { object, entry } = req.body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`📨 Webhook received`);
    console.log(`   object : "${object}"`);
    console.log(`   entries: ${entry?.length || 0}`);
    console.log(`   body   : ${JSON.stringify(req.body)}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (!entry || entry.length === 0) {
      console.warn("⚠️  No entries in webhook payload");
      return;
    }

    if (object !== "page") {
      console.warn(`⚠️  object is "${object}" — expected "page". Wrong webhook subscription type.`);
      return;
    }

    for (const e of entry) {
      const pageId = e.id;
      console.log(`\n🔍 Processing entry — pageId: "${pageId}"`);

      // ── Find matching MetaConfig ────────────────────────────────────────────
      const config = await MetaConfig.findOne({ pageId });

      if (!config) {
        const all = await MetaConfig.find({}).select("pageId campaignName isActive").lean();
        console.error(`❌ No MetaConfig found for pageId: "${pageId}"`);
        console.error(`   All registered pageIds: ${JSON.stringify(all)}`);
        console.error(`   👉 Fix: Make sure the pageId "${pageId}" is entered exactly in your CRM campaign settings.`);
        continue;
      }

      if (!config.isActive) {
        console.warn(`⚠️  MetaConfig for pageId "${pageId}" exists but is PAUSED — activate it in CRM.`);
        continue;
      }

      // ── Check pageAccessToken is not a placeholder ──────────────────────────
      if (!config.pageAccessToken || config.pageAccessToken.startsWith("your_") || config.pageAccessToken === "EAAxxxxxx") {
        console.error(`❌ pageAccessToken for campaign "${config.campaignName}" is a placeholder — enter the real Page Access Token in CRM.`);
        continue;
      }

      console.log(`✅ Config found — campaign: "${config.campaignName}", active: ${config.isActive}`);

      for (const change of e.changes) {
        console.log(`   change.field: "${change.field}"`);

        if (change.field !== "leadgen") {
          console.log(`   ⏭ Skipping non-leadgen change: "${change.field}"`);
          continue;
        }

        const { leadgen_id, form_id } = change.value;
        console.log(`   leadgen_id: "${leadgen_id}"`);
        console.log(`   form_id   : "${form_id}"`);

        // ── Form filter ────────────────────────────────────────────────────────
        if (config.formIds && config.formIds.length > 0 && !config.formIds.includes(form_id)) {
          console.warn(`   ⏭ form_id "${form_id}" not in allowed list: [${config.formIds.join(", ")}]`);
          continue;
        }

        // ── Deduplicate ────────────────────────────────────────────────────────
        const duplicate = await Lead.findOne({ leadgenId: leadgen_id });
        if (duplicate) {
          console.log(`   ⏭ Duplicate — leadgenId "${leadgen_id}" already in DB`);
          continue;
        }

        // ── Fetch lead details from Meta Graph API ─────────────────────────────
        const apiVersion = config.graphApiVersion || process.env.META_GRAPH_API_VERSION || "v19.0";
        console.log(`   📡 Fetching lead from Meta Graph API (${apiVersion})...`);

        let leadData;
        try {
          leadData = await fetchLeadData(leadgen_id, config.pageAccessToken, apiVersion);
          console.log(`   📋 field_data: ${JSON.stringify(leadData.field_data)}`);
        } catch (fetchErr) {
          console.error(`   ❌ Failed to fetch lead from Meta Graph API`);
          console.error(`      Error: ${fetchErr?.response?.data?.error?.message || fetchErr.message}`);
          console.error(`      👉 Fix: The pageAccessToken may be expired or invalid. Generate a new Long-Lived Page Access Token.`);
          continue;
        }

        const parsedFields = parseFieldData(leadData.field_data);
        console.log(`   parsed: ${JSON.stringify(parsedFields)}`);

        // ── Round-robin assign ─────────────────────────────────────────────────
        const assignedUserId = await getNextAssignedUser(config);
        console.log(`   assigned user: ${assignedUserId || "unassigned"}`);

        // ── Save lead ──────────────────────────────────────────────────────────
        const leadPayload = mapToLeadSchema(parsedFields, config, leadgen_id, assignedUserId);
        console.log(`   saving lead: ${JSON.stringify(leadPayload)}`);

        const newLead = await Lead.create(leadPayload);
        console.log(`\n✅ LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`);
      }
    }
  } catch (err) {
    console.error("❌ WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { verifyWebhook, receiveWebhook };