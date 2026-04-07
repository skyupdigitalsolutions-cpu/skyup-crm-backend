const GoogleAdsConfig = require("../models/GoogleAdsConfig");
const Lead            = require("../models/Leads");
const {
  parseGoogleLeadData,
  getNextAssignedUserGoogle,
  mapGoogleLeadToSchema,
} = require("../utils/googleAdsHelper");

// POST — Google Ads sends leads here (no GET handshake unlike Meta)
const receiveGoogleWebhook = async (req, res) => {
  // Respond 200 immediately — same pattern as Meta
  res.sendStatus(200);

  try {
    const payload = req.body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📨 Google Ads webhook received");
    console.log(`   body: ${JSON.stringify(payload)}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const {
      google_key,
      lead_id,
      campaign_id,
      form_id,
      user_column_data,
    } = payload;

    if (!google_key) {
      console.warn("⚠️  No google_key in payload");
      return;
    }

    // Find matching config by the secret key you set in Google Ads
    const config = await GoogleAdsConfig.findOne({ googleKey: google_key });

    if (!config) {
      console.error(`❌ No GoogleAdsConfig found for google_key: "${google_key}"`);
      return;
    }

    if (!config.isActive) {
      console.warn(`⚠️  GoogleAdsConfig "${config.campaignName}" is PAUSED`);
      return;
    }

    // Optional: filter by campaign or form ID
    if (config.campaignId && campaign_id && config.campaignId !== campaign_id) {
      console.warn(`⏭ campaign_id "${campaign_id}" doesn't match config — skipping`);
      return;
    }

    if (config.formId && form_id && config.formId !== form_id) {
      console.warn(`⏭ form_id "${form_id}" doesn't match config — skipping`);
      return;
    }

    // Deduplicate using lead_id
    const duplicate = await Lead.findOne({ leadgenId: lead_id });
    if (duplicate) {
      console.log(`⏭ Duplicate — lead_id "${lead_id}" already saved`);
      return;
    }

    const parsed         = parseGoogleLeadData(user_column_data || []);
    const assignedUserId = await getNextAssignedUserGoogle(config);
    const leadPayload    = mapGoogleLeadToSchema(parsed, config, lead_id, assignedUserId);

    const newLead = await Lead.create(leadPayload);
    console.log(`✅ GOOGLE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`);

  } catch (err) {
    console.error("❌ GOOGLE WEBHOOK ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveGoogleWebhook };