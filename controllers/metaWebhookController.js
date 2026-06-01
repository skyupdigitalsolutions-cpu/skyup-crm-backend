// controllers/metaWebhookController.js
const MetaConfig         = require("../models/MetaConfig");
const MetaQualification  = require("../models/MetaQualification");
const Lead               = require("../models/Leads");
const { notifyTelegram } = require("../utils/telegramNotifier");
const { normalizePhone } = require("../utils/normalizePhone");
const { autoSendTemplates } = require("./leadController");
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

        // Step 3: catch-all — any active config for this page with no specific form
        if (!config) {
          config = await MetaConfig.findOne({
            pageId,
            isActive: true,
            $or: [{ formId: "" }, { formId: { $exists: false } }],
          });
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

        // ── Qualification scoring ─────────────────────────────────────────────
        // If this ad set has qualification rules configured, score the lead now
        // so it arrives in the CRM already categorised as Hot / Warm / Cold.
        try {
          const qualification = await MetaQualification.findOne({
            adSetConfig: config._id,
            company:     config.company,
          }).lean();

          if (qualification && qualification.rules && qualification.rules.length > 0) {
            // Calculate max possible score
            const maxScore = qualification.rules.reduce((sum, rule) => {
              const best = Math.max(...rule.answers.map((a) => a.score || 0), 0);
              return sum + best;
            }, 0);

            // Calculate actual score by matching submitted answers to rules
            let totalScore = 0;
            const breakdown = [];

            for (const rule of qualification.rules) {
              // Try to find the submitted answer for this question
              const submittedValue =
                parsedFields[rule.questionKey] ||
                parsedFields[rule.questionKey.toLowerCase().replace(/\s+/g, "_")] ||
                "";

              // Find the matching answer option (case-insensitive)
              const matchedAnswer = rule.answers.find(
                (a) => a.value.trim().toLowerCase() === String(submittedValue).trim().toLowerCase()
              );

              const awarded = matchedAnswer?.score || 0;
              totalScore += awarded;

              breakdown.push({
                question: rule.questionLabel || rule.questionKey,
                answer:   submittedValue || "(no answer)",
                score:    awarded,
              });
            }

            // Derive category from percentage thresholds
            const pct  = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
            const hot  = qualification.thresholds?.hot  ?? 70;
            const warm = qualification.thresholds?.warm ?? 40;

            let category;
            if (pct >= hot)  category = "Hot";
            else if (pct >= warm) category = "Warm";
            else category = "Cold";

            // Override the temperature that qualityHelper already set
            leadPayload.temperature          = category;
            leadPayload.leadScore            = totalScore;
            leadPayload.leadCategory         = category;
            leadPayload.qualificationBreakdown = breakdown;

            console.log(
              `   🎯 Qualification: score=${totalScore}/${maxScore} (${pct.toFixed(0)}%) → ${category}`
            );
          }
        } catch (qualErr) {
          // Never let scoring failure block lead creation
          console.error("   ⚠️  Qualification scoring error (non-fatal):", qualErr.message);
        }

        // ── Phone-based dedup ─────────────────────────────────────────────────
        const normPhone = normalizePhone(leadPayload.mobile);
        if (normPhone) {
          const phoneDup = await Lead.findOne(
            { company: config.company, normalizedPhone: normPhone },
            { _id: 1, name: 1 }
          ).lean();
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
          newLead = await Lead.create(leadPayload);
        } catch (createErr) {
          if (createErr.code === 11000) {
            console.log(`   ⚠ Race-condition duplicate for ${leadPayload.mobile} — skipping`);
            continue;
          }
          throw createErr;
        }

        console.log(`\n✅ META LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | campaign: "${config.campaignName}" | adset: "${config.adSetName}" | id: ${newLead._id}`);

        notifyTelegram(newLead, config.campaignName, parsedFields).catch((e) =>
          console.error("Telegram error:", e.message)
        );

        autoSendTemplates(newLead, newLead.company);
      }
    }
  } catch (err) {
    console.error("❌ WEBHOOK PROCESSING ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { verifyWebhook, receiveWebhook };
