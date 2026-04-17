// controllers/metaWebhookController.js
const MetaConfig         = require("../models/MetaConfig");
const Lead               = require("../models/Leads");
const { notifyTelegram } = require("../utils/telegramNotifier");
const {
  fetchLeadData,
  parseFieldData,
  mapToLeadSchema,
  getNextAssignedUser,
} = require("../utils/metaHelper");

// GET - Meta webhook verification handshake
const verifyWebhook = async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`🔐 Webhook verify attempt — mode: "${mode}", token: "${token}"`);

  if (mode !== "subscribe") {
    console.warn(`❌ Unexpected mode: "${mode}"`);
    return res.sendStatus(403);
  }

  // ── Step 1: Check global env token ─────────────────────────────────────────
  const envToken = process.env.META_VERIFY_TOKEN;
  if (envToken && envToken.trim() !== "" && token === envToken.trim()) {
    console.log("✅ Meta webhook verified via ENV token");
    return res.status(200).send(challenge);
  }

  // ── Step 2: Check per-campaign DB token ────────────────────────────────────
  try {
    const match = await MetaConfig.findOne({
      verifyToken: token,
      isActive: true,
    });

    if (match) {
      console.log(`✅ Meta webhook verified via DB token — campaign: "${match.campaignName}"`);
      return res.status(200).send(challenge);
    }
  } catch (err) {
    console.error("❌ DB lookup failed during webhook verify:", err.message);
  }

  // ── Step 3: No match found ──────────────────────────────────────────────────
  console.warn(`❌ Token mismatch — received: "${token}"`);
  console.warn(`   ENV META_VERIFY_TOKEN: "${envToken || "not set"}"`);
  console.warn(`   Also checked all active campaign verifyTokens in DB — none matched.`);
  console.warn(`   👉 Fix: Make sure the Verify Token in Meta's App dashboard matches`);
  console.warn(`      either META_VERIFY_TOKEN in your .env OR the verifyToken saved`);
  console.warn(`      for the campaign in your CRM.`);
  return res.sendStatus(403);
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

      const config = await MetaConfig.findOne({ pageId });

      if (!config) {
        const all = await MetaConfig.find({}).select("pageId campaignName isActive").lean();
        console.error(`❌ No MetaConfig found for pageId: "${pageId}"`);
        console.error(`   All registered pageIds: ${JSON.stringify(all)}`);
        continue;
      }

      if (!config.isActive) {
        console.warn(`⚠️  MetaConfig for pageId "${pageId}" exists but is PAUSED — activate it in CRM.`);
        continue;
      }

      if (!config.pageAccessToken || config.pageAccessToken.startsWith("your_") || config.pageAccessToken === "EAAxxxxxx") {
        console.error(`❌ pageAccessToken for campaign "${config.campaignName}" is a placeholder.`);
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

        if (config.formIds && config.formIds.length > 0 && !config.formIds.includes(form_id)) {
          console.warn(`   ⏭ form_id "${form_id}" not in allowed list`);
          continue;
        }

        const duplicate = await Lead.findOne({ leadgenId: leadgen_id });
        if (duplicate) {
          console.log(`   ⏭ Duplicate — leadgenId "${leadgen_id}" already in DB`);
          continue;
        }

        const apiVersion = config.graphApiVersion || process.env.META_GRAPH_API_VERSION || "v19.0";
        console.log(`   📡 Fetching lead from Meta Graph API (${apiVersion})...`);

        let leadData;
        try {
          leadData = await fetchLeadData(leadgen_id, config.pageAccessToken, apiVersion);
          console.log(`   📋 field_data: ${JSON.stringify(leadData.field_data)}`);
        } catch (fetchErr) {
          console.error(`   ❌ Failed to fetch lead from Meta Graph API`);
          console.error(`      Error: ${fetchErr?.response?.data?.error?.message || fetchErr.message}`);
          continue;
        }

        const parsedFields  = parseFieldData(leadData.field_data);
        const assignedUserId = await getNextAssignedUser(config);
        const leadPayload   = mapToLeadSchema(parsedFields, config, leadgen_id, assignedUserId);

        const newLead = await Lead.create(leadPayload);
        console.log(`\n✅ META LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`);

        // ── Notify via Telegram ───────────────────────────────────────────────
        notifyTelegram(newLead, config.campaignName).catch(e => console.error("Telegram error:", e.message));

      }
    }
  } catch (err) {
    console.error("❌ WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { verifyWebhook, receiveWebhook };
