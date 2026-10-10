// services/marketing/leadFacts.js
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical lead dataset for every marketing page. Every tab (Overview,
// Paid Media, Creatives, Pipeline, Reports, Data Health) reads from here, so
// two pages can no longer show different answers for the same question.
//
//   • Lead date      = createdAt (IST day boundaries), merged duplicates excluded
//   • Channel        = stored attribution.channel, else inferred (one function)
//   • Status bucket  = company customization category; unknown → "unmapped"
//   • Lifecycle      = explicit lifecycleStage, else DERIVED from evidence:
//                      calls → contact attempted / contacted, Hot/Interested →
//                      qualified, meetings → meeting, proposals → proposal,
//                      won-category status → won. Stages are cumulative
//                      ("reached"), so a Won lead always counts as Qualified.
//   • Attribution    = platform IDs first (attribution.*), then the MetaConfig
//                      / GoogleAdsConfig the lead came through (ID-based), and
//                      only then a flagged name match ("name").
// No ?. / ?? operators (Beautify-safe).
// ─────────────────────────────────────────────────────────────────────────────

const Lead = require("../../models/Leads");
const { inferChannel } = require("../../utils/attribution");
const { LOST_REASONS } = require("./dictionary");

const IST_MIN = 330;
const PAID = { meta: true, google: true, linkedin: true };
const STAGE_ORDER = { new: 0, contact_attempted: 1, contacted: 2, qualified: 3, meeting: 4, proposal: 5, negotiation: 6, won: 7 };
const STAGE_KEYS  = ["new", "contact_attempted", "contacted", "qualified", "meeting", "proposal", "negotiation", "won"];

// ── Dates (IST) ──────────────────────────────────────────────────────────────
function istToday() { return new Date(Date.now() + IST_MIN * 60000).toISOString().slice(0, 10); }
function addDays(day, k) { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000) + 1; }
function validDay(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function parseRange(from, to) {
  const until = validDay(to) ? to : istToday();
  const since = validDay(from) ? from : addDays(until, -29);
  return {
    since: since, until: until, days: daysBetween(since, until),
    fromD: new Date(since + "T00:00:00.000+05:30"),
    toD:   new Date(until + "T23:59:59.999+05:30"),
  };
}

// compare: "previous" (default) | "prev_month" | "prev_7" | "prev_30" | "prev_90" | "custom" | "none"
function compareRange(range, mode, cmpFrom, cmpTo) {
  if (mode === "none") return null;
  if (mode === "custom" && validDay(cmpFrom) && validDay(cmpTo)) return parseRange(cmpFrom, cmpTo);
  if (mode === "prev_month") {
    const s = new Date(range.since + "T00:00:00Z"); s.setUTCMonth(s.getUTCMonth() - 1);
    const u = new Date(range.until + "T00:00:00Z"); u.setUTCMonth(u.getUTCMonth() - 1);
    return parseRange(s.toISOString().slice(0, 10), u.toISOString().slice(0, 10));
  }
  const fixed = { prev_7: 7, prev_30: 30, prev_90: 90 }[mode];
  if (fixed) { const u = addDays(range.since, -1); return parseRange(addDays(u, -(fixed - 1)), u); }
  const u = addDays(range.since, -1);
  return parseRange(addDays(u, -(range.days - 1)), u);
}

function istDayKey(d) { return new Date(new Date(d).getTime() + IST_MIN * 60000).toISOString().slice(0, 10); }
function istHourKey(d) { return new Date(new Date(d).getTime() + IST_MIN * 60000).toISOString().slice(0, 13); }

// ── Aggregation (small payload: derived values computed in Mongo) ────────────
async function loadRawFacts(company, range, extraMatch, leadScope) {
  const { mergeLeadScope } = require("../../utils/adminLeadScope");
  const base = Object.assign({ company: company, mergedInto: null, createdAt: { $gte: range.fromD, $lte: range.toD } }, extraMatch || {});
  const match = mergeLeadScope(base, leadScope || {});
  return Lead.aggregate([
    { $match: match },
    { $project: {
      name: 1, mobile: 1, source: 1, campaign: 1, adSetName: 1, metaConfigId: 1, linkedinConfigId: 1, formId: 1,
      status: 1, temperature: 1, leadCategory: 1, user: 1, createdAt: 1, updatedAt: 1, isClosed: 1, closeReason: 1,
      lostReason: 1, lifecycleStage: 1, qualificationStatus: 1, dealValue: 1, revenueReceived: 1, proposalValue: 1,
      wonAt: 1, firstContactAt: 1, opportunityCreatedAt: 1, attribution: 1, industry: 1, service: 1, remark: 1,
      calls: { $filter: {
        input: { $ifNull: ["$callHistory", []] }, as: "c",
        cond: { $and: [
          { $ne: ["$$c.outcome", "Duplicate Submission"] },
          // Exact-match list (no $regexMatch) so this runs on MongoDB 3.6+.
          { $not: [{ $in: [{ $ifNull: ["$$c.userName", ""] }, ["Meta Webhook", "Google Webhook", "Website Webhook", "LinkedIn Webhook", "Webhook"]] }] },
        ] },
      } },
      meetings: { $ifNull: ["$meetingRemarks", []] },
      sched:    { $ifNull: ["$scheduledCalls", []] },
      docs:     { $ifNull: ["$documents", []] },
    } },
    { $project: {
      name: 1, mobile: 1, source: 1, campaign: 1, adSetName: 1, metaConfigId: 1, linkedinConfigId: 1, formId: 1,
      status: 1, temperature: 1, leadCategory: 1, user: 1, createdAt: 1, updatedAt: 1, isClosed: 1, closeReason: 1,
      lostReason: 1, lifecycleStage: 1, qualificationStatus: 1, dealValue: 1, revenueReceived: 1, proposalValue: 1,
      wonAt: 1, firstContactAt: 1, opportunityCreatedAt: 1, attribution: 1, industry: 1, service: 1,
      callCount:   { $size: "$calls" },
      firstCallAt: { $min: "$calls.calledAt" },
      lastCallAt:  { $max: "$calls.calledAt" },
      outcomes:    "$calls.outcome",
      lastOutcome: { $arrayElemAt: ["$calls.outcome", -1] },
      lastRemark:  { $arrayElemAt: ["$calls.remark", -1] },
      meetingCount:   { $size: "$meetings" },
      firstMeetingAt: { $min: "$meetings.metAt" },
      lastMeetingAt:  { $max: "$meetings.metAt" },
      meetingOutcomes:{ $map: { input: "$meetings", as: "m", in: "$$m.outcome" } },
      proposalSent:   { $or: [
        { $anyElementTrue: [{ $map: { input: "$meetings", as: "m", in: { $eq: ["$$m.proposalSent", true] } } }] },
        { $anyElementTrue: [{ $map: { input: "$docs", as: "d", in: { $eq: ["$$d.type", "proposal"] } } }] },
      ] },
      proposalAt:     { $max: "$meetings.proposalSentAt" },
      nextFollowUpAt: { $min: { $map: { input: { $filter: { input: "$sched", as: "s", cond: { $ne: ["$$s.done", true] } } }, as: "s", in: "$$s.scheduledAt" } } },
      pendingFollowUps: { $size: { $filter: { input: "$sched", as: "s", cond: { $ne: ["$$s.done", true] } } } },
      overdueFollowUps: { $size: { $filter: { input: "$sched", as: "s", cond: { $and: [{ $ne: ["$$s.done", true] }, { $lt: ["$$s.scheduledAt", new Date()] }] } } } },
    } },
  ]).allowDiskUse(true);
}

// ── Outcome / status helpers built from the company customization ────────────
function buildLookups(cust) {
  const R = require("../../utils/customizationResolver");
  const outcomes = (cust && cust.outcomes) || [];
  const notConnected = new Set(), meeting = new Set(), proposal = new Set(), interested = new Set(), lostOut = new Set();
  outcomes.forEach(function (o) {
    const keys = [String(o.key || "").toLowerCase(), String(o.label || "").toLowerCase()];
    keys.forEach(function (k) {
      if (!k) return;
      if (o.countsAsConnected === false) notConnected.add(k);
      if (o.behavior === "clientMeeting" || /meeting|demo|site visit|discovery/.test(k)) meeting.add(k);
      if (/proposal|quotation|quote/.test(k)) proposal.add(k);
      if (o.behavior === "interested") interested.add(k);
      if (o.behavior === "notInterested" || o.behavior === "invalid") lostOut.add(k);
    });
  });
  const statusCat = function (status) {
    const s = R.findStatus(cust, status);
    return s ? s.category : null;
  };
  const statusLabel = function (status) {
    const s = R.findStatus(cust, status);
    return s ? s.label : (status || "(blank)");
  };
  const hotKeys = new Set(((cust && cust.temperatures) || []).filter(function (t) { return /hot/i.test(t.key) || /hot/i.test(t.label); }).map(function (t) { return String(t.key); }));
  if (!hotKeys.size) hotKeys.add("Hot");
  return { notConnected: notConnected, meeting: meeting, proposal: proposal, interested: interested, lostOut: lostOut, statusCat: statusCat, statusLabel: statusLabel, hotKeys: hotKeys };
}

const NOT_CONNECTED_RE = /not answered|no answer|busy|switch|unreachable|not reachable|invalid|wrong number|ringing|no response/i;

function lostReasonBucket(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  for (let i = 0; i < LOST_REASONS.length; i++) if (LOST_REASONS[i].toLowerCase() === t.toLowerCase()) return LOST_REASONS[i];
  const s = t.toLowerCase();
  if (/duplicate/.test(s)) return "Duplicate";
  if (/spam|fake|bot\b|test lead|test/.test(s)) return "Spam";
  if (/wrong number|invalid|wrong entry|incorrect number/.test(s)) return "Invalid contact";
  if (/job|career|hiring|resume|vacanc|employment|internship/.test(s)) return "Looking for job";
  if (/student|research|college|study|assignment/.test(s)) return "Student/research enquiry";
  if (/price|expensive|costly|too high|quote high/.test(s)) return "Price objection";
  if (/budget|afford|low cost|cheap/.test(s)) return "Budget too low";
  if (/competitor|already using|another (vendor|company|agency)|went with/.test(s)) return "Competitor selected";
  if (/timeline|time line|later stage|delay|not urgent/.test(s)) return "Timeline mismatch";
  if (/location|outside|other city|geograph|not servic|area/.test(s)) return "Outside service geography";
  if (/wrong service|different service|other service|not (our|the) service|not related/.test(s)) return "Wrong service";
  if (/not reachable|unreachable|switch|not answer|no answer|busy|unable to contact|no response/.test(s)) return "Unable to contact";
  if (/no requirement|not now|no need|future|not required|not interested/.test(s)) return "No current requirement";
  return "Other";
}

// ── Attribution index built from configs + platform data ─────────────────────
function buildAttributionIndex(metaConfigs, metaData, googleData) {
  const cfgById = {};
  (metaConfigs || []).forEach(function (c) { cfgById[String(c._id)] = c; });
  const adsetCampaign = {}, adsetsByName = {}, campaignsByName = {}, adCampaign = {}, adAdset = {};
  (metaData && metaData.adsets ? metaData.adsets : []).forEach(function (a) {
    adsetCampaign[a.id] = a.campaignId;
    const k = String(a.name || "").trim().toLowerCase();
    if (!adsetsByName[k]) adsetsByName[k] = [];
    adsetsByName[k].push(a);
  });
  (metaData && metaData.ads ? metaData.ads : []).forEach(function (a) { adCampaign[a.id] = a.campaignId; adAdset[a.id] = a.adsetId; });
  []
    .concat(metaData && metaData.campaigns ? metaData.campaigns : [])
    .concat(metaData && metaData.idleCampaigns ? metaData.idleCampaigns : [])
    .forEach(function (c) {
      const k = String(c.name || "").trim().toLowerCase();
      if (!campaignsByName[k]) campaignsByName[k] = [];
      campaignsByName[k].push(c);
    });

  const gCfgByName = {}, gCampByName = {};
  (googleData && googleData.manualConfigs ? googleData.manualConfigs : []).forEach(function (c) {
    gCfgByName[String(c.campaignName || "").trim().toLowerCase()] = c;
  });
  (googleData && googleData.campaigns ? googleData.campaigns : []).forEach(function (c) {
    const k = String(c.name || "").trim().toLowerCase();
    if (!gCampByName[k]) gCampByName[k] = c;
  });
  const gAdGroupCampaign = {};
  (googleData && googleData.adGroups ? googleData.adGroups : []).forEach(function (g) { gAdGroupCampaign[g.id] = g.campaignId; });

  return {
    cfgById: cfgById, adsetCampaign: adsetCampaign, adsetsByName: adsetsByName, campaignsByName: campaignsByName,
    adCampaign: adCampaign, adAdset: adAdset, gCfgByName: gCfgByName, gCampByName: gCampByName,
    gAdGroupCampaign: gAdGroupCampaign, gclidMap: (googleData && googleData.gclidMap) || {},
  };
}

function resolveMeta(l, idx) {
  const a = l.attribution || {};
  const cfg = l.metaConfigId ? idx.cfgById[String(l.metaConfigId)] : null;
  let adId = a.metaAdId || "";
  let adsetId = a.metaAdsetId || "";
  let campaignId = a.metaCampaignId || "";
  let method = adId || adsetId || campaignId ? "id" : "";
  if (adId && !adsetId && idx.adAdset[adId]) adsetId = idx.adAdset[adId];
  if (!adsetId && cfg && cfg.metaAdsetId) { adsetId = String(cfg.metaAdsetId); method = method || "config"; }
  if (!campaignId && adsetId && idx.adsetCampaign[adsetId]) campaignId = idx.adsetCampaign[adsetId];
  if (!campaignId && adId && idx.adCampaign[adId]) campaignId = idx.adCampaign[adId];
  if (!campaignId && cfg && cfg.metaCampaignId) { campaignId = String(cfg.metaCampaignId); method = method || "config"; }

  // Last resort: flagged name match (unique matches only).
  if (!adsetId) {
    const nm = String((cfg && cfg.adSetName) || l.adSetName || "").trim().toLowerCase();
    const cands = nm ? (idx.adsetsByName[nm] || []) : [];
    const campNm = String((cfg && (cfg.parentCampaignName || cfg.campaignName)) || l.campaign || "").trim().toLowerCase();
    let pick = null;
    if (cands.length === 1) pick = cands[0];
    else if (cands.length > 1 && campNm) {
      const camps = idx.campaignsByName[campNm] || [];
      const ids = new Set(camps.map(function (c) { return c.id; }));
      const narrowed = cands.filter(function (c) { return ids.has(c.campaignId); });
      if (narrowed.length === 1) pick = narrowed[0];
    }
    if (pick) { adsetId = pick.id; if (!campaignId) campaignId = pick.campaignId; method = method || "name"; }
  }
  if (!campaignId) {
    const campNm = String((cfg && (cfg.parentCampaignName || cfg.campaignName)) || l.campaign || "").trim().toLowerCase();
    const camps = campNm ? (idx.campaignsByName[campNm] || []) : [];
    if (camps.length === 1) { campaignId = camps[0].id; method = method || "name"; }
  }
  return { campaignId: campaignId, adsetId: adsetId, adId: adId, method: method || "none" };
}

function resolveGoogle(l, idx) {
  const a = l.attribution || {};
  const gm = a.gclid && idx.gclidMap[a.gclid] ? idx.gclidMap[a.gclid] : null;
  let campaignId = a.googleCampaignId || (gm && gm.campaignId) || "";
  let adGroupId  = a.googleAdGroupId || (gm && gm.adGroupId) || "";
  const keyword  = a.keyword || (gm && gm.keyword) || "";
  let method = a.googleCampaignId || a.googleAdGroupId ? "id" : (gm ? "gclid" : "");
  if (!campaignId && adGroupId && idx.gAdGroupCampaign[adGroupId]) campaignId = idx.gAdGroupCampaign[adGroupId];
  if (!campaignId) {
    const nm = String(l.campaign || "").trim().toLowerCase();
    const cfg = idx.gCfgByName[nm];
    if (cfg && cfg.campaignId) { campaignId = String(cfg.campaignId); method = method || "config"; }
    else if (idx.gCampByName[nm] && idx.gCampByName[nm].id) { campaignId = idx.gCampByName[nm].id; method = method || "name"; }
  }
  return { campaignId: campaignId, adGroupId: adGroupId, keyword: keyword, method: method || "none", gclidResolved: !!gm };
}

// ── Classification ───────────────────────────────────────────────────────────
function classify(l, ctx) {
  const lk = ctx.lookups, idx = ctx.attrIdx, settings = ctx.settings || {};
  const a = l.attribution || {};
  let channel = a.channel || "";
  if (!channel) {
    if (l.metaConfigId) channel = "meta";
    else if (l.linkedinConfigId) channel = "linkedin";
    else channel = inferChannel(l.source, a);
  }

  const cat = lk.statusCat(l.status) || "unmapped";
  const outcomes = (l.outcomes || []).map(function (o) { return String(o || "").toLowerCase(); });
  const meetOuts = (l.meetingOutcomes || []).map(function (o) { return String(o || "").toLowerCase(); });

  // Derived lifecycle ("reached" — cumulative)
  let reached = 0;
  if (l.callCount > 0) reached = 1;
  const connected = outcomes.some(function (o) { return o && !lk.notConnected.has(o) && !NOT_CONNECTED_RE.test(o); });
  if (connected || l.meetingCount > 0) reached = Math.max(reached, 2);
  if ((cat === "open" || cat === "interested" || cat === "verification") && reached < 2) reached = 2;
  const isHot = lk.hotKeys.has(String(l.temperature || "")) || String(l.leadCategory || "") === "Hot";
  const qualEvidence = isHot || cat === "interested" || l.qualificationStatus === "qualified" ||
    outcomes.some(function (o) { return lk.interested.has(o) || /interested/.test(o) && !/not interested/.test(o); }) || !!l.opportunityCreatedAt;
  if (qualEvidence) reached = Math.max(reached, 3);
  const meetEvidence = l.meetingCount > 0 || outcomes.some(function (o) { return lk.meeting.has(o); }) || !!l.opportunityCreatedAt;
  if (meetEvidence) reached = Math.max(reached, 4);
  const propEvidence = !!l.proposalSent || (l.proposalValue > 0) || outcomes.some(function (o) { return lk.proposal.has(o); });
  if (propEvidence) reached = Math.max(reached, 5);
  if (meetOuts.some(function (o) { return /negotiat|pending decision/.test(o); })) reached = Math.max(reached, 6);
  const isWon = cat === "won" || !!l.wonAt || l.lifecycleStage === "won";
  if (isWon) reached = 7;
  if (l.lifecycleStage && l.lifecycleStage !== "lost" && STAGE_ORDER[l.lifecycleStage] != null) reached = Math.max(reached, STAGE_ORDER[l.lifecycleStage]);
  if (l.qualificationStatus === "unqualified" && !isWon && reached >= 3) reached = 2;

  const isLost = !isWon && (cat === "lost" || l.isClosed === true || l.lifecycleStage === "lost");
  const stageSkip = isWon && !qualEvidence && !meetEvidence && !propEvidence;

  // Lost reason
  let lostReason = "";
  if (isLost) {
    lostReason = lostReasonBucket(l.lostReason) || lostReasonBucket(l.closeReason);
    if (!lostReason) {
      const lo = String(l.lastOutcome || "");
      lostReason = lostReasonBucket(l.lastRemark) && lostReasonBucket(l.lastRemark) !== "Other" ? lostReasonBucket(l.lastRemark) : (lo && NOT_CONNECTED_RE.test(lo) ? "Unable to contact" : "");
    }
  }

  // Response time (minutes)
  const fc = l.firstContactAt || l.firstCallAt || null;
  const responseMin = fc ? Math.max(0, Math.round((new Date(fc) - new Date(l.createdAt)) / 60000)) : null;

  // Revenue
  let revenue = 0, revenueType = "none";
  if (isWon) {
    if (Number(l.dealValue) > 0) { revenue = Number(l.dealValue); revenueType = "actual"; }
    else if (Number(l.revenueReceived) > 0) { revenue = Number(l.revenueReceived); revenueType = "actual"; }
    else {
      let est = 0;
      if (channel === "google" && idx.gCfgByName[String(l.campaign || "").trim().toLowerCase()]) est = Number(idx.gCfgByName[String(l.campaign || "").trim().toLowerCase()].avgDealValue) || 0;
      if (!est) est = Number(settings.defaultDealValue) || 0;
      if (est > 0) { revenue = est; revenueType = "estimated"; }
    }
  }

  // Attribution
  let meta = null, google = null, campaignKey = "", campaignLabel = l.campaign || "", method = "none";
  if (channel === "meta") {
    meta = resolveMeta(l, idx); method = meta.method;
    campaignKey = meta.campaignId ? "meta:" + meta.campaignId : "meta-name:" + String(l.campaign || "(none)");
  } else if (channel === "google") {
    google = resolveGoogle(l, idx); method = google.method;
    campaignKey = google.campaignId ? "google:" + google.campaignId : "google-name:" + String(l.campaign || "(none)");
  } else {
    campaignKey = channel + "-name:" + String(l.campaign || l.source || "(none)");
    method = "n/a";
  }

  const lastActivityAt = [l.lastCallAt, l.lastMeetingAt, l.proposalAt].filter(Boolean).map(function (d) { return new Date(d).getTime(); });
  return {
    _id: String(l._id), name: l.name || "", mobile: l.mobile || "", source: l.source || "", campaign: l.campaign || "", adSetName: l.adSetName || "",
    createdAt: l.createdAt, status: l.status || "", statusLabel: lk.statusLabel(l.status), statusCategory: cat,
    temperature: l.temperature || l.leadCategory || "", user: l.user ? String(l.user) : null,
    channel: channel, paid: !!PAID[channel],
    reached: reached, stage: isLost ? "lost" : STAGE_KEYS[reached], isQualified: reached >= 3, isOpp: reached >= 4, isProposal: reached >= 5, isWon: isWon, isLost: isLost,
    contacted: reached >= 2, attempted: reached >= 1, stageSkip: stageSkip,
    lostReason: lostReason, lostReasonMissing: isLost && !lostReason, explicitLostReason: !!(l.lostReason || l.closeReason),
    responseMin: responseMin, callCount: l.callCount || 0, lastOutcome: l.lastOutcome || "",
    nextFollowUpAt: l.nextFollowUpAt || null, overdueFollowUps: l.overdueFollowUps || 0, pendingFollowUps: l.pendingFollowUps || 0,
    lastActivityAt: lastActivityAt.length ? new Date(Math.max.apply(null, lastActivityAt)) : null,
    revenue: revenue, revenueType: revenueType, dealValue: l.dealValue == null ? null : l.dealValue,
    meta: meta, google: google, campaignKey: campaignKey, campaignLabel: campaignLabel, attributionMethod: method,
    attribution: a, metaConfigId: l.metaConfigId ? String(l.metaConfigId) : null,
  };
}

module.exports = {
  PAID, STAGE_KEYS, STAGE_ORDER,
  parseRange, compareRange, istDayKey, istHourKey, istToday, addDays,
  loadRawFacts, buildLookups, buildAttributionIndex, classify, lostReasonBucket,
};
