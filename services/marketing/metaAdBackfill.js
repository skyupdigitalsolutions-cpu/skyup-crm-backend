// services/marketing/metaAdBackfill.js — NEW FILE
// Fills in "which ad set / ad did this lead come from" for Meta lead-form leads that were saved
// without it. Every Meta lead form lead stores its Meta lead id (`leadgenId`); asking Meta about that
// id returns the ad, ad set and campaign. Tries the page token and the ads token (a page token often
// lacks ads_read), and reports why a lookup failed instead of hiding it.
//
// Limits: Meta only keeps lead data for 90 days, so older leads can't be looked up; a run handles at most
// `limit` leads (default 60) so one click can't hammer Meta; only one run per company at a time.
// Updating attribution is bookkeeping — it never counts as lead activity (no extra AI analysis).
"use strict";

const mongoose = require("mongoose");
const Lead = require("../../models/Leads");
const MetaConfig = require("../../models/MetaConfig");
const { fetchMetaLeadAttributionVerbose } = require("../../utils/attribution");

const DAY = 86400000;
const META_KEEPS_LEADS_DAYS = 90;
const DEFAULT_LIMIT = 60;
const CONCURRENCY = 4;
const running = new Set();

const missingAd = { $or: [{ "attribution.metaAdId": null }, { "attribution.metaAdId": "" }, { "attribution.metaAdId": { $exists: false } }] };
const isMetaLead = { $or: [{ metaConfigId: { $ne: null } }, { "attribution.channel": "meta" }, { source: /meta|facebook|instagram/i }] };

function eligibleFilter(company, ids, now) {
  const f = { company: company, mergedInto: null, leadgenId: { $type: "string", $ne: "" }, $and: [missingAd, isMetaLead] };
  if (ids && ids.length) f._id = { $in: ids };
  else f.createdAt = { $gte: new Date(now - META_KEEPS_LEADS_DAYS * DAY) };     // bulk run: only leads Meta can still answer for
  return f;
}

async function backfillMetaAds({ company, ids, limit }) {
  const key = String(company);
  if (running.has(key)) { const e = new Error("A lookup is already running — try again in a minute."); e.status = 429; throw e; }
  running.add(key);
  try {
    const now = Date.now();
    const objIds = Array.isArray(ids) ? ids.filter((x) => mongoose.Types.ObjectId.isValid(String(x))).map((x) => new mongoose.Types.ObjectId(String(x))) : [];
    const filter = eligibleFilter(company, objIds, now);
    const leads = await Lead.find(filter).select("_id leadgenId metaConfigId createdAt adSetName").sort({ createdAt: -1 }).limit(Math.min(limit || DEFAULT_LIMIT, 200)).lean();

    const configs = await MetaConfig.find({ company: company }).lean();
    const byId = {}; configs.forEach((c) => { byId[String(c._id)] = c; });
    const tokensFor = (lead) => {
      const mine = lead.metaConfigId ? byId[String(lead.metaConfigId)] : null;
      const list = [];
      const add = (t) => { if (t && list.indexOf(t) < 0) list.push(t); };
      if (mine) { add(mine.pageAccessToken); add(mine.adsToken); }
      configs.forEach((c) => { add(c.pageAccessToken); add(c.adsToken); });
      return list.slice(0, 4);                                  // bounded: each extra token can add a slow attempt
    };

    const out = { checked: 0, updated: 0, noData: 0, tooOld: 0, failed: 0, error: null, remaining: 0 };
    let cursor = 0;
    const work = async () => {
      while (cursor < leads.length) {
        const lead = leads[cursor++];
        out.checked++;
        if (+new Date(lead.createdAt) < now - META_KEEPS_LEADS_DAYS * DAY) { out.tooOld++; continue; }
        const mine = lead.metaConfigId ? byId[String(lead.metaConfigId)] : null;
        const r = await fetchMetaLeadAttributionVerbose(lead.leadgenId, tokensFor(lead), (mine && mine.graphApiVersion) || process.env.META_GRAPH_API_VERSION || "v21.0", {});
        if (!r.out.metaAdId) {
          if (r.error) { out.failed++; if (!out.error) out.error = r.error; } else out.noData++;
          continue;
        }
        const set = {};
        ["metaAdId", "metaAdsetId", "metaCampaignId", "metaAdName"].forEach((k) => { if (r.out[k]) set["attribution." + k] = r.out[k]; });
        const res = await Lead.updateOne(Object.assign({ _id: lead._id }, missingAd), { $set: set }, { timestamps: false });
        if (res && (res.modifiedCount === 1 || res.nModified === 1)) {
          out.updated++;
          if (r.extra.adSetName && !lead.adSetName) await Lead.updateOne({ _id: lead._id, adSetName: { $in: [null, ""] } }, { $set: { adSetName: r.extra.adSetName } }, { timestamps: false });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, work));

    out.remaining = await Lead.countDocuments(eligibleFilter(company, [], Date.now()));
    return out;
  } finally {
    running.delete(key);
  }
}

module.exports = { backfillMetaAds, eligibleFilter, META_KEEPS_LEADS_DAYS };
