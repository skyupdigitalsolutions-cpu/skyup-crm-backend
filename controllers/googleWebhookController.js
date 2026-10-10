// controllers/googleWebhookController.js
const GoogleAdsConfig    = require("../models/GoogleAdsConfig");
const Lead               = require("../models/Leads");
const { normalizePhone } = require("../utils/normalizePhone");
const { autoSendTemplates } = require("../services/autoTemplateService");
const {
  parseGoogleLeadData,
  getNextAssignedUserGoogle,
  mapGoogleLeadToSchema,
} = require("../utils/googleAdsHelper");
const { notifyCampaignLead, notifyAllAdminsCampaignLead } = require("../services/telegramService");
const { sendNewLeadNotification } = require("../services/fcmService");

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
async function processGoogleLead(req) {
  // Always respond 200 quickly so Google doesn't retry
  // (HTTP response is sent by receiveGoogleWebhook below)

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
      body.google_key          ||
      body.googleKey           ||
      req.query.google_key     ||
      req.query.key            ||
      req.headers["x-webhook-key"];   // pricing-site / custom integrations send key here

    let config = null;

    if (googleKey) {
      // googleKey is stored AES-256-GCM encrypted (random IV) in MongoDB, so
      // findOne({ googleKey }) never matches — the same plaintext encrypts to a
      // different ciphertext on every save.  The encryptedFieldsPlugin decrypts
      // fields automatically on every find(), so fetching all active configs and
      // comparing the decrypted value in JS is the correct approach.
      const allActive = await GoogleAdsConfig.find({ isActive: true });
      config = allActive.find((c) => c.googleKey === googleKey) || null;
      if (!config) {
        console.error(`❌ No active GoogleAdsConfig found for googleKey: "${googleKey}"`);
        console.error("   Make sure the key matches exactly what was entered when connecting the campaign.");
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
          return { ok: false, status: 400, message: "Campaign key missing or not recognised." };
        }
      }
    }

    if (!config) return { ok: false, status: 404, message: "Campaign not found or inactive. Check the webhook key." };

    console.log(`✅ Config matched — campaign: "${config.campaignName}" | company: ${config.company}`);

    // ── Deduplication ────────────────────────────────────────────────────────
    // googleLeadId sources (in priority order):
    //   1. body.lead_id / body.leadId / body.google_lead_id  — real Google Ads lead IDs
    //   2. body._id — MongoDB _id from the ads backend (Railway), used as surrogate key
    //      to prevent duplicate forwarding when Railway restarts mid-request.
    const googleLeadId =
      body.lead_id        ||
      body.leadId         ||
      body.google_lead_id ||
      (typeof body._id === 'string' && body._id.length >= 12 ? body._id : null) ||
      null;

    if (googleLeadId) {
      // IMPORTANT: dedup is company-scoped — same leadgenId is valid across companies.
      // The old code used findOne({ leadgenId }) without company filter which would
      // incorrectly block a lead from company B if company A already had that leadgenId.
      const duplicate = await Lead.findOne({
        company:   config.company,
        leadgenId: googleLeadId,
      });
      if (duplicate) {
        console.log(
          `⏭ Duplicate — leadId "${googleLeadId}" already exists for company ${config.company}`,
          `| matched lead: ${duplicate._id} | phone: ${duplicate.mobile}`
        );
        return { ok: true, duplicate: true, message: "Thank you! We already have your details — our team will contact you shortly." };
      }
    }

    // ── Parse lead fields ────────────────────────────────────────────────────
    // Google Ads sends: body.user_column_data = [{ column_name, string_value }, ...]
    // Custom integrations (e.g. pricing site) send flat: { name, phone, email, message }
    const userColumnData = body.user_column_data || [];
    const parsedFields   = parseGoogleLeadData(userColumnData);

    // Flat-body fallback — inject pricing-site / custom fields into parsedFields
    // so the rest of the pipeline (mapGoogleLeadToSchema) works unchanged.
    if (!parsedFields["full_name"] && !parsedFields["first_name"]) {
      const flatName = body.name || body.full_name || body.fullName || "";
      if (flatName) parsedFields["full_name"] = flatName;
    }
    if (!parsedFields["phone_number"] && !parsedFields["phone"]) {
      const flatPhone = body.phone || body.mobile || body.phone_number || "";
      if (flatPhone) parsedFields["phone_number"] = flatPhone;
    }
    if (!parsedFields["email"]) {
      const flatEmail = body.email || "";
      if (flatEmail) parsedFields["email"] = flatEmail;
    }

    console.log("   parsedFields:", JSON.stringify(parsedFields));
    console.log("   Available column names:", userColumnData.map(c => c.column_name));

    const hasName  = parsedFields["full_name"] || parsedFields["first_name"] || parsedFields["full name"];
    const hasPhone = parsedFields["phone_number"] || parsedFields["phone"];

    if (!hasName && !hasPhone) {
      console.warn("⚠️  No recognisable lead fields (name/phone) found.");
      console.warn("   For Google Ads: check column names match full_name / phone_number / email.");
      console.warn("   For custom sources: send { name, phone, email } in the request body.");
      console.warn("   Received body keys:", Object.keys(body).join(", "));
      return { ok: false, status: 400, message: "Please enter your name and phone number." };
    }

    // ── Save lead ────────────────────────────────────────────────────────────
    const assignedUserId = await getNextAssignedUserGoogle(config);
    const leadPayload    = mapGoogleLeadToSchema(parsedFields, config, googleLeadId, assignedUserId);

    // Lead.remark is REQUIRED — an empty defaultRemark on the campaign made
    // Lead.create fail silently. Always fall back to a sensible remark.
    if (!String(leadPayload.remark || "").trim()) leadPayload.remark = "Lead from Google Ads";
    if (!String(leadPayload.status || "").trim()) leadPayload.status = "New";
    // Round robin found nobody → keep the lead with the campaign's admin so it
    // appears in their "Unassigned" list for bulk assign.
    if (!leadPayload.user && config.createdBy) leadPayload.assignedAdmin = config.createdBy;

    // ── Marketing attribution (ID-based: gclid / campaign_id / adgroup_id) ──
    try {
      const { buildAttribution } = require("../utils/attribution");
      const attr = buildAttribution("Google Ads", body, config.campaignId ? { googleCampaignId: String(config.campaignId) } : {});
      if (!attr.channel || attr.channel === "organic") attr.channel = "google";
      leadPayload.attribution = attr;
    } catch (attrErr) { /* attribution is best-effort */ }

    // Website / custom forms send flat extra fields (company, solution,
    // requirement, budget, timeline …). Keep them on the lead's remark so the
    // sales team sees the full enquiry instead of losing it.
    if (!userColumnData.length) {
      const SKIP = new Set([
        "name", "full_name", "fullName", "phone", "mobile", "phone_number", "email",
        "google_key", "googleKey", "key", "_id", "lead_id", "leadId", "google_lead_id",
        "campaign_id", "campaignId", "form_id", "formId",
      ]);
      const extras = Object.entries(body || {})
        .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined && String(v).trim() !== "" && typeof v !== "object")
        .map(([k, v]) => `${k}: ${String(v).trim().slice(0, 500)}`);
      if (extras.length) leadPayload.remark = `${leadPayload.remark}\n${extras.join("\n")}`.slice(0, 4000);
    }

    // Optional: auto-detect preferred language from the lead form columns.
    try {
      const detectLang = require("../utils/detectLanguage");
      const lang = detectLang.fromGoogleColumns(userColumnData) || detectLang.fromParsedFields(parsedFields);
      if (lang) leadPayload.language = lang;
    } catch (e) { /* language is optional — ignore detection errors */ }

    // ── Phone-based dedup ────────────────────────────────────────────────────
    // Strategy: attempt Lead.create directly.
    // The pre-validate hook sets normalizedPhone from mobile automatically.
    // The unique compound index { company, normalizedPhone } (partialFilterExpression:
    // { $type: string }) rejects any duplicate atomically — no findOne race window.
    //
    // E11000 error codes and their meaning:
    //   company_normalizedPhone_unique     → same primary phone already exists
    //   company_normalizedSecondaryPhone_unique → same secondary phone already exists
    //   company_leadgenId_unique           → same Google leadgenId already exists
    //
    // All three are safe to skip — they mean we already have this lead.
    const normPhoneForLog = normalizePhone(leadPayload.mobile);
    console.log(
      `   [dedup-check] company: ${config.company}`,
      `| leadgenId: ${googleLeadId || 'none'}`,
      `| normalizedPhone: ${normPhoneForLog || 'null (invalid/short number)'}`
    );

    let newLead;
    try {
      newLead = await Lead.create(leadPayload);
    } catch (createErr) {
      if (createErr.code === 11000) {
        // Identify which index caused the duplicate for clear logging
        const keyPattern = createErr.keyPattern || {};
        let dupReason = 'unknown field';
        if (keyPattern.normalizedPhone)          dupReason = `primary phone (${normPhoneForLog})`;
        else if (keyPattern.normalizedSecondaryPhone) dupReason = 'secondary phone';
        else if (keyPattern.leadgenId)           dupReason = `leadgenId (${googleLeadId})`;

        // Find the matched lead for logging
        const matchedLead = await Lead.findOne(
          createErr.keyValue?.normalizedPhone
            ? { company: config.company, normalizedPhone: createErr.keyValue.normalizedPhone }
            : createErr.keyValue?.leadgenId
            ? { company: config.company, leadgenId: createErr.keyValue.leadgenId }
            : { company: config.company, mobile: leadPayload.mobile }
        ).select('_id name mobile').lean();

        console.log(
          `   ⏭ Duplicate — reason: ${dupReason}`,
          `| company: ${config.company}`,
          `| matched lead: ${matchedLead?._id || 'not found'}`,
          `| matched name: ${matchedLead?.name || 'unknown'}`
        );
        return { ok: true, duplicate: true, message: "Thank you! We already have your details — our team will contact you shortly." };
      }
      throw createErr;
    }

    // ── FIX: Increment lead counter on the config (same as Meta webhook) ─────
    // Without this the campaign card always shows "—" for Leads.
    await GoogleAdsConfig.findByIdAndUpdate(config._id, { $inc: { leads: 1 } });

    console.log(
      `\n✅ GOOGLE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | id: ${newLead._id}`
    );
;

    // ── Auto-send WhatsApp / Email / SMS template if enabled ─────────────────
    autoSendTemplates(newLead, newLead.company);
    // Campaign-only Telegram notification
    notifyCampaignLead(newLead, newLead.company).catch(e =>
      console.error("[Telegram] Google Ads lead notify error:", e.message)
    );
    // FIX (telegram notifications): wire up the previously-dead
    // notifyAllAdminsCampaignLead so admins who configured a personal
    // chat ID actually get notified for Google Ads leads too.
    notifyAllAdminsCampaignLead(newLead, newLead.company).catch(e =>
      console.error("[Telegram] Google Ads lead admin-notify error:", e.message)
    );

    // FIX: notify the ASSIGNED employee specifically. Google Ads leads
    // previously fired no `new_lead_assigned` socket event and no FCM push, so
    // the employee's web bell/badge and the mobile in-app handler stayed silent.
    // Both listen on the agent:<userId> room; the mobile push is sendNewLeadNotification.
    // Mirrors leadController.adminCreateLead so every source behaves the same.
    if (assignedUserId) {
      if (global._io) {
        global._io.to(`agent:${assignedUserId}`).emit("new_lead_assigned", {
          leadId:    String(newLead._id),
          leadName:  newLead.name,
          source:    newLead.source || "Google Ads",
          eventType: "new",
        });
      }
      sendNewLeadNotification(assignedUserId, newLead).catch(e =>
        console.error("[FCM] Google Ads lead push error:", e.message)
      );
    }

    return { ok: true, leadId: String(newLead._id), message: "Thank you! Our team will contact you shortly." };
  } catch (err) {
    console.error("❌ GOOGLE WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
    return { ok: false, status: 500, message: "Could not save your details. Please try again." };
  }
}

/**
 * Two kinds of callers:
 *  • Google Ads servers (no Origin header) → reply 200 immediately so Google
 *    never retries, then process in the background (original behaviour).
 *  • Browser forms on our / customer websites (Origin header present) → wait
 *    for the result and reply JSON { success, message } so the form can show
 *    a real success / error message instead of "Something went wrong".
 */
const receiveGoogleWebhook = async (req, res) => {
  const fromBrowser = !!req.headers.origin;
  if (!fromBrowser) {
    res.sendStatus(200);
    processGoogleLead(req).catch((e) => console.error("❌ GOOGLE WEBHOOK:", e.message));
    return;
  }
  const r = await processGoogleLead(req);
  return res.status(r.ok ? 200 : (r.status || 400)).json({
    success: !!r.ok,
    message: r.message,
    ...(r.leadId ? { leadId: r.leadId } : {}),
    ...(r.duplicate ? { duplicate: true } : {}),
  });
};

module.exports = { receiveGoogleWebhook };
