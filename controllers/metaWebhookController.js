// controllers/metaWebhookController.js
const axios              = require("axios");
const MetaConfig         = require("../models/MetaConfig");
const MetaQualification  = require("../models/MetaQualification");
const Lead               = require("../models/Leads");
const { normalizePhone } = require("../utils/normalizePhone");
const { autoSendTemplates } = require("../services/autoTemplateService");
const { scoreQualification } = require("../utils/qualificationScorer");
const {
  fetchLeadData,
  parseFieldData,
  mapToLeadSchema,
  getNextAssignedUser,
} = require("../utils/metaHelper");
const { notifyCampaignLead } = require("../services/telegramService");
const { sendNewLeadNotification } = require("../services/fcmService");

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

      for (const change of e.changes) {
        console.log(`   change.field: "${change.field}"`);

        if (change.field !== "leadgen") {
          console.log(`   ⏭ Skipping non-leadgen change: "${change.field}"`);
          continue;
        }

        // ── form_id is now declared BEFORE any config lookup that uses it ──────
        const { leadgen_id, form_id } = change.value;
        console.log(`   leadgen_id: "${leadgen_id}"`);
        console.log(`   form_id   : "${form_id}"`);

        // ── Config lookup — most-specific match first ─────────────────────────
        // Step 1: exact match by pageId + specific formId (one adset config)
        let config = await MetaConfig.findOne({ pageId, formId: form_id, isActive: true });

        // Step 2: match by pageId + formIds array (legacy multi-form whitelist)
        if (!config) {
          config = await MetaConfig.findOne({ pageId, formIds: form_id, isActive: true });
        }

        // Step 3: no form-pinned config matched. Before blindly attributing the
        // lead to the first config (the old behaviour that piled every ad set's
        // leads onto "skyup_ads"), try to identify the lead's real ad set by
        // asking Meta which ad set / campaign this form_id belongs to, then match
        // a config by that name. Only if that also fails do we fall back.
        if (!config) {
          const noFormConfigs = await MetaConfig.find({
            pageId,
            isActive: true,
            $or: [{ formId: "" }, { formId: { $exists: false } }],
          }).lean();

          // 3a. Try to resolve the form's ad set / campaign from Meta and match
          //     a config by adSetName (preferred) or campaignName. This routes
          //     correctly even when the config's formId was never set.
          let routed = null;
          try {
            const probeToken =
              noFormConfigs[0]?.pageAccessToken ||
              (await MetaConfig.findOne({ pageId, isActive: true }).lean())?.pageAccessToken;
            if (probeToken && form_id) {
              const ver = process.env.META_GRAPH_API_VERSION || "v21.0";
              const formMeta = await axios.get(
                `https://graph.facebook.com/${ver}/${form_id}`,
                { params: { fields: "id,name,adset_name,campaign_name", access_token: probeToken } },
              );
              const fAdset = (formMeta.data?.adset_name || "").trim().toLowerCase();
              const fCamp  = (formMeta.data?.campaign_name || "").trim().toLowerCase();
              const all    = await MetaConfig.find({ pageId, isActive: true });
              routed =
                (fAdset && all.find((c) => (c.adSetName || "").trim().toLowerCase() === fAdset)) ||
                (fCamp  && all.find((c) =>
                  (c.adSetName || "").trim() === "" &&
                  (c.campaignName || "").trim().toLowerCase() === fCamp)) ||
                null;
              if (routed) {
                console.log(`   🎯 Routed by form ad set/campaign to "${routed.campaignName}"`);
                // Backfill the formId so next time Step 1 matches directly.
                if (!routed.formId) {
                  await MetaConfig.findByIdAndUpdate(routed._id, {
                    formId: form_id,
                    formIds: Array.from(new Set([...(routed.formIds || []), form_id])),
                  });
                }
              }
            }
          } catch (probeErr) {
            console.warn(`   ⚠ Could not resolve form ad set from Meta: ${probeErr?.response?.data?.error?.message || probeErr.message}`);
          }

          if (routed) {
            config = routed;
          } else {
            if (noFormConfigs.length > 1) {
              // Truly ambiguous and Meta lookup didn't help. The lead's real
              // form_id is still saved on the lead (leadPayload.formId), so it
              // can be re-tagged later by formId once configs are fixed. Run the
              // Sync Meta button, or scripts/retagMetaLeads.js, to repair these.
              console.warn(
                `⚠️  AD-SET ROUTING AMBIGUOUS — pageId "${pageId}" has ${noFormConfigs.length} active configs with no formId ` +
                `(${noFormConfigs.map((c) => `"${c.campaignName}${c.adSetName ? " › " + c.adSetName : ""}"`).join(", ")}). ` +
                `Incoming form_id "${form_id}" did not match any config, and Meta lookup failed, so this lead is attributed to ` +
                `"${noFormConfigs[0].campaignName}". Fix: click "Sync Meta" to backfill formIds on each ad-set config.`,
              );
            }
            config = noFormConfigs[0]
              ? await MetaConfig.findById(noFormConfigs[0]._id)
              : null;
          }
        }

        if (!config) {
          const all = await MetaConfig.find({}).select("pageId campaignName isActive").lean();
          console.error(`❌ No MetaConfig found for pageId: "${pageId}", formId: "${form_id}"`);
          console.error(`   All registered configs: ${JSON.stringify(all)}`);
          continue;
        }

        if (!config.isActive) {
          console.warn(`⚠️  MetaConfig "${config.campaignName}" is PAUSED — activate it in CRM.`);
          continue;
        }

        if (
          !config.pageAccessToken ||
          config.pageAccessToken.startsWith("your_") ||
          config.pageAccessToken === "EAAxxxxxx"
        ) {
          console.error(`❌ pageAccessToken for campaign "${config.campaignName}" is a placeholder.`);
          continue;
        }

        console.log(`✅ Config found — campaign: "${config.campaignName}", adset: "${config.adSetName}", active: ${config.isActive}`);

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

        const parsedFields   = parseFieldData(leadData.field_data);
        const assignedUserId = await getNextAssignedUser(config);
        const leadPayload    = mapToLeadSchema(parsedFields, config, leadgen_id, assignedUserId);
        // Record the exact Meta form this lead came through. In Meta each lead
        // form belongs to one ad set, so this is the ground-truth key for
        // attributing the lead to its ad set even if it was routed via a
        // catch-all config. Prefer the webhook's form_id; fall back to the
        // config's own formId when the payload omitted it.
        leadPayload.formId = form_id || config.formId || "";

        // ── Qualification scoring ─────────────────────────────────────────────
        // Look up saved rules for this ad set (config._id) and score the lead.
        try {
          const qualDoc = await MetaQualification.findOne({ adSetId: config._id }).lean();
          if (qualDoc && qualDoc.rules && qualDoc.rules.length > 0) {
            const {
              leadScore,
              maxScore,
              qualificationPercentage,
              leadCategory,
              qualificationBreakdown,
            } = scoreQualification(leadData.field_data, qualDoc);
            leadPayload.leadScore               = leadScore;
            leadPayload.maxScore                = maxScore;
            leadPayload.qualificationPercentage = qualificationPercentage;
            leadPayload.leadCategory            = leadCategory;
            leadPayload.qualificationBreakdown  = qualificationBreakdown;
            // Also set temperature so existing UI badges reflect the category
            if (leadCategory) leadPayload.temperature = leadCategory;
            console.log(`   🎯 Qualification — score: ${leadScore}/${maxScore} (${qualificationPercentage}%), category: ${leadCategory}`);
          }
        } catch (qualErr) {
          // Non-fatal — lead is still saved without scoring
          console.warn("   ⚠ Qualification scoring failed:", qualErr.message);
        }

        // ── Phone-based dedup ─────────────────────────────────────────────────
        const normPhone = normalizePhone(leadPayload.mobile);
        if (normPhone) {
          const phoneDup = await Lead.findOne({
            company: config.company,
            $or: [
              { normalizedPhone:          normPhone },
              { normalizedSecondaryPhone: normPhone },
            ],
          }, { _id: 1, name: 1 }).lean();
          if (phoneDup) {
            console.log(`   ⏭ Phone duplicate — ${leadPayload.mobile} → ${normPhone}, exists as "${phoneDup.name}" (${phoneDup._id})`);
            await Lead.findByIdAndUpdate(phoneDup._id, {
              $push: {
                callHistory: {
                  userId:   null,
                  userName: "Meta Webhook",
                  remark:   `Duplicate Meta lead submission from campaign "${config.campaignName}" (leadgenId: ${leadgen_id})`,
                  outcome:  "Duplicate Submission",
                  calledAt: new Date(),
                },
              },
            });
            continue;
          }
        }

        let newLead;
        try {
          newLead = await Lead.create({ ...leadPayload, primaryPhone: leadPayload.mobile });
        } catch (createErr) {
          if (createErr.code === 11000) {
            console.log(`   ⚠ Race-condition duplicate for ${leadPayload.mobile} — skipping`);
            continue;
          }
          throw createErr;
        }

        console.log(`\n✅ META LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | adset: "${config.adSetName}" | id: ${newLead._id}`);
;

        autoSendTemplates(newLead, newLead.company);
        // Campaign-only Telegram notification (filters by source internally)
        notifyCampaignLead(newLead, newLead.company).catch(e =>
          console.error("[Telegram] Meta lead notify error:", e.message)
        );

        // FIX: push a mobile notification to the assigned agent for Meta ad
        // leads too. Previously only manually-created leads (leadController)
        // triggered sendNewLeadNotification, so agents got NO phone alert for
        // leads coming in from Meta ads — their main lead source.
        if (assignedUserId) {
          sendNewLeadNotification(assignedUserId, newLead).catch(e =>
            console.error("[FCM] Meta lead push error:", e.message)
          );

          // FIX: emit the real-time `new_lead_assigned` socket event too.
          // The Meta webhook previously sent ONLY the FCM push and never this
          // event — but the employee's WEB dashboard bell/badge AND the mobile
          // app's in-app "new lead" handler both listen for `new_lead_assigned`
          // on the agent:<userId> room. Without it, Meta leads produced no
          // dashboard/in-app alert (background push only), which is exactly why
          // "Meta ads leads also not getting notification". Mirrors the emit in
          // leadController.adminCreateLead so all lead sources behave the same.
          if (global._io) {
            global._io.to(`agent:${assignedUserId}`).emit("new_lead_assigned", {
              leadId:    String(newLead._id),
              leadName:  newLead.name,
              source:    newLead.source || "Meta Ads",
              eventType: "new",
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { verifyWebhook, receiveWebhook };