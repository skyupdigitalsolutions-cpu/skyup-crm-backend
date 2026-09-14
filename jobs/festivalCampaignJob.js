// jobs/festivalCampaignJob.js
//
// Two independent ways a festival template reaches leads, both handled here:
//
// 1. AUTO-BLAST (fully automatic, no manual work) ─ the primary path.
//    Any company with `Company.festivalAutoBlast.enabled = true` gets EVERY
//    template in utils/festivalTemplateCatalog.js sent to its leads
//    automatically on that template's listed date. Nothing to create or
//    schedule per festival — flip the one toggle and it just runs, today and
//    every future catalog date, forever.
//
// 2. MANUAL CAMPAIGNS (optional, for one-off/custom festivals) ─ still
//    supported for an admin who wants to schedule something NOT in the
//    catalog (see models/FestivalCampaign.js). Most companies won't need this
//    once auto-blast is on.
//
// Both share the same batched send loop and the same underlying senders
// (sendAutoWhatsApp / sendAutoEmail from services/autoTemplateService.js) —
// so festival sends get identical provider handling, per-lead-per-template
// dedup, and WhatsAppSendLog/EmailLog attribution as every other automation.
//
// Ticks every 15 minutes so a due festival still fires within 15 minutes even
// if the server restarted right at/after it was due — matching by IST date
// key (not "did today's single firing already happen") makes re-running the
// tick safe: atomic claims below ensure each (company, festival, day) is only
// ever picked up and processed once.

"use strict";

const cron                = require("node-cron");
const Company              = require("../models/Company");
const Lead                 = require("../models/Leads");
const FestivalCampaign     = require("../models/FestivalCampaign");
const FestivalAutoBlastLog = require("../models/FestivalAutoBlastLog");
const WhatsAppSendLog      = require("../models/WhatsAppSendLog");
const { getFestivalCatalog }      = require("../utils/festivalTemplateCatalog");
const { istDayKey, IST_TIMEZONE } = require("../utils/istDate");
const { sendAutoWhatsApp, sendAutoEmail } = require("../services/autoTemplateService");

const CONCURRENCY    = 5;   // leads processed in parallel per chunk — same pool size as sms/email campaign controllers
const LEAD_PAGE_SIZE = 500; // fetched from Mongo this many at a time so a huge company's lead list is never all loaded in memory at once

// Reduce a lead's per-channel send results into one overall outcome for stats.
function summarizeOutcome(results) {
  if (results.some((r) => r.status === "sent"))   return "sent";
  if (results.some((r) => r.status === "failed")) return "failed";
  return "skipped";
}

async function sendToOneLead({ companyId, lead, channels, festivalName, ruleId }) {
  const results = [];
  try {
    if (channels?.whatsapp?.enabled) {
      results.push(await sendAutoWhatsApp({
        companyId,
        lead,
        whatsappSettings: {
          ...channels.whatsapp,
          logChannel:    "festival-campaign",
          logSentByName: `Festival Campaign (${festivalName})`,
          logRuleId:     ruleId,
          logRuleName:   festivalName,
        },
      }));
    }
    if (channels?.email?.enabled) {
      results.push(await sendAutoEmail({ companyId, lead, emailSettings: channels.email }));
    }
  } catch (err) {
    console.error(`[festivalCampaign] ❌ Unexpected error sending to lead ${lead._id}:`, err.message);
    results.push({ channel: "unknown", status: "failed", detail: err.message });
  }
  return summarizeOutcome(results);
}

