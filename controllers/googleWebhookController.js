// controllers/googleWebhookController.js
const GoogleAdsConfig    = require("../models/GoogleAdsConfig");
const Lead               = require("../models/Leads");
const { notifyTelegram } = require("../utils/telegramNotifier");
const {
  parseGoogleLeadData,
  getNextAssignedUserGoogle,
  mapGoogleLeadToSchema,
} = require("../utils/googleAdsHelper");

/**
 * POST /google-webhook
 *
 * Google Ads Lead Form Extension sends a POST with a JSON body.
 *
 * HOW KEY MATCHING WORKS (in order):
 *  1. body.google_key / body.googleKey / ?google_key / ?key  → match GoogleAdsConfig.googleKey
 *  2. If no key in request → try matching by campaignId or formId from the body
 *  3. If still no match → log full body and return (don't drop silently)
 */
const receiveGoogleWebhook = async (req, res) => {
  // Always respond 200 quickly so Google doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📨 Google Ads webhook received");
    console.log("   headers:", JSON.stringify(req.headers));
    console.log("   query:  ", JSON.stringify(req.query));
    console.log("   body:   ", JSON.stringify(body));
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── Step 1: Try to find config by googleKey ──────────────────────────────
    // Google sends this ONLY if you added ?google_key=xxx to the webhook URL
    // in Google Ads UI → Lead Form → Webhook Settings.
    const googleKey =
      body.google_key   ||
      body.googleKey    ||
      req.query.google_key ||
      req.query.key;

    let config = null;

    if (googleKey) {
      config = await GoogleAdsConfig.findOne({ googleKey, isActive: true });
      if (!config) {
        console.error(`❌ No active GoogleAdsConfig found for googleKey: "${googleKey}"`);
        console.error("   Make sure the key in your Google Ads webhook URL matches exactly what is stored in GoogleAdsConfig.googleKey");
      }
    } else {
      console.warn("⚠️  No google_key found in body or query params.");
      console.warn("   Fix: In Google Ads UI → Lead Form → Webhook URL, append ?google_key=YOUR_KEY");
      console.warn("   Trying fallback: match by campaignId or formId from body...");

      // ── Step 2: Fallback — match by campaignId or formId ──────────────────
      const campaignId = body.campaign_id || body.campaignId || null;
      const formId     = body.form_id     || body.formId     || null;

      if (campaignId) {
        config = await GoogleAdsConfig.findOne({ campaignId, isActive: true });
        if (config) console.log(`✅ Fallback matched by campaignId: "${campaignId}"`);
      }

      if (!config && formId) {
        config = await GoogleAdsConfig.findOne({ formId, isActive: true });
        if (config) console.log(`✅ Fallback matched by formId: "${formId}"`);
      }

      if (!config) {
        // ── Step 3: Last resort — if only ONE active config exists, use it ──
        const allActive = await GoogleAdsConfig.find({ isActive: true });
        if (allActive.length === 1) {
          config = allActive[0];
          console.warn(`⚠️  Only one active config found — using it as fallback: "${config.campaignName}"`);
        } else {
          console.error("❌ Cannot identify campaign. No key, no campaignId/formId match, and multiple active configs exist.");
          console.error("   Full body logged above. Configure google_key in Google Ads webhook URL to fix this.");
          return;
        }
      }
    }

    if (!config) return;

    console.log(`✅ Config matched — campaign: "${config.campaignName}" | company: ${config.company}`);

    // ── Deduplication ────────────────────────────────────────────────────────
    const googleLeadId =
      body.lead_id        ||
      body.leadId         ||
      body.google_lead_id ||
      null;

    if (googleLeadId) {
      const duplicate = await Lead.findOne({ leadgenId: googleLeadId });
      if (duplicate) {
        console.log(`⏭ Duplicate — leadId "${googleLeadId}" already exists in DB`);
        return;
      }
    }

    // ── Parse lead fields ────────────────────────────────────────────────────
    // Google sends: body.user_column_data = [{ column_name, string_value }, ...]
    const userColumnData = body.user_column_data || [];
    const parsedFields   = parseGoogleLeadData(userColumnData);

    console.log("   parsedFields:", JSON.stringify(parsedFields));
    console.log("   Available column names:", userColumnData.map(c => c.column_name));

    // Guard: must have at least a name or phone
    const hasName  = parsedFields["first_name"] || parsedFields["full_name"] || parsedFields["full name"];
    const hasPhone = parsedFields["phone_number"] || parsedFields["phone"] || parsedFields["phone number"];

    if (!hasName && !hasPhone) {
      console.warn("⚠️  No recognisable lead fields (name/phone) found in user_column_data.");
      console.warn("   Check that your Google Lead Form fields match expected column names:");
      console.warn("   Expected: first_name, last_name, full_name, phone_number, phone, email");
      console.warn("   Received column names:", userColumnData.map(c => c.column_name));
      return;
    }

    // ── Save lead ────────────────────────────────────────────────────────────
    const assignedUserId = await getNextAssignedUserGoogle(config);
    const leadPayload    = mapGoogleLeadToSchema(parsedFields, config, googleLeadId, assignedUserId);

    const newLead = await Lead.create(leadPayload);
    console.log(
      `\n✅ GOOGLE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`
    );

    // ── Notify via Telegram ──────────────────────────────────────────────────
    notifyTelegram(newLead, config.campaignName).catch((e) =>
      console.error("Telegram error:", e.message)
    );

  } catch (err) {
    console.error("❌ GOOGLE WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveGoogleWebhook };
