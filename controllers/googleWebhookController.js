// controllers/googleWebhookController.js
const GoogleAdsConfig = require("../models/GoogleAdsConfig");
const Lead            = require("../models/Leads");
const { notifyAdmin } = require("../utils/notifyAdmin");
const {
  parseGoogleLeadData,
  getNextAssignedUserGoogle,
  mapGoogleLeadToSchema,
} = require("../utils/googleAdsHelper");

/**
 * POST /google-webhook
 *
 * Google Ads Lead Form Extension sends a POST with a JSON body.
 * Auth: Google includes a secret key in the payload or as a query param.
 * We match it against GoogleAdsConfig.googleKey to identify the campaign.
 */
const receiveGoogleWebhook = async (req, res) => {
  // Always respond 200 quickly so Google doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📨 Google Ads webhook received");
    console.log("   body:", JSON.stringify(body));
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Google sends the secret key in the body as google_key (or via query param as a fallback)
    const googleKey =
      body.google_key ||
      body.googleKey ||
      req.query.key ||
      req.query.google_key;

    if (!googleKey) {
      console.error("❌ No google_key found in request body or query params");
      return;
    }

    // Find matching campaign config
    const config = await GoogleAdsConfig.findOne({ googleKey, isActive: true });

    if (!config) {
      console.error(`❌ No active GoogleAdsConfig found for key: "${googleKey}"`);
      return;
    }

    console.log(`✅ Config matched — campaign: "${config.campaignName}"`);

    // Extract lead id for deduplication
    const googleLeadId =
      body.lead_id ||
      body.leadId ||
      body.google_lead_id ||
      null;

    if (googleLeadId) {
      const duplicate = await Lead.findOne({ leadgenId: googleLeadId });
      if (duplicate) {
        console.log(`⏭ Duplicate — leadId "${googleLeadId}" already in DB`);
        return;
      }
    }

    // Parse the user_column_data array
    const userColumnData = body.user_column_data || [];
    const parsedFields   = parseGoogleLeadData(userColumnData);

    console.log("   parsedFields:", JSON.stringify(parsedFields));

    if (
      !parsedFields["first_name"] &&
      !parsedFields["full_name"] &&
      !parsedFields["phone_number"] &&
      !parsedFields["phone"]
    ) {
      console.warn("⚠️  Payload appears empty — no recognisable lead fields found");
      return;
    }

    const assignedUserId = await getNextAssignedUserGoogle(config);
    const leadPayload    = mapGoogleLeadToSchema(parsedFields, config, googleLeadId, assignedUserId);

    const newLead = await Lead.create(leadPayload);
    console.log(
      `\n✅ GOOGLE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`
    );

    // Notify admin on WhatsApp
    notifyAdmin(newLead, config.campaignName).catch((e) =>
      console.error("Notify error:", e.message)
    );
  } catch (err) {
    console.error("❌ GOOGLE WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveGoogleWebhook };