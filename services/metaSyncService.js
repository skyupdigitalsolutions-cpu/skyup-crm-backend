// services/metaSyncService.js
// ─────────────────────────────────────────────────────────────────────────────
// Reusable Meta lead-form sync.
//
// Fetches every lead form on a Meta page and their ad set / campaign names,
// then upserts one MetaConfig per (pageId, formId). Extracted from
// metaSyncController so BOTH the manual "Sync" button AND the scheduled
// auto-sync job (jobs/metaAutoSyncJob.js) run the exact same logic.
//
// Pure function: takes page credentials, returns { created, skipped, forms }.
// No req/res — the controller and the job wrap it.
// ─────────────────────────────────────────────────────────────────────────────

const axios      = require("axios");
const MetaConfig = require("../models/MetaConfig");

// ── Auto-category from Meta campaign objective ────────────────────────────────
// Maps Meta's OBJECTIVE enum → a readable category label stored on MetaConfig.
// Only sets category when blank — never overwrites a manually set one.
function objectiveToCategory(objective) {
  if (!objective) return "";
  const map = {
    LEAD_GENERATION:       "Lead Generation",
    LEADS:                 "Lead Generation",
    OUTCOME_LEADS:         "Lead Generation",
    CONVERSIONS:           "Conversions",
    OUTCOME_SALES:         "Conversions",
    TRAFFIC:               "Traffic",
    OUTCOME_TRAFFIC:       "Traffic",
    BRAND_AWARENESS:       "Brand Awareness",
    REACH:                 "Brand Awareness",
    OUTCOME_AWARENESS:     "Brand Awareness",
    VIDEO_VIEWS:           "Video Views",
    POST_ENGAGEMENT:       "Engagement",
    PAGE_LIKES:            "Engagement",
    OUTCOME_ENGAGEMENT:    "Engagement",
    APP_INSTALLS:          "App Installs",
    OUTCOME_APP_PROMOTION: "App Installs",
    MESSAGES:              "Messages",
    STORE_VISITS:          "Store Visits",
    PRODUCT_CATALOG_SALES: "Catalogue Sales",
    EVENT_RESPONSES:       "Events",
  };
  return map[String(objective).toUpperCase()] || "";
}

// ── Keyword-based category fallback from campaign name ───────────────────────
// When Meta doesn't return an objective (e.g. no adsToken), infer category
// from keywords in the campaign name. Returns "" if nothing matches.
function inferCategoryFromName(campaignName) {
  if (!campaignName) return "";
  const name = campaignName.toLowerCase();
  const keywords = [
    { cat: "Real Estate",      words: ["real estate","property","realty","flat","villa","apartment","plot","housing","builder"] },
    { cat: "Education",        words: ["education","school","college","course","coaching","admission","training","tuition","academy","university","skill"] },
    { cat: "Healthcare",       words: ["health","hospital","clinic","doctor","medical","pharma","wellness","dental","ayur","therapy"] },
    { cat: "Finance",          words: ["finance","loan","insurance","invest","bank","credit","emi","mutual fund","sip","nri","gold","fd"] },
    { cat: "Automotive",       words: ["car","bike","vehicle","auto","motor","ev","electric vehicle","suv","sedan"] },
    { cat: "E-commerce",       words: ["sale","offer","discount","shop","buy","deal","brand","product","ecom","fashion","clothing"] },
    { cat: "Lead Generation",  words: ["lead gen","lead generation","leadgen","inquiry","enquiry"] },
    { cat: "Brand Awareness",  words: ["brand","awareness","reach","impression","visibility"] },
    { cat: "Travel",           words: ["travel","tour","holiday","vacation","flight","hotel","resort","trip"] },
    { cat: "Technology",       words: ["software","saas","app","tech","crm","erp","digital","it ","website","startup"] },
    { cat: "Events",           words: ["event","webinar","seminar","conference","workshop","launch","expo"] },
  ];
  for (var i = 0; i < keywords.length; i++) {
    var k = keywords[i];
    for (var j = 0; j < k.words.length; j++) {
      if (name.indexOf(k.words[j]) !== -1) return k.cat;
    }
  }
  return "";
}

const DEFAULT_VER = "v22.0";

// Ad set / campaign effective_status values that mean "not delivering / paused".
// We only auto-pause on these explicit states — transient ones like
// PENDING_REVIEW / IN_PROCESS are left active to avoid false pauses.
const PAUSED_STATUSES = new Set([
  "PAUSED",
  "ADSET_PAUSED",
  "CAMPAIGN_PAUSED",
  "CAMPAIGN_GROUP_PAUSED",
  "ARCHIVED",
  "DELETED",
]);
const isPausedStatus = (s) => PAUSED_STATUSES.has(String(s || "").trim().toUpperCase());

// Normalize an ad account id to the "act_..." node form Meta expects.
const toAcctNode = (acct) => {
  const a = String(acct || "").trim();
  if (!a) return "";
  return a.startsWith("act_") ? a : `act_${a}`;
};

// Fetch every ad set + campaign (id, name, effective_status) for one ad account,
// following pagination. Returns lookup maps by id and by lowercased name.
async function fetchAccountStatuses(acct, token, ver = DEFAULT_VER) {
  const acctNode = toAcctNode(acct);
  const out = {
    adsetById:    new Map(),
    adsetByName:  new Map(),
    campaignById: new Map(),
    campaignByName: new Map(),
  };

  const pageAll = async (edge) => {
    const rows = [];
    let url = `https://graph.facebook.com/${ver}/${acctNode}/${edge}`;
    let params = { fields: "id,name,effective_status", limit: 500, access_token: token };
    while (url) {
      const { data } = await axios.get(url, { params, timeout: 20000 });
      rows.push(...((data && data.data) || []));
      url = data?.paging?.next || null;
      params = {};
    }
    return rows;
  };

  const [adsets, campaigns] = await Promise.all([pageAll("adsets"), pageAll("campaigns")]);

  for (const a of adsets) {
    const rec = { id: a.id, name: a.name || "", status: a.effective_status || "" };
    if (a.id)   out.adsetById.set(String(a.id), rec);
    if (a.name) out.adsetByName.set(a.name.trim().toLowerCase(), rec);
  }
  for (const c of campaigns) {
    const rec = { id: c.id, name: c.name || "", status: c.effective_status || "" };
    if (c.id)   out.campaignById.set(String(c.id), rec);
    if (c.name) out.campaignByName.set(c.name.trim().toLowerCase(), rec);
  }
  return out;
}

/**
 * Reconcile CRM active/paused state against Meta's live ad set / campaign
 * delivery status for ONE company.
 *
 * Requires at least one MetaConfig with adAccountId + adsToken (an ads_read
 * token) — the page access token cannot read ad-object status. Configs are
 * matched to Meta ad sets / campaigns by stored id first, then by name
 * (adSetName / parentCampaignName, which the sync populated from Meta so they
 * align). When a config's ad set OR campaign is paused/archived on Meta, the
 * config is auto-paused (pausedByMeta=true); when Meta turns it back on, a
 * Meta-driven pause is auto-reactivated. Admin manual pauses (pausedByMeta=false)
 * are never touched.
 *
 * @returns {Promise<{checked:Number, paused:Number, reactivated:Number, accounts:Number, credentialed:Boolean, reason?:String}>}
 */