// ── Shared batched send loop ─────────────────────────────────────────────────
// Sends `channels` to every lead matching `leadQuery`, in chunks of
// CONCURRENCY, calling `onProgress(stats)` after each page of LEAD_PAGE_SIZE
// so the caller can persist partial progress as it goes (safe against a
// mid-run crash). Returns the final stats object.
async function runSendLoop({ companyId, leadQuery, channels, festivalName, ruleId, onProgress }) {
  const totalLeads = await Lead.countDocuments(leadQuery);
  let sent = 0, failed = 0, skipped = 0;

  await onProgress({ totalLeads, sent, failed, skipped });

  for (let skip = 0; skip < totalLeads; skip += LEAD_PAGE_SIZE) {
    const leads = await Lead.find(leadQuery)
      .select("_id name mobile email businessName industry service status")
      .skip(skip)
      .limit(LEAD_PAGE_SIZE)
      .lean();

    for (let i = 0; i < leads.length; i += CONCURRENCY) {
      const chunk = leads.slice(i, i + CONCURRENCY);
      const outcomes = await Promise.all(
        chunk.map((lead) => sendToOneLead({ companyId, lead, channels, festivalName, ruleId }))
      );
      for (const outcome of outcomes) {
        if (outcome === "sent")        sent++;
        else if (outcome === "failed") failed++;
        else                            skipped++;
      }
    }

    await onProgress({ totalLeads, sent, failed, skipped });
  }

  return { totalLeads, sent, failed, skipped };
}

function buildLeadQuery(companyId, targetAudience) {
  const query = { company: companyId };
  if (targetAudience?.scope === "byStatus" && targetAudience.statuses?.length) {
    query.status = { $in: targetAudience.statuses };
  }
  return query;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. AUTO-BLAST — catalog-driven, per-company toggle, zero manual work
// ═══════════════════════════════════════════════════════════════════════════
async function runAutoBlastForCompany(company, catalogEntry, year) {
  const cfg = company.festivalAutoBlast || {};
  const channels = {
    whatsapp: {
      enabled:      cfg.whatsapp?.enabled !== false, // default ON
      templateName: catalogEntry.templateName,
      languageCode: cfg.whatsapp?.languageCode || "en",
    },
    email: cfg.email?.enabled
      ? {
          enabled:      true,
          subject:      (cfg.email.subject      || "Happy {{festival}}, {{name}}!").replace(/{{festival}}/g, catalogEntry.festivalName),
          fromName:     cfg.email.fromName      || "",
          bodyTemplate: (cfg.email.bodyTemplate || "").replace(/{{festival}}/g, catalogEntry.festivalName),
        }
      : { enabled: false },
  };

  // Atomic claim: creating this row IS the claim. A duplicate insert
  // (E11000, from the unique company+festivalKey+year index) means another
  // tick/instance already claimed this exact festival for this company this
  // year — skip cleanly rather than double-send.
  let log;
  try {
    log = await FestivalAutoBlastLog.create({
      company:      company._id,
      festivalKey:  catalogEntry.key,
      festivalName: catalogEntry.festivalName,
      year,
      status:       "sending",
    });
  } catch (err) {
    if (err.code === 11000) return; // already claimed — nothing to do
    console.error(`[festivalCampaign] ❌ Auto-blast claim failed for company ${company._id} / ${catalogEntry.key}:`, err.message);
    return;
  }

  console.log(`[festivalCampaign] ▶️ Auto-blast "${catalogEntry.festivalName}" → company ${company._id}`);

  try {
    const stats = await runSendLoop({
      companyId:    company._id,
      leadQuery:    buildLeadQuery(company._id, cfg.targetAudience),
      channels,
      festivalName: catalogEntry.festivalName,
      ruleId:       log._id,
      onProgress: async ({ totalLeads, sent, failed, skipped }) => {
        log.stats = { totalLeads, sent, failed, skipped };
        await log.save();
      },
    });

    log.status = "sent";
    log.sentAt = new Date();
    await log.save();

    console.log(
      `[festivalCampaign] ✅ Auto-blast "${catalogEntry.festivalName}" → company ${company._id} done — ` +
      `${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped (of ${stats.totalLeads})`
    );
  } catch (err) {
    console.error(`[festivalCampaign] ❌ Auto-blast "${catalogEntry.festivalName}" failed for company ${company._id}:`, err.message);
    log.status = "failed";
    log.lastError = err.message;
    await log.save().catch(() => {});
  }
}

async function runAutoBlastTick(todayKey) {
  const dueEntries = getFestivalCatalog().filter((f) => f.date === todayKey);
  if (!dueEntries.length) return;

  const year = Number(todayKey.split("-")[0]);
  const companies = await Company.find({ "festivalAutoBlast.enabled": true }, { festivalAutoBlast: 1 }).lean();
  if (!companies.length) return;

  console.log(`[festivalCampaign] 🔎 Auto-blast: ${dueEntries.length} catalog festival(s) due today (${todayKey}) for ${companies.length} opted-in company(ies)`);

  for (const entry of dueEntries) {
    for (const company of companies) {
      await runAutoBlastForCompany(company, entry, year);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. MANUAL CAMPAIGNS — optional, custom one-off festivals not in the catalog
// ═══════════════════════════════════════════════════════════════════════════
async function runManualCampaign(campaign) {
  const leadQuery = buildLeadQuery(campaign.company, campaign.targetAudience);

  console.log(`[festivalCampaign] ▶️ Manual campaign "${campaign.festivalName}" → company ${campaign.company}`);

  const stats = await runSendLoop({
    companyId:    campaign.company,
    leadQuery,
    channels:     campaign.channels,
    festivalName: campaign.festivalName,
    ruleId:       campaign._id,
    onProgress: async ({ totalLeads, sent, failed, skipped }) => {
      campaign.stats = { totalLeads, sent, failed, skipped };
      await campaign.save();
    },
  });

  campaign.status = "sent";
  campaign.sentAt = new Date();
  await campaign.save();

  console.log(
    `[festivalCampaign] ✅ Manual campaign "${campaign.festivalName}" → company ${campaign.company} done — ` +
    `${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped (of ${stats.totalLeads})`
  );
}

async function runManualCampaignsTick(todayKey) {
  const dueCampaignIds = await FestivalCampaign.find(
    { sendDateKey: todayKey, status: "scheduled", enabled: true },
    { _id: 1 }
  ).lean();
  if (!dueCampaignIds.length) return;

  console.log(`[festivalCampaign] 🔎 Manual: ${dueCampaignIds.length} campaign(s) due today (${todayKey})`);

  for (const { _id } of dueCampaignIds) {
    // Atomic claim — same reasoning as the auto-blast log claim above.
    const claimed = await FestivalCampaign.findOneAndUpdate(
      { _id, status: "scheduled" },
      { $set: { status: "sending", startedAt: new Date() } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      await runManualCampaign(claimed);
    } catch (err) {
      console.error(`[festivalCampaign] ❌ Manual campaign ${_id} failed:`, err.message);
      await FestivalCampaign.findByIdAndUpdate(_id, { $set: { status: "failed", lastError: err.message } }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// RETRY — re-send to leads a past auto-blast run never successfully reached
// ═══════════════════════════════════════════════════════════════════════════
// FIX (support request): a company's festival campaign had every send fail
// because of the localizable_params bug (now fixed in autoTemplateService.js)
// — but the FestivalAutoBlastLog claim for that (company, festival, year) was
// already created and marked "sent" the moment the send loop finished, even
// though every individual lead inside it failed. That claim is permanent —
// the unique index means this exact festival can never fire again for this
// company this year via the normal cron path. This is the recovery path.
//
// Rather than trusting a stored list of "who failed" (failures weren't even
// being logged to WhatsAppSendLog until the fix alongside this function —
// see autoTemplateService.js), this determines who still needs the message
// the more robust way: re-run the SAME lead-targeting query the original
// blast used, then exclude anyone who already has a logged SUCCESSFUL send
// for this specific campaign (ruleId = the FestivalAutoBlastLog's own _id).
// That correctly catches leads that failed OR were skipped OR were simply
// never logged at all (pre-fix), without needing to trust any specific
// failure record to exist.
async function retryFailedForBlastLog(blastLogId) {
  const log = await FestivalAutoBlastLog.findById(blastLogId);
  if (!log) throw new Error(`FestivalAutoBlastLog ${blastLogId} not found.`);

  const company = await Company.findById(log.company);
  if (!company) throw new Error(`Company ${log.company} not found.`);

  const catalog = getFestivalCatalog();
  const catalogEntry = catalog.find((c) => c.key === log.festivalKey);
  if (!catalogEntry) {
    throw new Error(`Festival catalog entry "${log.festivalKey}" no longer exists — cannot determine the template to resend.`);
  }

  const cfg = company.festivalAutoBlast || {};
  const channels = {
    whatsapp: {
      enabled:      cfg.whatsapp?.enabled !== false,
      templateName: catalogEntry.templateName,
      languageCode: cfg.whatsapp?.languageCode || "en",
    },
    email: cfg.email?.enabled
      ? {
          enabled:      true,
          subject:      (cfg.email.subject      || "Happy {{festival}}, {{name}}!").replace(/{{festival}}/g, catalogEntry.festivalName),
          fromName:     cfg.email.fromName      || "",
          bodyTemplate: (cfg.email.bodyTemplate || "").replace(/{{festival}}/g, catalogEntry.festivalName),
        }
      : { enabled: false },
  };

  // Everyone the campaign SHOULD have reached, using today's targeting config
  // (the closest available approximation of what was used originally, since
  // the exact criteria at send-time isn't stored on the log row itself).
  const allTargetLeads = await Lead.find(buildLeadQuery(log.company, cfg.targetAudience)).select("_id").lean();
  const allTargetIds = allTargetLeads.map((l) => String(l._id));

  // Leads that ALREADY have a successful send logged against this specific
  // campaign — these must NOT be re-sent to (avoids double-messaging anyone
  // the original run actually did reach successfully).
  const alreadySent = await WhatsAppSendLog.find({ ruleId: log._id, status: "sent" }).select("lead").lean();
  const alreadySentIds = new Set(alreadySent.map((s) => String(s.lead)));

  const retryLeadIds = allTargetIds.filter((id) => !alreadySentIds.has(id));
  if (retryLeadIds.length === 0) {
    return { retried: 0, sent: 0, failed: 0, skipped: 0, message: "Nothing to retry — every targeted lead already has a successful send logged." };
  }

  console.log(`[festivalCampaign] 🔁 Retrying "${log.festivalName}" for company ${log.company} — ${retryLeadIds.length} lead(s) without a confirmed successful send.`);

  const stats = await runSendLoop({
    companyId: log.company,
    leadQuery: { _id: { $in: retryLeadIds } },
    channels,
    festivalName: log.festivalName,
    ruleId: log._id, // same ruleId — these sends attach to the SAME campaign log for reporting continuity
  });

  // Merge retry stats into the existing log rather than overwriting it, so
  // the row still reflects the campaign's true total history.
  log.stats = {
    totalLeads: (log.stats?.totalLeads || 0), // unchanged — same target audience
    sent:       (log.stats?.sent    || 0) + stats.sent,
    failed:     stats.failed, // reflects the retry's own outcome, not additive — failed count from a stale run isn't meaningful to keep summing
    skipped:    (log.stats?.skipped || 0) + stats.skipped,
  };
  log.lastError = stats.failed > 0 ? `Retry: ${stats.failed} lead(s) still failed.` : "";
  await log.save();

  return { retried: retryLeadIds.length, ...stats };
}

async function runTick() {
  const todayKey = istDayKey(new Date());
  await runAutoBlastTick(todayKey).catch((err) => console.error("[festivalCampaign] auto-blast tick error:", err.message));
  await runManualCampaignsTick(todayKey).catch((err) => console.error("[festivalCampaign] manual tick error:", err.message));
}

function startFestivalCampaignJob() {
  cron.schedule("*/15 * * * *", () => {
    runTick().catch((err) => console.error("[festivalCampaign] tick error:", err.message));
  }, { timezone: IST_TIMEZONE });

  console.log("✅ Festival campaign job started (checks every 15 min, IST calendar day match — auto-blast + manual campaigns).");
}

module.exports = { startFestivalCampaignJob, runTick, retryFailedForBlastLog };