async function reconcileMetaStatusesForCompany(companyId) {
  const configs = await MetaConfig.find({ company: companyId }).exec();
  if (configs.length === 0) return { checked: 0, paused: 0, reactivated: 0, accounts: 0, credentialed: false, reason: "no configs" };

  // Distinct ad-account credentials available in this company's configs.
  const acctCreds = new Map(); // acctNode -> { acct, token, ver }
  for (const c of configs) {
    if (c.adAccountId && c.adsToken) {
      const node = toAcctNode(c.adAccountId);
      if (!acctCreds.has(node)) {
        acctCreds.set(node, { acct: c.adAccountId, token: c.adsToken, ver: c.graphApiVersion || DEFAULT_VER });
      }
    }
  }

  if (acctCreds.size === 0) {
    // No ads_read token anywhere → cannot detect Meta pause status. This is the
    // usual reason auto-pause "doesn't work": add an Ad Account ID + ads_read
    // token to a Meta campaign (same fields the Meta Performance report uses).
    return {
      checked: 0, paused: 0, reactivated: 0, accounts: 0, credentialed: false,
      reason: "No ad account + ads_read token configured on any Meta campaign — cannot read ad set / campaign status from Meta.",
    };
  }

  // Fetch statuses for every available account and merge the lookup maps.
  const merged = { adsetById: new Map(), adsetByName: new Map(), campaignById: new Map(), campaignByName: new Map() };
  let accountsOk = 0;
  for (const { acct, token, ver } of acctCreds.values()) {
    try {
      const maps = await fetchAccountStatuses(acct, token, ver);
      accountsOk++;
      for (const [k, v] of maps.adsetById)      merged.adsetById.set(k, v);
      for (const [k, v] of maps.adsetByName)    merged.adsetByName.set(k, v);
      for (const [k, v] of maps.campaignById)   merged.campaignById.set(k, v);
      for (const [k, v] of maps.campaignByName) merged.campaignByName.set(k, v);
    } catch (err) {
      const metaError = err?.response?.data?.error?.message || err.message;
      console.warn(`[MetaStatusSync] ⚠️  account ${acct} (company ${companyId}) failed: ${metaError}`);
    }
  }

  if (accountsOk === 0) {
    return { checked: 0, paused: 0, reactivated: 0, accounts: 0, credentialed: true, reason: "All ad-account status lookups failed (token/permission?)." };
  }

  let checked = 0, paused = 0, reactivated = 0;

  for (const cfg of configs) {
    // Resolve the config's ad set + campaign records from Meta (id first, then name).
    const adsetRec =
      (cfg.metaAdsetId && merged.adsetById.get(String(cfg.metaAdsetId))) ||
      (cfg.adSetName && merged.adsetByName.get(cfg.adSetName.trim().toLowerCase())) ||
      null;
    const campaignRec =
      (cfg.metaCampaignId && merged.campaignById.get(String(cfg.metaCampaignId))) ||
      (cfg.parentCampaignName && merged.campaignByName.get(cfg.parentCampaignName.trim().toLowerCase())) ||
      null;

    // If we couldn't resolve EITHER via the Ads API, fall back to the status
    // data already stored by syncPageForms (metaFormStatus / metaAdsetStatus).
    // This covers manually-created configs and configs whose adSetName doesn't
    // exactly match Meta's ad-set name in the Ads API — without this they would
    // permanently retain metaActive=true (the schema default) and always show
    // "Active" in the CRM even when the campaign is paused on Meta.
    if (!adsetRec && !campaignRec) {
      const storedFormStr  = String(cfg.metaFormStatus  || "").trim().toUpperCase();
      const storedAdsetStr = String(cfg.metaAdsetStatus || "").trim().toUpperCase();

      // Only act when syncPageForms has written real status data (non-empty).
      // If both are still empty the config has never been synced — leave it alone.
      if (storedFormStr === "" && storedAdsetStr === "") continue;

      const formPausedStored  = storedFormStr  !== "" && storedFormStr  !== "ACTIVE";
      const adsetPausedStored = storedAdsetStr !== "" && isPausedStatus(storedAdsetStr);
      const metaActiveStored  = !formPausedStored && !adsetPausedStored;

      const fallbackUpdate = { metaActive: metaActiveStored, metaStatusSyncedAt: new Date() };

      if (!metaActiveStored && cfg.isActive) {
        fallbackUpdate.isActive     = false;
        fallbackUpdate.pausedByMeta = true;
        paused++;
        console.log("[MetaStatusSync] Paused (stored status) \"" + cfg.campaignName + "\" form=" + storedFormStr + " adset=" + storedAdsetStr);
      } else if (metaActiveStored && cfg.pausedByMeta && !cfg.isActive) {
        fallbackUpdate.isActive     = true;
        fallbackUpdate.pausedByMeta = false;
        reactivated++;
        console.log("[MetaStatusSync] Reactivated (stored status) \"" + cfg.campaignName + "\"");
      }

      checked++;
      await MetaConfig.findByIdAndUpdate(cfg._id, fallbackUpdate);
      continue;
    }

    checked++;

    const adsetPaused    = adsetRec    ? isPausedStatus(adsetRec.status)    : false;
    const campaignPaused = campaignRec ? isPausedStatus(campaignRec.status) : false;
    // Also honour the FORM status captured by syncPageForms (page token can read
    // it; this reconcile can't). Any non-blank, non-ACTIVE form status = off.
    // Without this, an active ad set would wrongly REACTIVATE a config whose
    // lead form is archived/paused/draft.
    const formStr    = String(cfg.metaFormStatus || "").trim().toUpperCase();
    const formPaused = formStr !== "" && formStr !== "ACTIVE";
    const metaActive = !(adsetPaused || campaignPaused || formPaused);

    const update = {
      metaAdsetStatus:    adsetRec ? adsetRec.status : cfg.metaAdsetStatus || "",
      metaCampaignStatus: campaignRec ? campaignRec.status : cfg.metaCampaignStatus || "",
      metaActive,
      metaStatusSyncedAt: new Date(),
    };
    // Backfill resolved Meta IDs so future runs match by id (more robust than name).
    if (adsetRec && adsetRec.id && !cfg.metaAdsetId)       update.metaAdsetId    = adsetRec.id;
    if (campaignRec && campaignRec.id && !cfg.metaCampaignId) update.metaCampaignId = campaignRec.id;

    if (!metaActive && cfg.isActive) {
      update.isActive = false;
      update.pausedByMeta = true;
      paused++;
      console.log(`[MetaStatusSync] ⏸  Auto-paused "${cfg.campaignName}" — form=${cfg.metaFormStatus || "n/a"} adset=${adsetRec?.status || "n/a"} campaign=${campaignRec?.status || "n/a"}`);
    } else if (metaActive && cfg.pausedByMeta && !cfg.isActive) {
      update.isActive = true;
      update.pausedByMeta = false;
      reactivated++;
      console.log(`[MetaStatusSync] ▶️  Auto-reactivated "${cfg.campaignName}" — Meta active again`);
    }

    await MetaConfig.findByIdAndUpdate(cfg._id, update);
  }

  return { checked, paused, reactivated, accounts: accountsOk, credentialed: true };
}

// Drop the legacy single-field unique index on pageId if it still exists.
// (One-time migration; safe to call repeatedly — it no-ops once gone.)
async function dropLegacyPageIdIndex() {
  try {
    const collection = MetaConfig.collection;
    const indexes = await collection.indexes();
    const legacyIndex = indexes.find(
      (idx) =>
        idx.name === "pageId_1" &&
        idx.unique === true &&
        Object.keys(idx.key).length === 1 &&
        idx.key.pageId !== undefined
    );
    if (legacyIndex) {
      await collection.dropIndex("pageId_1");
      console.log("✅ Dropped legacy pageId_1 unique index");
    }
  } catch (indexErr) {
    console.warn("⚠️  Could not drop legacy index (may not exist):", indexErr.message);
  }
}

/**
 * Sync all lead forms on a Meta page into MetaConfig documents.
 *
 * @param {Object}  opts
 * @param {String}  opts.pageId
 * @param {String}  opts.pageAccessToken
 * @param {String}  opts.companyId
 * @param {String} [opts.graphApiVersion="v22.0"]
 * @returns {Promise<{ created:Number, skipped:Number, forms:Array }>}
 */
async function syncPageForms({ pageId, pageAccessToken, companyId, graphApiVersion = "v22.0" }) {
  if (!pageId || !pageAccessToken) {
    throw new Error("pageId and pageAccessToken are required");
  }

  // Fallback ads_read token: the page token often cannot read ad-set / campaign
  // effective_status (needed to mirror campaign/ad-set pauses). The Meta
  // Performance report stores an ads_read token on MetaConfig — reuse it so
  // status detection works without any extra setup.
  let fallbackAdsToken = "";
  try {
    const credCfg = await MetaConfig.findOne({
      company: companyId,
      adsToken: { $nin: ["", null] },
    }).select("adsToken").lean();
    if (credCfg && credCfg.adsToken) fallbackAdsToken = credCfg.adsToken;
  } catch (e) { /* optional — ignore */ }

  // ── Step 1: legacy index migration ──────────────────────────────────────────
  await dropLegacyPageIdIndex();

  // ── Step 2: fetch all lead forms on the page (paginated) ─────────────────────
  let allForms = [];
  let nextUrl = `https://graph.facebook.com/${graphApiVersion}/${pageId}/leadgen_forms`;
  let params = {
    fields: "id,name,status,ad_id,adset_id,campaign_id,campaign_name,adset_name",
    access_token: pageAccessToken,
    limit: 100,
  };

  while (nextUrl) {
    const formsRes = await axios.get(nextUrl, { params });
    const page = formsRes.data?.data || [];
    allForms = allForms.concat(page);
    nextUrl = formsRes.data?.paging?.next || null;
    params = {};
  }

  if (allForms.length === 0) {
    return { success: true, created: 0, skipped: 0, forms: [] };
  }

  // ── Step 3: enrich forms with ad set name / campaign name / status ──────────
  // We always need the ad set's effective_status (to mirror paused/archived
  // state in the CRM), and sometimes the adset_name / campaign_name that Meta's
  // leadgen_forms endpoint omits. Fetch each unique ad set ONCE via a cache.
  const adsetCache = new Map(); // adset_id -> { name, campaignName, campaignId, effectiveStatus } | null

  const getAdsetInfo = async (adsetId) => {
    if (!adsetId) return null;
    if (adsetCache.has(adsetId)) return adsetCache.get(adsetId);
    const fetchWith = async (tok) => {
      const adsetRes = await axios.get(
        `https://graph.facebook.com/${graphApiVersion}/${adsetId}`,
        {
          params: {
            fields: "id,name,effective_status,status,campaign_id,campaign{id,name,objective}",
            access_token: tok,
          },
        }
      );
      const a = adsetRes.data || {};
      return {
        id:              a.id || adsetId,
        name:            a.name || "",
        campaignName:    a.campaign && a.campaign.name ? a.campaign.name : "",
        campaignId:      (a.campaign && a.campaign.id) ? a.campaign.id : (a.campaign_id || ""),
        objective:       (a.campaign && a.campaign.objective) ? a.campaign.objective : "",
        effectiveStatus: a.effective_status || a.status || "",
      };
    };
    try {
      // Try the page token first; on failure (usually missing ads_read) retry
      // with the account's ads_read token so campaign/ad-set pauses are still read.
      let info;
      try {
        info = await fetchWith(pageAccessToken);
      } catch (pageErr) {
        if (fallbackAdsToken) info = await fetchWith(fallbackAdsToken);
        else throw pageErr;
      }
      adsetCache.set(adsetId, info);
      return info;
    } catch (e) {
      adsetCache.set(adsetId, null);
      return null;
    }
  };

  const enrichedForms = await Promise.all(
    allForms.map(async (form) => {
      const info = await getAdsetInfo(form.adset_id || "");
      return {
        ...form,
        adset_name:    form.adset_name    || (info && info.name)         || "",
        campaign_name: form.campaign_name || (info && info.campaignName) || "",
        campaign_id:   form.campaign_id   || (info && info.campaignId)   || "",
        _adsetId:      form.adset_id      || (info && info.id ? info.id : ""),
        _adsetStatus:  (info && info.effectiveStatus) || "",
        _objective:    (info && info.objective) || "",
      };
    })
  );

  // ── Step 4: upsert MetaConfig per (pageId, formId) ───────────────────────────
  // A form/ad set counts as ACTIVE on Meta only when its status is exactly
  // "ACTIVE". Anything else (PAUSED, ADSET_PAUSED, CAMPAIGN_PAUSED, ARCHIVED,
  // DELETED, DRAFT, DISAPPROVED, …) is treated as inactive so the CRM mirrors it.
  const isMetaActive = (s) => String(s || "").trim().toUpperCase() === "ACTIVE";

  let created = 0;
  let skipped = 0;
  const results = [];

  for (const form of enrichedForms) {
    // Meta-side live status for THIS form + its ad set.
    const formStatus  = form.status || "";
    const adsetStatus = form._adsetStatus || "";
    // Form status may be blank on some form types — only fail active on an
    // explicit non-ACTIVE value. Ad set: same rule when we have a value.
    const formActive  = formStatus  ? isMetaActive(formStatus)  : true;
    const adsetActive = adsetStatus ? isMetaActive(adsetStatus) : true;
    const metaActive  = formActive && adsetActive;

    // Primary match: a config already pinned to this exact (pageId, formId).
    let existing = await MetaConfig.findOne({ pageId, formId: form.id });

    // Also ADOPT a pre-existing formId-less config that matches this form's
    // ad set / campaign, and backfill its formId so the webhook's precise
    // (pageId + formId) match starts working.
    const adoptName = (form.adset_name || "").trim();
    const adoptCampaign = (form.campaign_name || "").trim();
    if (!existing && (adoptName || adoptCampaign)) {
      const candidates = await MetaConfig.find({
        pageId,
        $or: [{ formId: "" }, { formId: { $exists: false } }],
      });
      existing =
        (adoptName &&
          candidates.find(
            (c) => (c.adSetName || "").trim().toLowerCase() === adoptName.toLowerCase(),
          )) ||
        (adoptCampaign &&
          candidates.find(
            (c) =>
              (c.adSetName || "").trim() === "" &&
              (c.campaignName || "").trim().toLowerCase() === adoptCampaign.toLowerCase(),
          )) ||
        null;
    }

    const parentCampaignName = (form.campaign_name || "").trim();
    const adSetName          = (form.adset_name    || "").trim();
    // Auto-detect category from Meta objective (preferred) or campaign name keywords
    const autoCategory = objectiveToCategory(form._objective || "") ||
                         inferCategoryFromName(form.campaign_name || "");

    let campaignName;
    if (parentCampaignName && adSetName) {
      campaignName = `${parentCampaignName} › ${adSetName}`;
    } else if (parentCampaignName) {
      campaignName = parentCampaignName;
    } else {
      campaignName = form.name || "Meta Campaign";
    }

    if (existing) {
      const update = {};
      if (!existing.formId) update.formId = form.id;
      if (!Array.isArray(existing.formIds) || !existing.formIds.includes(form.id)) {
        update.formIds = Array.from(new Set([...(existing.formIds || []), form.id]));
      }
      if (!existing.parentCampaignName && parentCampaignName) {
        update.parentCampaignName = parentCampaignName;
      }
      if (!existing.adSetName && adSetName) {
        update.adSetName = adSetName;
      }
      // Auto-set category only when the admin hasn't manually set one
      if (!existing.category && autoCategory) {
        update.category = autoCategory;
      }

      // ── Mirror Meta's live status ──────────────────────────────────────────
      // Always record the raw statuses for display.
      update.metaFormStatus     = formStatus;
      update.metaAdsetStatus    = adsetStatus;
      // Backfill Meta IDs so the ads_read reconcile can match this card by id
      // (more reliable than name matching when card names differ from Meta).
      if (form._adsetId && !existing.metaAdsetId)       update.metaAdsetId    = form._adsetId;
      if (form.campaign_id && !existing.metaCampaignId) update.metaCampaignId = form.campaign_id;
      update.metaActive         = metaActive;
      update.metaStatusSyncedAt = new Date();

      if (!metaActive && existing.isActive) {
        // Meta turned this ad set / form off → auto-pause in the CRM and record
        // that WE did it (so we can safely turn it back on later).
        update.isActive     = false;
        update.pausedByMeta = true;
        console.log(`⏸  Auto-paused "${existing.campaignName}" — Meta status form=${formStatus || "n/a"} adset=${adsetStatus || "n/a"}`);
      } else if (metaActive && existing.pausedByMeta && !existing.isActive) {
        // Meta turned it back on and the CRM pause was OUR doing → reactivate.
        // An admin's manual pause has pausedByMeta=false and is left untouched.
        update.isActive     = true;
        update.pausedByMeta = false;
        console.log(`▶️  Auto-reactivated "${existing.campaignName}" — Meta is active again`);
      }

      await MetaConfig.findByIdAndUpdate(existing._id, update);

      skipped++;
      results.push({
        formId:             form.id,
        formName:           form.name,
        campaignName:       existing.campaignName,
        adSetName:          existing.adSetName || adSetName,
        parentCampaignName: existing.parentCampaignName || parentCampaignName,
        metaActive,
        status:             update.formId ? "updated (formId backfilled)" : "skipped (already exists)",
      });
      continue;
    }

    await MetaConfig.create({
      campaignName,
      adSetName,
      parentCampaignName,
      category: autoCategory || "",
      pageId,
      pageAccessToken,
      formId:          form.id,
      formIds:         [form.id],
      company:         companyId,
      // New configs inherit Meta's current state — a form already paused on Meta
      // is created paused, and flagged so sync can reactivate it if Meta resumes.
      isActive:        metaActive,
      pausedByMeta:    !metaActive,
      metaFormStatus:     formStatus,
      metaAdsetStatus:    adsetStatus,
      metaAdsetId:        form._adsetId || "",
      metaCampaignId:     form.campaign_id || "",
      metaActive,
      metaStatusSyncedAt: new Date(),
      defaultStatus:   "New",
      defaultRemark:   "Lead from Meta Campaign",
      graphApiVersion,
      roundRobinIndex: 0,
    });

    created++;
    results.push({
      formId:             form.id,
      formName:           form.name,
      campaignName,
      adSetName,
      parentCampaignName,
      metaActive,
      status:             "created",
    });
  }

  return { success: true, created, skipped, forms: results };
}

module.exports = { syncPageForms, reconcileMetaStatusesForCompany };