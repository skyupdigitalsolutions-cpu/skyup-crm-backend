// services/marketing/analyticsService.js
// ─────────────────────────────────────────────────────────────────────────────
// Performance Marketing analytics — business-outcome first.
//
// Every endpoint is computed from ONE context:
//   leadFacts (canonical CRM dataset) + Meta platform data + Google platform data
// so Overview, Paid Media, Creatives, Pipeline, Reports and Data Health always
// reconcile with each other.
//
// Optimization metrics (Qualified, CPQL, Won, CAC, Revenue, ROAS) decide where
// money goes; diagnostic metrics (CTR, CPM, CPC, Frequency, LPV) explain why.
// No ?. / ?? operators (Beautify-safe).
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const F = require("./leadFacts");
const { DICTIONARY, DIAGNOSTIC_RULES, LOST_REASONS, STAGES } = require("./dictionary");
const { getMetaAdsData } = require("./metaAdsFetcher");
const { getGoogleAdsData } = require("./googleAdsFetcher");

const CTX_TTL_MS = 60 * 1000;
const ctxCache = new Map();

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const div = (a, b) => (b > 0 ? a / b : null);
const rn = (v) => (v == null ? null : r2(v));
const pctOf = (a, b) => (b > 0 ? r2((a / b) * 100) : null);
const money = (v) => (v == null ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));

// ── Settings ─────────────────────────────────────────────────────────────────
async function getSettings(company) {
  const MS = require("../../models/MarketingSettings");
  let s = await MS.findOne({ company: company }).lean();
  if (!s) s = new MS({ company: company }).toObject();
  return s;
}
async function saveSettings(company, body, adminId) {
  const MS = require("../../models/MarketingSettings");
  const allowed = ["creativeMinImpressions", "creativeMinSpend", "creativeMinClicks", "creativeMinLeads", "fatigueFrequency",
    "fatigueCtrDropPct", "fatigueCpcRisePct", "slaFirstContactMinutes", "proposalStaleDays", "targetCpl", "targetCpql",
    "targetCac", "targetRoas", "defaultDealValue"];
  const set = { updatedBy: adminId || null };
  allowed.forEach(function (k) {
    if (body && body[k] !== undefined && body[k] !== "" && !isNaN(Number(body[k]))) set[k] = Math.max(0, Number(body[k]));
  });
  const doc = await MS.findOneAndUpdate({ company: company }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  ctxCache.clear();
  return doc;
}

// ── Aggregation helpers ──────────────────────────────────────────────────────
function agg(facts) {
  const a = { leads: 0, paidLeads: 0, attempted: 0, contacted: 0, qualified: 0, opportunities: 0, proposals: 0, won: 0, lost: 0, revenue: 0, revenueEstimated: 0, unmapped: 0, uncontacted: 0 };
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    a.leads++;
    if (f.paid) a.paidLeads++;
    if (f.attempted) a.attempted++;
    if (f.contacted) a.contacted++;
    if (f.isQualified) a.qualified++;
    if (f.isOpp) a.opportunities++;
    if (f.isProposal) a.proposals++;
    if (f.isWon) a.won++;
    if (f.isLost) a.lost++;
    if (f.statusCategory === "unmapped") a.unmapped++;
    if (!f.attempted && !f.isLost && !f.isWon) a.uncontacted++;
    a.revenue += f.revenue;
    if (f.revenueType === "estimated") a.revenueEstimated += f.revenue;
  }
  a.revenue = r2(a.revenue); a.revenueEstimated = r2(a.revenueEstimated);
  return a;
}

// Efficiency ratios for a row. `denomLeads` lets Overview use paid leads only.
function ratios(a, spend, denomLeads) {
  const L = denomLeads == null ? a.leads : denomLeads;
  return {
    spend: r2(spend),
    cpl: spend > 0 ? rn(div(spend, L)) : null,
    cpql: spend > 0 ? rn(div(spend, a.qualified)) : null,
    costPerOpp: spend > 0 ? rn(div(spend, a.opportunities)) : null,
    cac: spend > 0 ? rn(div(spend, a.won)) : null,
    roas: spend > 0 && a.revenue > 0 ? r2(a.revenue / spend) : null,
    qualRate: pctOf(a.qualified, a.leads),
    oppRate: pctOf(a.opportunities, a.qualified),
    qualToWon: pctOf(a.won, a.qualified),
    leadToWon: pctOf(a.won, a.leads),
    winRate: pctOf(a.won, a.opportunities),
    leadValue: a.leads > 0 && a.revenue > 0 ? r2(a.revenue / a.leads) : null,
    qualLeadValue: a.qualified > 0 && a.revenue > 0 ? r2(a.revenue / a.qualified) : null,
  };
}
function row(base, facts, spend, denom) { const a = agg(facts); return Object.assign(base, a, ratios(a, spend || 0, denom)); }

function groupBy(arr, fn) {
  const m = new Map();
  arr.forEach(function (x) { const k = fn(x); if (k == null || k === "") return; if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
  return m;
}
function median(arr) { if (!arr.length) return null; const s = arr.slice().sort(function (a, b) { return a - b; }); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }

function metric(key, cur, prev, calc, extra) {
  const d = DICTIONARY[key] || {};
  let deltaPct = null;
  if (cur != null && prev != null && prev !== 0) deltaPct = r2(((cur - prev) / Math.abs(prev)) * 100);
  else if (cur != null && prev === 0 && cur !== 0) deltaPct = 100;
  let tone = "neutral";
  if (deltaPct != null && Math.abs(deltaPct) >= 2 && d.better && d.better !== "neutral") {
    const up = deltaPct > 0;
    tone = (up && d.better === "up") || (!up && d.better === "down") ? "good" : "bad";
  }
  return Object.assign({ key: key, label: d.label || key, value: cur, prev: prev == null ? null : prev, deltaPct: deltaPct, tone: tone, format: d.format || "num", calc: calc || "" }, extra || {});
}

// ── Context ──────────────────────────────────────────────────────────────────
async function buildRangeContext({ company, range, leadScope, refresh, salesperson, withPlatform, includeGclid }) {
  const svc = require("../customizationService");
  const MetaConfig = require("../../models/MetaConfig");
  const [cust, settings, metaConfigs] = await Promise.all([
    svc.getCustomization(company),
    getSettings(company),
    MetaConfig.find({ company: company }).lean(),
  ]);
  const extraMatch = {};
  if (salesperson && mongoose.Types.ObjectId.isValid(salesperson)) extraMatch.user = new mongoose.Types.ObjectId(salesperson);
  const raw = await F.loadRawFacts(company, range, extraMatch, leadScope);

  let metaData = { configured: false, campaigns: [], adsets: [], ads: [], idleCampaigns: [], trend: [], fatigue: {}, totals: { spend: 0 }, accounts: [] };
  let googleData = { source: "none", campaigns: [], adGroups: [], keywords: [], searchTerms: [], ads: [], devices: [], locations: [], landingPages: [], trend: [], totals: { spend: 0 }, manualConfigs: [], gclidMap: {} };
  if (withPlatform !== false) {
    const gclidLeads = includeGclid ? raw.filter(function (l) { return l.attribution && l.attribution.gclid && !l.attribution.googleAdGroupId; }).slice(0, 500).map(function (l) { return { gclid: l.attribution.gclid, createdAt: l.createdAt }; }) : [];
    const res = await Promise.all([
      getMetaAdsData({ company: company, configs: metaConfigs, since: range.since, until: range.until, refresh: refresh }).catch(function (e) { return Object.assign({}, metaData, { error: e.message }); }),
      getGoogleAdsData({ company: company, since: range.since, until: range.until, refresh: refresh, gclidLeads: gclidLeads }).catch(function (e) { return Object.assign({}, googleData, { error: e.message }); }),
    ]);
    metaData = res[0]; googleData = res[1];
  } else {
    const GoogleAdsConfig = require("../../models/GoogleAdsConfig");
    googleData.manualConfigs = await GoogleAdsConfig.find({ company: company }).lean();
  }

  const lookups = F.buildLookups(cust);
  const attrIdx = F.buildAttributionIndex(metaConfigs, metaData, googleData);
  const facts = raw.map(function (l) { return F.classify(l, { lookups: lookups, attrIdx: attrIdx, settings: settings }); });

  // Persist newly resolved Google click ids (gclid → campaign/ad group/keyword).
  if (includeGclid && googleData.gclidMap && Object.keys(googleData.gclidMap).length) {
    const Lead = require("../../models/Leads");
    const ops = [];
    facts.forEach(function (f) {
      if (f.google && f.google.gclidResolved && !(f.attribution && f.attribution.googleAdGroupId)) {
        ops.push({ updateOne: { filter: { _id: f._id }, update: { $set: {
          "attribution.googleCampaignId": f.google.campaignId, "attribution.googleAdGroupId": f.google.adGroupId, "attribution.keyword": f.google.keyword, "attribution.channel": "google",
        } } } });
      }
    });
    if (ops.length) Lead.bulkWrite(ops.slice(0, 500), { ordered: false }).catch(function () {});
  }

  return { company: company, range: range, cust: cust, settings: settings, metaConfigs: metaConfigs, metaData: metaData, googleData: googleData, facts: facts, lookups: lookups };
}

async function getContext(opts) {
  // Always resolve GCLIDs so every tab uses the same attribution (results are
  // cached in the Google fetcher and written back to the lead).
  opts = Object.assign({}, opts, { includeGclid: true });
  const range = F.parseRange(opts.query.from, opts.query.to);
  const scopeKey = JSON.stringify(opts.leadScope || {}).slice(0, 300);
  const key = [String(opts.company), range.since, range.until, opts.query.salesperson || "", scopeKey, opts.withPlatform === false ? "np" : "p", opts.includeGclid ? "g" : ""].join("|");
  const hit = ctxCache.get(key);
  if (!opts.refresh && hit && Date.now() - hit.at < CTX_TTL_MS) return hit.ctx;
  const ctx = await buildRangeContext({ company: opts.company, range: range, leadScope: opts.leadScope, refresh: opts.refresh, salesperson: opts.query.salesperson, withPlatform: opts.withPlatform, includeGclid: opts.includeGclid });
  ctxCache.set(key, { at: Date.now(), ctx: ctx });
  if (ctxCache.size > 100) ctxCache.delete(ctxCache.keys().next().value);
  return ctx;
}

// Post-classification filters (channel / campaign / status / qualification).
function applyFilters(facts, q) {
  return facts.filter(function (f) {
    if (q.channel && q.channel !== "all") {
      if (q.channel === "paid" ? !f.paid : f.channel !== q.channel) return false;
    }
    if (q.campaign && f.campaignKey !== q.campaign) return false;
    if (q.status && f.status !== q.status && f.statusCategory !== q.status) return false;
    if (q.qualification === "qualified" && !f.isQualified) return false;
    if (q.qualification === "unqualified" && f.isQualified) return false;
    return true;
  });
}

function campaignSpendMap(ctx) {
  const m = {};
  (ctx.metaData.campaigns || []).forEach(function (c) { m["meta:" + c.id] = { spend: c.metrics.spend, name: c.name, status: c.status, channel: "meta", metrics: c.metrics, id: c.id }; });
  (ctx.metaData.idleCampaigns || []).forEach(function (c) { if (!m["meta:" + c.id]) m["meta:" + c.id] = { spend: 0, name: c.name, status: c.status, channel: "meta", id: c.id }; });
  (ctx.googleData.campaigns || []).forEach(function (c) {
    const k = c.id ? "google:" + c.id : "google-name:" + c.name;
    m[k] = { spend: c.metrics.spend, name: c.name, status: c.status, channel: "google", metrics: c.metrics, id: c.id };
  });
  return m;
}

function spendFor(ctx, q) {
  const meta = Number(ctx.metaData.totals && ctx.metaData.totals.spend) || 0;
  const google = Number(ctx.googleData.totals && ctx.googleData.totals.spend) || 0;
  if (q.campaign) { const c = campaignSpendMap(ctx)[q.campaign]; return c ? c.spend : 0; }
  if (q.channel === "meta") return meta;
  if (q.channel === "google") return google;
  if (q.channel && q.channel !== "all" && q.channel !== "paid") return 0;
  return r2(meta + google);
}

function filterOptions(ctx, users) {
  const campaigns = [];
  const seen = {};
  const spendMap = campaignSpendMap(ctx);
  ctx.facts.forEach(function (f) {
    if (seen[f.campaignKey]) return;
    seen[f.campaignKey] = 1;
    const p = spendMap[f.campaignKey];
    campaigns.push({ key: f.campaignKey, label: (p && p.name) || f.campaignLabel || f.campaignKey, channel: f.channel });
  });
  Object.keys(spendMap).forEach(function (k) {
    if (!seen[k] && spendMap[k].spend > 0) { seen[k] = 1; campaigns.push({ key: k, label: spendMap[k].name, channel: spendMap[k].channel }); }
  });
  campaigns.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
  const channels = Array.from(new Set(ctx.facts.map(function (f) { return f.channel; }).concat(ctx.metaData.configured ? ["meta"] : []).concat(ctx.googleData.source !== "none" ? ["google"] : [])));
  const statuses = (ctx.cust.statuses || []).filter(function (s) { return s.active !== false; }).map(function (s) { return { key: s.key, label: s.label, category: s.category }; });
  return { channels: channels, campaigns: campaigns, salespeople: users, statuses: statuses };
}

async function userNames(company) {
  const User = require("../../models/Users");
  const users = await User.find({ company: company }).select("name email isActive").lean();
  const map = {};
  users.forEach(function (u) { map[String(u._id)] = u.name || u.email || "User"; });
  return { map: map, list: users.filter(function (u) { return u.isActive !== false; }).map(function (u) { return { id: String(u._id), name: u.name || u.email }; }) };
}

// ── Funnel ───────────────────────────────────────────────────────────────────
function funnel(facts) {
  const steps = [
    { key: "leads", label: "Leads", test: function () { return true; } },
    { key: "attempted", label: "Contact Attempted", test: function (f) { return f.attempted; } },
    { key: "contacted", label: "Contacted", test: function (f) { return f.contacted; } },
    { key: "qualified", label: "Qualified", test: function (f) { return f.isQualified; } },
    { key: "meeting", label: "Discovery / Meeting", test: function (f) { return f.isOpp; } },
    { key: "proposal", label: "Proposal", test: function (f) { return f.isProposal; } },
    { key: "won", label: "Won", test: function (f) { return f.isWon; } },
  ];
  let prev = null;
  const first = facts.length;
  return steps.map(function (s) {
    const c = facts.filter(s.test).length;
    const out = { key: s.key, label: s.label, count: c, stepRate: prev == null ? null : pctOf(c, prev), overallRate: pctOf(c, first), dropOff: prev == null ? null : prev - c };
    prev = c;
    return out;
  });
}

// ── Trend (auto hourly for single-day ranges) ────────────────────────────────
function trend(ctx, facts, q) {
  const hourly = ctx.range.since === ctx.range.until;
  const keyOf = hourly ? F.istHourKey : F.istDayKey;
  const buckets = {};
  const keys = [];
  if (hourly) { for (let h = 0; h < 24; h++) keys.push(ctx.range.since + "T" + String(h).padStart(2, "0")); }
  else { for (let d = ctx.range.since; d <= ctx.range.until; d = F.addDays(d, 1)) keys.push(d); }
  keys.forEach(function (k) { buckets[k] = { t: k, spend: 0, leads: 0, qualified: 0, won: 0, revenue: 0 }; });
  const useMeta = !q.channel || q.channel === "all" || q.channel === "paid" || q.channel === "meta";
  const useGoogle = !q.channel || q.channel === "all" || q.channel === "paid" || q.channel === "google";
  if (!q.campaign) {
    if (useMeta) (ctx.metaData.trend || []).forEach(function (t) { if (buckets[t.t]) buckets[t.t].spend = r2(buckets[t.t].spend + t.spend); });
    if (useGoogle && ctx.googleData.source === "api") (ctx.googleData.trend || []).forEach(function (t) { if (buckets[t.t]) buckets[t.t].spend = r2(buckets[t.t].spend + t.spend); });
  }
  facts.forEach(function (f) {
    const b = buckets[keyOf(f.createdAt)];
    if (!b) return;
    b.leads++; if (f.isQualified) b.qualified++; if (f.isWon) { b.won++; b.revenue = r2(b.revenue + f.revenue); }
  });
  return { granularity: hourly ? "hour" : "day", points: keys.map(function (k) { return buckets[k]; }), spendByCampaignAvailable: !q.campaign };
}

// ── Campaign rows (cross-channel) ────────────────────────────────────────────
function campaignRows(ctx, facts) {
  const spendMap = campaignSpendMap(ctx);
  const groups = groupBy(facts, function (f) { return f.campaignKey; });
  const keys = new Set(Array.from(groups.keys()));
  Object.keys(spendMap).forEach(function (k) { if (spendMap[k].spend > 0) keys.add(k); });
  const out = [];
  keys.forEach(function (k) {
    const fs = groups.get(k) || [];
    const p = spendMap[k];
    const channel = p ? p.channel : (fs[0] ? fs[0].channel : "");
    const name = p ? p.name : (fs[0] ? (fs[0].campaignLabel || "(no campaign)") : k);
    out.push(row({ key: k, name: name, channel: channel, status: p ? p.status : "", platformId: p ? p.id : "", nameMatched: (k.indexOf("meta-name:") === 0 || k.indexOf("google-name:") === 0) }, fs, p ? p.spend : 0));
  });
  return out;
}

// ── Response time ────────────────────────────────────────────────────────────
function responseStats(facts, slaMin) {
  const times = facts.filter(function (f) { return f.responseMin != null; }).map(function (f) { return f.responseMin; });
  const n = facts.length;
  const within = function (m) { return times.filter(function (t) { return t <= m; }).length; };
  return {
    avgMin: times.length ? Math.round(times.reduce(function (s, t) { return s + t; }, 0) / times.length) : null,
    medianMin: median(times),
    pct5: pctOf(within(5), n), pct15: pctOf(within(15), n), pct60: pctOf(within(60), n),
    withinSla: pctOf(within(slaMin || 60), n),
    uncontacted: facts.filter(function (f) { return f.responseMin == null && !f.isLost && !f.isWon; }).length,
    contactedCount: times.length, total: n,
  };
}

// ── Sales executive performance ──────────────────────────────────────────────
function salesExec(facts, names) {
  const groups = groupBy(facts, function (f) { return f.user || "unassigned"; });
  const out = [];
  groups.forEach(function (fs, uid) {
    const a = agg(fs);
    const rt = fs.filter(function (f) { return f.responseMin != null; }).map(function (f) { return f.responseMin; });
    out.push(Object.assign({
      userId: uid === "unassigned" ? null : uid, name: uid === "unassigned" ? "Unassigned" : (names[uid] || "Unknown user"),
      newAssigned: fs.filter(function (f) { return !f.attempted && !f.isLost && !f.isWon; }).length,
      avgResponseMin: rt.length ? Math.round(rt.reduce(function (s, t) { return s + t; }, 0) / rt.length) : null,
      medianResponseMin: median(rt),
      avgFollowUps: fs.length ? r2(fs.reduce(function (s, f) { return s + f.callCount; }, 0) / fs.length) : 0,
      overdueFollowUps: fs.reduce(function (s, f) { return s + (f.overdueFollowUps > 0 ? 1 : 0); }, 0),
      leadToQual: pctOf(a.qualified, a.leads), qualToWon: pctOf(a.won, a.qualified),
    }, a));
  });
  return out.sort(function (a, b) { return b.won - a.won || b.qualified - a.qualified || b.leads - a.leads; });
}

// ── Follow-ups (ALL open leads, not just the range) ──────────────────────────
async function followUps(company, leadScope, cust, userFilter) {
  const Lead = require("../../models/Leads");
  const { mergeLeadScope } = require("../../utils/adminLeadScope");
  const svc = require("../customizationService");
  const closed = svc.statusKeysByCategory(cust, ["won", "lost"]);
  const now = new Date();
  const istNow = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const dayStart = new Date(istNow + "T00:00:00+05:30"), dayEnd = new Date(istNow + "T23:59:59.999+05:30");
  const base = { company: company, mergedInto: null, isClosed: { $ne: true }, status: { $nin: closed } };
  if (userFilter && mongoose.Types.ObjectId.isValid(userFilter)) base.user = new mongoose.Types.ObjectId(userFilter);
  const res = await Lead.aggregate([
    { $match: mergeLeadScope(base, leadScope || {}) },
    { $project: { sched: { $filter: { input: { $ifNull: ["$scheduledCalls", []] }, as: "s", cond: { $ne: ["$$s.done", true] } } } } },
    { $project: {
      today:    { $size: { $filter: { input: "$sched", as: "s", cond: { $and: [{ $gte: ["$$s.scheduledAt", dayStart] }, { $lte: ["$$s.scheduledAt", dayEnd] }] } } } },
      upcoming: { $size: { $filter: { input: "$sched", as: "s", cond: { $gt: ["$$s.scheduledAt", dayEnd] } } } },
      missed:   { $size: { $filter: { input: "$sched", as: "s", cond: { $lt: ["$$s.scheduledAt", dayStart] } } } },
    } },
    { $group: { _id: null, today: { $sum: "$today" }, upcoming: { $sum: "$upcoming" }, missed: { $sum: "$missed" },
      leadsWithMissed: { $sum: { $cond: [{ $gt: ["$missed", 0] }, 1, 0] } } } },
  ]);
  const r = res[0] || { today: 0, upcoming: 0, missed: 0, leadsWithMissed: 0 };
  return { today: r.today, upcoming: r.upcoming, missed: r.missed, leadsWithMissed: r.leadsWithMissed };
}

// ── Creative scoring ─────────────────────────────────────────────────────────
function scoreCreatives(ctx, facts) {
  const s = ctx.settings;
  const metaFacts = facts.filter(function (f) { return f.channel === "meta"; });
  const byAd = groupBy(metaFacts, function (f) { return f.meta && f.meta.adId; });
  const byAdset = groupBy(metaFacts, function (f) { return f.meta && f.meta.adsetId; });
  const adLevelLeadIds = metaFacts.filter(function (f) { return f.meta && f.meta.adId; }).length;

  const ads = (ctx.metaData.ads || []).slice();
  // Peer benchmark = average of the ad's ad set (fallback campaign, then account).
  const peers = function (key, val) {
    const list = ads.filter(function (x) { return x[key] === val; });
    const sp = list.reduce(function (t, x) { return t + x.metrics.spend; }, 0);
    const im = list.reduce(function (t, x) { return t + x.metrics.impressions; }, 0);
    const lc = list.reduce(function (t, x) { return t + x.metrics.linkClicks; }, 0);
    return { count: list.length, linkCtr: im > 0 ? (lc / im) * 100 : null, cpc: lc > 0 ? sp / lc : null };
  };
  const acctAvg = peers("account", ads[0] ? ads[0].account : "");

  const out = ads.map(function (ad) {
    const m = ad.metrics;
    const crmFacts = byAd.get(ad.id) || [];
    const crm = crmFacts.length ? agg(crmFacts) : null;
    let bench = peers("adsetId", ad.adsetId), benchLabel = "ad set average";
    if (bench.count < 2) { bench = peers("campaignId", ad.campaignId); benchLabel = "campaign average"; }
    if (bench.count < 2) { bench = acctAvg; benchLabel = "account average"; }

    const reasons = [], recs = [];
    const insufficient = m.impressions < s.creativeMinImpressions || m.spend < s.creativeMinSpend || m.linkClicks < s.creativeMinClicks;
    let points = 0;

    const vs = function (val, ref) { return val != null && ref ? r2(((val - ref) / ref) * 100) : null; };
    const ctrDelta = vs(m.linkCtr, bench.linkCtr);
    const cpcDelta = vs(m.cpc, bench.cpc);
    if (ctrDelta != null) {
      if (ctrDelta <= -25) { points -= 2; reasons.push({ metric: "Link CTR", value: m.linkCtr + "%", text: "Link CTR is " + Math.abs(ctrDelta) + "% below the " + benchLabel + " (" + r2(bench.linkCtr) + "%)." }); recs.push("Refresh the hook / headline or test a new visual."); }
      else if (ctrDelta >= 20) { points += 1; reasons.push({ metric: "Link CTR", value: m.linkCtr + "%", text: "Link CTR is " + ctrDelta + "% above the " + benchLabel + "." }); }
    }
    if (cpcDelta != null) {
      if (cpcDelta >= 30) { points -= 1; reasons.push({ metric: "CPC", value: money(m.cpc), text: "Cost per link click is " + cpcDelta + "% above the " + benchLabel + " (" + money(bench.cpc) + ")." }); }
      else if (cpcDelta <= -20) { points += 1; reasons.push({ metric: "CPC", value: money(m.cpc), text: "Cost per link click is " + Math.abs(cpcDelta) + "% below the " + benchLabel + "." }); }
    }
    if (m.linkClicks >= 30 && m.lpv >= 0 && m.lpv / m.linkClicks < 0.5 && m.lpv > 0) {
      reasons.push({ metric: "LPV rate", value: pctOf(m.lpv, m.linkClicks) + "%", text: "Only " + pctOf(m.lpv, m.linkClicks) + "% of link clicks loaded the landing page — check page speed / pixel." });
      recs.push("Check landing-page load time and that the Meta pixel fires on page load.");
    }

    // Business quality (needs ad-level CRM attribution + enough leads)
    let businessScored = false;
    if (crm && crm.leads >= s.creativeMinLeads) {
      businessScored = true;
      const setFacts = byAdset.get(ad.adsetId) || [];
      const setAgg = setFacts.length ? agg(setFacts) : null;
      const qr = pctOf(crm.qualified, crm.leads);
      const setQr = setAgg ? pctOf(setAgg.qualified, setAgg.leads) : null;
      if (crm.qualified === 0) { points -= 3; reasons.push({ metric: "Qualified rate", value: "0%", text: crm.leads + " CRM leads, none qualified." }); recs.push("Lead quality is the problem, not volume — tighten the offer / add a qualifying question to the form."); }
      else if (setQr != null && qr >= setQr * 1.3) { points += 3; reasons.push({ metric: "Qualified rate", value: qr + "%", text: "Qualification rate " + qr + "% vs " + setQr + "% for the ad set." }); recs.push("Shift budget towards this creative."); }
      else if (setQr != null && qr <= setQr * 0.6) { points -= 2; reasons.push({ metric: "Qualified rate", value: qr + "%", text: "Qualification rate " + qr + "% vs " + setQr + "% for the ad set." }); }
      if (crm.won > 0) { points += 3; reasons.push({ metric: "Won", value: String(crm.won), text: crm.won + " customer(s) won from this ad." }); }
    }

    // Fatigue
    let fatigue = null;
    const fz = ctx.metaData.fatigue ? ctx.metaData.fatigue[ad.id] : null;
    if (fz && fz.first && fz.second && fz.first.impressions >= 300 && fz.second.impressions >= 300) {
      const ctrChange = fz.first.linkCtr > 0 ? r2(((fz.second.linkCtr - fz.first.linkCtr) / fz.first.linkCtr) * 100) : null;
      const cpcChange = fz.first.cpc ? r2(((fz.second.cpc - fz.first.cpc) / fz.first.cpc) * 100) : null;
      const freqUp = fz.second.frequency > fz.first.frequency;
      const highFreq = fz.second.frequency >= s.fatigueFrequency || m.frequency >= s.fatigueFrequency;
      if (highFreq && freqUp && ((ctrChange != null && ctrChange <= -s.fatigueCtrDropPct) || (cpcChange != null && cpcChange >= s.fatigueCpcRisePct))) {
        fatigue = { firstHalf: fz.first, secondHalf: fz.second, ctrChange: ctrChange, cpcChange: cpcChange, halves: fz.halves };
        points -= 1;
        reasons.push({ metric: "Fatigue", value: m.frequency + "×", text: "Possible creative fatigue: frequency " + fz.first.frequency + "→" + fz.second.frequency + ", Link CTR " + (ctrChange == null ? "—" : ctrChange + "%") + ", CPC " + (cpcChange == null ? "—" : "+" + cpcChange + "%") + " between halves of the period." });
        recs.push("Rotate in a fresh creative; keep the audience if other ads in the ad set still perform.");
      }
    }
    if (m.frequency >= s.fatigueFrequency && !fatigue) reasons.push({ metric: "Frequency", value: m.frequency + "×", text: "Frequency has crossed your fatigue threshold (" + s.fatigueFrequency + "×) but CTR/CPC haven't deteriorated yet — watch it." });

    let rating = "Fair";
    if (insufficient && !businessScored) rating = "Learning";
    else if (points >= 2) rating = "Good";
    else if (points <= -2) rating = "Needs Attention";
    if (rating === "Learning") {
      reasons.unshift({ metric: "Data", value: "", text: "Insufficient data — needs ≥" + s.creativeMinImpressions + " impressions, ≥" + money(s.creativeMinSpend) + " spend and ≥" + s.creativeMinClicks + " link clicks before rating (has " + m.impressions + " / " + money(m.spend) + " / " + m.linkClicks + ")." });
    }
    if (!recs.length && rating === "Good") recs.push("Keep running; consider increasing budget gradually (≤20%/day).");
    return {
      platform: "meta", id: ad.id, name: ad.name, status: ad.status, campaignId: ad.campaignId, adsetId: ad.adsetId,
      campaignName: ((ctx.metaData.campaigns || []).find(function (c) { return c.id === ad.campaignId; }) || {}).name || "",
      adsetName: ((ctx.metaData.adsets || []).find(function (c) { return c.id === ad.adsetId; }) || {}).name || "",
      creative: ad.creative, metrics: m,
      crm: crm ? Object.assign(crm, ratios(crm, m.spend)) : null,
      rating: rating, score: points, reasons: reasons, recommendations: recs, fatigue: fatigue, businessScored: businessScored,
      benchmark: { label: benchLabel, linkCtr: bench.linkCtr == null ? null : r2(bench.linkCtr), cpc: bench.cpc == null ? null : r2(bench.cpc) },
    };
  });

  // Google responsive search ads
  (ctx.googleData.ads || []).forEach(function (ad) {
    const m = ad.metrics;
    const insufficient = m.impressions < s.creativeMinImpressions || m.spend < s.creativeMinSpend || m.clicks < s.creativeMinClicks;
    const reasons = [], recs = [];
    const siblings = ctx.googleData.ads.filter(function (x) { return x.adGroupId === ad.adGroupId; });
    const sImp = siblings.reduce(function (t, x) { return t + x.metrics.impressions; }, 0), sClk = siblings.reduce(function (t, x) { return t + x.metrics.clicks; }, 0);
    const benchCtr = sImp > 0 ? (sClk / sImp) * 100 : null;
    let points = 0;
    if (benchCtr && siblings.length > 1) {
      const d = r2(((m.ctr - benchCtr) / benchCtr) * 100);
      if (d <= -25) { points -= 2; reasons.push({ metric: "CTR", value: m.ctr + "%", text: "CTR " + Math.abs(d) + "% below the ad group average (" + r2(benchCtr) + "%)." }); recs.push("Test new headlines that mirror the top search terms."); }
      if (d >= 20) { points += 1; reasons.push({ metric: "CTR", value: m.ctr + "%", text: "CTR " + d + "% above the ad group average." }); }
    }
    if (m.spend > 0 && m.platformConversions === 0 && !insufficient) { points -= 1; reasons.push({ metric: "Conversions", value: "0", text: "Spent " + money(m.spend) + " with no platform conversions." }); }
    if (m.platformConversions > 0) { points += 1; reasons.push({ metric: "Conversions", value: String(m.platformConversions), text: m.platformConversions + " platform conversions at " + money(rn(div(m.spend, m.platformConversions))) + " each." }); }
    let rating = insufficient ? "Learning" : points >= 2 ? "Good" : points <= -2 ? "Needs Attention" : "Fair";
    if (insufficient) reasons.unshift({ metric: "Data", value: "", text: "Insufficient data for a rating (" + m.impressions + " impressions, " + money(m.spend) + ", " + m.clicks + " clicks)." });
    out.push({
      platform: "google", id: ad.id, name: ad.name, status: ad.status, campaignId: ad.campaignId, adGroupId: ad.adGroupId,
      campaignName: (ctx.googleData.campaigns.find(function (c) { return c.id === ad.campaignId; }) || {}).name || "",
      adsetName: (ctx.googleData.adGroups.find(function (g) { return g.id === ad.adGroupId; }) || {}).name || "",
      creative: ad.creative, metrics: Object.assign({ linkCtr: m.ctr, linkClicks: m.clicks }, m), crm: null,
      rating: rating, score: points, reasons: reasons, recommendations: recs, fatigue: null, businessScored: false,
    });
  });

  return { ads: out, adLevelAttribution: { metaLeads: metaFacts.length, withAdId: adLevelLeadIds, pct: pctOf(adLevelLeadIds, metaFacts.length) } };
}

// ── Action Center ────────────────────────────────────────────────────────────
function actionCenter(ctx, facts, extras) {
  const s = ctx.settings;
  const items = [];
  const now = Date.now();
  const sla = s.slaFirstContactMinutes || 60;
  const stale = facts.filter(function (f) { return !f.attempted && !f.isLost && !f.isWon && now - new Date(f.createdAt).getTime() > sla * 60000; });
  if (stale.length) items.push({ severity: "critical", key: "uncontacted", title: stale.length + " new lead" + (stale.length > 1 ? "s" : "") + " not contacted for >" + (sla >= 60 ? sla / 60 + "h" : sla + " min"), detail: "No call attempt logged since the lead came in.", drill: { uncontacted: "1" } });

  const camps = campaignRows(ctx, facts).filter(function (c) { return c.spend >= (s.creativeMinSpend || 500) && c.qualified === 0; });
  if (camps.length) {
    const sp = camps.reduce(function (t, c) { return t + c.spend; }, 0);
    items.push({ severity: "critical", key: "spendNoQual", title: money(sp) + " spent on " + camps.length + " campaign" + (camps.length > 1 ? "s" : "") + " with no qualified leads", detail: camps.slice(0, 4).map(function (c) { return c.name; }).join(", "), tab: "paid" });
  }
  if (extras && extras.fatigued) items.push({ severity: "warning", key: "fatigue", title: extras.fatigued + " ad" + (extras.fatigued > 1 ? "s show" : " shows") + " possible creative fatigue", detail: "Frequency rising while Link CTR falls / CPC rises.", tab: "creatives" });
  if (ctx.googleData.source === "api") {
    const waste = (ctx.googleData.searchTerms || []).filter(function (t) { return t.metrics.spend >= 200 && t.metrics.platformConversions === 0; });
    if (waste.length) items.push({ severity: "warning", key: "searchTerms", title: waste.length + " Google search term" + (waste.length > 1 ? "s" : "") + " spent " + money(waste.reduce(function (t, x) { return t + x.metrics.spend; }, 0)) + " with no conversions", detail: "Candidates for negative keywords: " + waste.slice(0, 3).map(function (w) { return "\"" + w.term + "\""; }).join(", "), tab: "paid", sub: "google" });
  }
  const unmapped = facts.filter(function (f) { return f.statusCategory === "unmapped"; }).length;
  if (unmapped) items.push({ severity: "warning", key: "unmapped", title: unmapped + " CRM lead" + (unmapped > 1 ? "s have" : " has") + " an unmapped status", detail: "Status isn't in Customize CRM → Statuses, so it can't be placed in the pipeline.", drill: { statusCategory: "unmapped" } });
  const hotNoFu = facts.filter(function (f) { return f.isQualified && !f.isWon && !f.isLost && !f.nextFollowUpAt; }).length;
  if (hotNoFu) items.push({ severity: "warning", key: "hotNoFollowUp", title: hotNoFu + " qualified lead" + (hotNoFu > 1 ? "s have" : " has") + " no next follow-up date", detail: "Qualified leads without a scheduled next step tend to go cold.", drill: { reached: "qualified", noFollowUp: "1" } });
  const staleDays = s.proposalStaleDays || 5;
  const staleProps = facts.filter(function (f) { return f.isProposal && !f.isWon && !f.isLost && f.lastActivityAt && now - new Date(f.lastActivityAt).getTime() > staleDays * 86400000; }).length;
  if (staleProps) items.push({ severity: "warning", key: "staleProposals", title: staleProps + " proposal" + (staleProps > 1 ? "s have" : " has") + " had no activity for " + staleDays + "+ days", detail: "Follow up before the deal goes cold.", drill: { reached: "proposal", stale: "1" } });
  if (extras && extras.followups && extras.followups.missed) items.push({ severity: "warning", key: "overdue", title: extras.followups.missed + " follow-up" + (extras.followups.missed > 1 ? "s" : "") + " overdue", detail: "Across " + extras.followups.leadsWithMissed + " open leads.", drill: { overdue: "1" } });
  const lostNoReason = facts.filter(function (f) { return f.lostReasonMissing; }).length;
  if (lostNoReason) items.push({ severity: "info", key: "lostReason", title: lostNoReason + " lost lead" + (lostNoReason > 1 ? "s have" : " has") + " no lost reason", detail: "Without reasons, the dashboard can't explain WHY leads are poor.", drill: { lostNoReason: "1" } });
  const won = facts.filter(function (f) { return f.isWon; });
  if (won.length && !won.some(function (f) { return f.revenueType === "actual"; }) && !(s.defaultDealValue > 0)) items.push({ severity: "info", key: "revenue", title: "Revenue tracking not configured", detail: won.length + " won lead(s) have no deal value — ROAS and CAC payback can't be measured. Add deal values or a default deal value in Settings.", tab: "health" });
  (ctx.metaData.accounts || []).forEach(function (a) { if (!a.ok) items.push({ severity: "critical", key: "metaApi", title: "Meta ad account " + a.acct + (a.tokenExpired ? ": token expired" : ": API error"), detail: a.error, tab: "health" }); });
  if (ctx.googleData.reauth) items.push({ severity: "critical", key: "googleApi", title: "Google Ads needs to be reconnected", detail: ctx.googleData.error, tab: "health" });
  const order = { critical: 0, warning: 1, info: 2 };
  return items.sort(function (a, b) { return order[a.severity] - order[b.severity]; });
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINT BUILDERS
// ═════════════════════════════════════════════════════════════════════════════
async function overview({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  const facts = applyFilters(ctx.facts, query);
  const spend = spendFor(ctx, query);
  const paidDenom = (!query.channel || query.channel === "all") && !query.campaign ? facts.filter(function (f) { return f.paid; }).length : null;
  const cur = agg(facts), curR = ratios(cur, spend, paidDenom);

  const cmp = F.compareRange(ctx.range, query.compare || "previous", query.cmpFrom, query.cmpTo);
  let prev = null, prevR = null;
  if (cmp) {
    const pctx = await getContext({ company: company, query: Object.assign({}, query, { from: cmp.since, to: cmp.until }), leadScope: leadScope, refresh: refresh });
    const pf = applyFilters(pctx.facts, query);
    const ps = spendFor(pctx, query);
    prev = agg(pf);
    prevR = ratios(prev, ps, paidDenom == null ? null : pf.filter(function (f) { return f.paid; }).length);
  }
  const P = function (k, src) { return src ? src[k] : null; };
  const leadsDenom = paidDenom == null ? cur.leads : paidDenom;
  const business = [
    metric("spend", r2(spend), P("spend", prevR), "Meta " + money(ctx.metaData.totals.spend) + " + Google " + money(ctx.googleData.totals.spend) + (ctx.googleData.source === "manual" ? " (Google = manual lifetime figure, not date-filtered)" : ""), { drill: { tab: "paid" }, warning: ctx.googleData.source === "manual" && ctx.googleData.totals.spend > 0 ? "Google spend is a manually-entered lifetime total" : "" }),
    metric("leads", cur.leads, P("leads", prev), cur.paidLeads + " from paid channels", { drill: {} }),
    metric("qualified", cur.qualified, P("qualified", prev), "", { drill: { reached: "qualified" } }),
    metric("opportunities", cur.opportunities, P("opportunities", prev), "", { drill: { reached: "meeting" } }),
    metric("won", cur.won, P("won", prev), "", { drill: { reached: "won" } }),
    metric("revenue", cur.revenue, P("revenue", prev), cur.revenueEstimated > 0 ? money(cur.revenueEstimated) + " estimated from default deal value" : "", { estimated: cur.revenueEstimated > 0, drill: { reached: "won" } }),
    metric("roas", curR.roas, P("roas", prevR), curR.roas != null ? money(cur.revenue) + " ÷ " + money(spend) : ""),
  ];
  const efficiency = [
    metric("cpl", curR.cpl, P("cpl", prevR), curR.cpl != null ? money(spend) + " ÷ " + leadsDenom : ""),
    metric("qualRate", curR.qualRate, P("qualRate", prevR), cur.qualified + " ÷ " + cur.leads),
    metric("cpql", curR.cpql, P("cpql", prevR), curR.cpql != null ? money(spend) + " ÷ " + cur.qualified : ""),
    metric("oppRate", curR.oppRate, P("oppRate", prevR), cur.opportunities + " ÷ " + cur.qualified),
    metric("costPerOpp", curR.costPerOpp, P("costPerOpp", prevR), curR.costPerOpp != null ? money(spend) + " ÷ " + cur.opportunities : ""),
    metric("cac", curR.cac, P("cac", prevR), curR.cac != null ? money(spend) + " ÷ " + cur.won : ""),
    metric("leadToWon", curR.leadToWon, P("leadToWon", prevR), cur.won + " ÷ " + cur.leads),
  ];

  // Channel performance
  const chGroups = groupBy(facts, function (f) { return f.channel; });
  const chKeys = new Set(Array.from(chGroups.keys()));
  if (ctx.metaData.totals.spend > 0 && (!query.channel || query.channel === "all" || query.channel === "paid" || query.channel === "meta")) chKeys.add("meta");
  if (ctx.googleData.totals.spend > 0 && (!query.channel || query.channel === "all" || query.channel === "paid" || query.channel === "google")) chKeys.add("google");
  const channels = Array.from(chKeys).map(function (ch) {
    const sp = query.campaign ? 0 : (ch === "meta" ? ctx.metaData.totals.spend : ch === "google" ? ctx.googleData.totals.spend : 0);
    const r = row({ channel: ch, paid: !!F.PAID[ch] }, chGroups.get(ch) || [], sp);
    if (ch === "meta") r.platformLeads = ctx.metaData.totals.platformLeads || 0;
    if (ch === "google") r.platformLeads = ctx.googleData.totals.platformConversions || 0;
    return r;
  }).sort(function (a, b) { return b.spend - a.spend || b.leads - a.leads; });

  const camps = campaignRows(ctx, facts).filter(function (c) { return c.spend > 0; });
  const withQ = camps.filter(function (c) { return c.qualified > 0; }).sort(function (a, b) { return a.cpql - b.cpql; });
  const noQ = camps.filter(function (c) { return c.qualified === 0; }).sort(function (a, b) { return b.spend - a.spend; });
  const top = withQ.slice(0, 5);
  const bottom = noQ.concat(withQ.slice().reverse()).filter(function (c) { return top.indexOf(c) < 0; }).slice(0, 5);

  const names = await userNames(company);
  const fu = await followUps(company, leadScope, ctx.cust, query.salesperson);
  const creatives = scoreCreatives(ctx, facts);
  const fatigued = creatives.ads.filter(function (a) { return a.fatigue; }).length;

  return {
    range: { from: ctx.range.since, to: ctx.range.until, days: ctx.range.days },
    compareRange: cmp ? { from: cmp.since, to: cmp.until, mode: query.compare || "previous" } : null,
    business: business, efficiency: efficiency,
    actionCenter: actionCenter(ctx, facts, { fatigued: fatigued, followups: fu }),
    channels: channels,
    funnel: funnel(facts),
    trend: trend(ctx, facts, query),
    topCampaigns: top, bottomCampaigns: bottom,
    salesExec: salesExec(facts, names.map),
    followups: fu,
    response: responseStats(facts, ctx.settings.slaFirstContactMinutes),
    sync: syncInfo(ctx),
    filters: filterOptions(ctx, names.list),
  };
}

function syncInfo(ctx) {
  return {
    metaFetchedAt: ctx.metaData.fetchedAt || null,
    googleFetchedAt: ctx.googleData.fetchedAt || null,
    googleSource: ctx.googleData.source,
    googleLastSyncedAt: ctx.googleData.lastSyncedAt || null,
    builtAt: new Date().toISOString(),
  };
}

// Meta: Campaign → Ad Set → Ad hierarchy with platform + CRM metrics.
async function meta({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  const md = ctx.metaData;
  const facts = applyFilters(ctx.facts, Object.assign({}, query, { channel: "meta" }));
  const byCamp = groupBy(facts, function (f) { return f.meta && f.meta.campaignId; });
  const byAdset = groupBy(facts, function (f) { return f.meta && f.meta.adsetId; });
  const byAd = groupBy(facts, function (f) { return f.meta && f.meta.adId; });

  const build = function (obj, fs) {
    const r = row({ id: obj.id, name: obj.name, status: obj.status || "" }, fs, obj.metrics ? obj.metrics.spend : 0);
    const m = obj.metrics || {};
    ["reach", "impressions", "frequency", "cpm", "linkClicks", "linkCtr", "ctr", "cpc", "lpv", "platformLeads"].forEach(function (k) { r[k] = m[k] == null ? null : m[k]; });
    r.lpvRate = pctOf(m.lpv || 0, m.linkClicks || 0);
    r.lpvToLead = m.lpv > 0 ? pctOf(r.leads, m.lpv) : null;
    return r;
  };

  const campaignsList = (md.campaigns || []).concat((md.idleCampaigns || []).map(function (c) { return { id: c.id, name: c.name, status: c.status, metrics: null }; }));
  const knownCampIds = new Set(campaignsList.map(function (c) { return c.id; }));
  byCamp.forEach(function (fs, cid) { if (!knownCampIds.has(cid)) campaignsList.push({ id: cid, name: (fs[0] && fs[0].campaignLabel) || ("Campaign " + cid), status: "", metrics: null, notInPlatform: true }); });

  const campaigns = campaignsList.map(function (c) {
    const adsets = (md.adsets || []).filter(function (a) { return a.campaignId === c.id; });
    const knownSet = new Set(adsets.map(function (a) { return a.id; }));
    (byCamp.get(c.id) || []).forEach(function (f) { if (f.meta.adsetId && !knownSet.has(f.meta.adsetId)) { knownSet.add(f.meta.adsetId); adsets.push({ id: f.meta.adsetId, name: f.adSetName || ("Ad set " + f.meta.adsetId), status: "", campaignId: c.id, metrics: null }); } });
    const cr = build(c, byCamp.get(c.id) || []);
    cr.objective = c.objective || "";
    cr.adsets = adsets.map(function (a) {
      const ar = build(a, byAdset.get(a.id) || []);
      const cfg = ctx.metaConfigs.find(function (x) { return String(x.metaAdsetId) === a.id; });
      ar.configId = cfg ? String(cfg._id) : null;
      ar.ads = (md.ads || []).filter(function (ad) { return ad.adsetId === a.id; }).map(function (ad) {
        const r = build(ad, byAd.get(ad.id) || []);
        r.creative = ad.creative;
        return r;
      }).sort(function (x, y) { return y.spend - x.spend; });
      const adLeadSum = ar.ads.reduce(function (t, x) { return t + x.leads; }, 0);
      ar.leadsWithoutAdId = Math.max(0, ar.leads - adLeadSum);
      return ar;
    }).sort(function (x, y) { return y.spend - x.spend || y.leads - x.leads; });
    const setLeadSum = cr.adsets.reduce(function (t, x) { return t + x.leads; }, 0);
    cr.leadsWithoutAdsetId = Math.max(0, cr.leads - setLeadSum);
    return cr;
  }).filter(function (c) { return c.spend > 0 || c.leads > 0 || query.showIdle === "1"; })
    .sort(function (a, b) { return b.spend - a.spend || b.leads - a.leads; });

  const unattributed = facts.filter(function (f) { return !f.meta || !f.meta.campaignId; });
  const totalsAgg = agg(facts);
  const t = Object.assign({}, md.totals || {}, totalsAgg, ratios(totalsAgg, (md.totals && md.totals.spend) || 0));
  const statusCount = function (list) { const m = {}; list.forEach(function (c) { const s = c.status || "UNKNOWN"; m[s] = (m[s] || 0) + 1; }); return m; };
  const allCamps = (md.campaigns || []).concat(md.idleCampaigns || []);

  return {
    range: { from: ctx.range.since, to: ctx.range.until },
    configured: md.configured, accounts: md.accounts, totals: t,
    counts: {
      campaignsWithDelivery: (md.campaigns || []).length,
      campaignsOnAccount: allCamps.length,
      campaignsActive: allCamps.filter(function (c) { return c.status === "ACTIVE"; }).length,
      campaignsShown: campaigns.length,
      adsetsWithDelivery: (md.adsets || []).length,
      adsWithDelivery: (md.ads || []).length,
      adsActive: (md.ads || []).filter(function (a) { return a.status === "ACTIVE"; }).length,
      statusBreakdown: statusCount(allCamps),
    },
    leadReconciliation: {
      platformLeads: (md.totals && md.totals.platformLeads) || 0,
      crmLeads: facts.length,
      attributedById: facts.filter(function (f) { return f.attributionMethod === "id" || f.attributionMethod === "config"; }).length,
      attributedByName: facts.filter(function (f) { return f.attributionMethod === "name"; }).length,
      unattributed: unattributed.length,
    },
    campaigns: campaigns,
    sync: syncInfo(ctx),
  };
}

// Google: campaigns, ad groups, keywords, search terms, ads, devices, locations, landing pages.
async function google({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh, includeGclid: true });
  const gd = ctx.googleData;
  const facts = applyFilters(ctx.facts, Object.assign({}, query, { channel: "google" }));
  const byCamp = groupBy(facts, function (f) { return f.google && f.google.campaignId; });
  const byAg = groupBy(facts, function (f) { return f.google && f.google.adGroupId; });
  const byKw = groupBy(facts, function (f) { return f.google && f.google.keyword ? f.google.adGroupId + "|" + String(f.google.keyword).toLowerCase() : ""; });
  const bySt = groupBy(facts, function (f) { return f.attribution && f.attribution.searchTerm ? String(f.attribution.searchTerm).toLowerCase() : ""; });

  const plat = function (m) { return { impressions: m.impressions, clicks: m.clicks, ctr: m.ctr, cpc: m.cpc, cpm: m.cpm, platformConversions: m.platformConversions }; };
  const campaigns = gd.campaigns.map(function (c) {
    const fs = c.id ? (byCamp.get(c.id) || []) : facts.filter(function (f) { return String(f.campaign).toLowerCase() === String(c.name).toLowerCase(); });
    return Object.assign(row({ id: c.id, name: c.name, status: c.status, type: c.type }, fs, c.metrics.spend), plat(c.metrics));
  });
  const knownIds = new Set(gd.campaigns.map(function (c) { return c.id; }));
  byCamp.forEach(function (fs, id) { if (!knownIds.has(id)) campaigns.push(row({ id: id, name: (fs[0] && fs[0].campaignLabel) || id, status: "", notInPlatform: true }, fs, 0)); });
  const unattributed = facts.filter(function (f) { return !f.google || !f.google.campaignId; });

  const adGroups = gd.adGroups.map(function (g) { return Object.assign(row({ id: g.id, name: g.name, status: g.status, campaignId: g.campaignId }, byAg.get(g.id) || [], g.metrics.spend), plat(g.metrics)); });
  const keywords = gd.keywords.map(function (k) {
    return Object.assign(row({ id: k.id, text: k.text, matchType: k.matchType, status: k.status, adGroupId: k.adGroupId, campaignId: k.campaignId }, byKw.get(k.adGroupId + "|" + String(k.text).toLowerCase()) || [], k.metrics.spend), plat(k.metrics));
  });
  const searchTerms = gd.searchTerms.map(function (t) {
    const fs = bySt.get(String(t.term).toLowerCase()) || [];
    const r = Object.assign(row({ term: t.term, status: t.status, keyword: t.keyword, adGroupId: t.adGroupId, campaignId: t.campaignId }, fs, t.metrics.spend), plat(t.metrics));
    r.crmJoined = fs.length > 0;
    const m = t.metrics;
    if (m.spend >= 200 && m.platformConversions === 0) r.flag = "negative-candidate";
    else if (m.platformConversions > 0 && (m.spend / m.platformConversions) <= (gd.totals.spend / Math.max(1, gd.totals.platformConversions))) r.flag = "high-intent";
    else if (m.spend > 0 && m.platformConversions === 0) r.flag = "investigate";
    return r;
  });

  const aGoogle = agg(facts);
  return {
    range: { from: ctx.range.since, to: ctx.range.until },
    source: gd.source, connected: gd.connected, account: gd.account, error: gd.error || null, reauth: !!gd.reauth, apiErrors: gd.errors || {},
    totals: Object.assign({}, gd.totals, aGoogle, ratios(aGoogle, gd.totals.spend)),
    campaigns: campaigns.sort(function (a, b) { return b.spend - a.spend || b.leads - a.leads; }),
    adGroups: adGroups, keywords: keywords, searchTerms: searchTerms,
    ads: gd.ads.map(function (a) { return Object.assign({ id: a.id, name: a.name, status: a.status, type: a.type, adGroupId: a.adGroupId, campaignId: a.campaignId, creative: a.creative, spend: a.metrics.spend }, plat(a.metrics)); }),
    devices: gd.devices, locations: gd.locations,
    landingPages: gd.landingPages.map(function (p) { return Object.assign({ url: p.url, spend: p.metrics.spend }, plat(p.metrics)); }),
    attribution: {
      crmLeads: facts.length, unattributed: unattributed.length,
      withGclid: facts.filter(function (f) { return f.attribution && f.attribution.gclid; }).length,
      gclidResolved: facts.filter(function (f) { return f.google && f.google.gclidResolved; }).length,
      byKeyword: facts.filter(function (f) { return f.google && f.google.keyword; }).length,
    },
    sync: syncInfo(ctx),
  };
}

async function creatives({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  const facts = applyFilters(ctx.facts, query);
  const res = scoreCreatives(ctx, facts);
  const counts = { Good: 0, Fair: 0, "Needs Attention": 0, Learning: 0 };
  res.ads.forEach(function (a) { counts[a.rating] = (counts[a.rating] || 0) + 1; });
  return {
    range: { from: ctx.range.since, to: ctx.range.until },
    thresholds: { minImpressions: ctx.settings.creativeMinImpressions, minSpend: ctx.settings.creativeMinSpend, minClicks: ctx.settings.creativeMinClicks, minLeads: ctx.settings.creativeMinLeads, fatigueFrequency: ctx.settings.fatigueFrequency },
    counts: counts, fatigued: res.ads.filter(function (a) { return a.fatigue; }).length,
    adLevelAttribution: res.adLevelAttribution,
    ads: res.ads.sort(function (a, b) { return b.metrics.spend - a.metrics.spend; }),
    sync: syncInfo(ctx),
  };
}

async function pipeline({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  const facts = applyFilters(ctx.facts, query);
  const names = await userNames(company);

  const statusMap = {};
  facts.forEach(function (f) {
    const k = f.status || "(blank)";
    if (!statusMap[k]) statusMap[k] = { status: k, label: f.statusLabel, category: f.statusCategory, count: 0 };
    statusMap[k].count++;
  });
  const statuses = Object.keys(statusMap).map(function (k) { return statusMap[k]; }).sort(function (a, b) { return b.count - a.count; });

  const camps = campaignRows(ctx, facts).filter(function (c) { return c.leads > 0 || c.spend > 0; }).sort(function (a, b) { return b.leads - a.leads; });

  const lost = facts.filter(function (f) { return f.isLost; });
  const reasonCount = function (fs) {
    const m = {};
    fs.forEach(function (f) { const r = f.lostReason || "Not specified"; m[r] = (m[r] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { reason: k, count: m[k], pct: pctOf(m[k], fs.length) }; }).sort(function (a, b) { return b.count - a.count; });
  };
  const lostByCampaign = [];
  groupBy(lost, function (f) { return f.campaignKey; }).forEach(function (fs, k) {
    const name = (camps.find(function (c) { return c.key === k; }) || {}).name || (fs[0] && fs[0].campaignLabel) || k;
    lostByCampaign.push({ key: k, name: name, lost: fs.length, reasons: reasonCount(fs) });
  });
  lostByCampaign.sort(function (a, b) { return b.lost - a.lost; });

  const byChannelResp = [];
  groupBy(facts, function (f) { return f.channel; }).forEach(function (fs, ch) { byChannelResp.push(Object.assign({ channel: ch }, responseStats(fs, ctx.settings.slaFirstContactMinutes))); });
  const buckets = [["≤5 min", 0, 5], ["5–15 min", 6, 15], ["15–60 min", 16, 60], ["1–4 h", 61, 240], ["4–24 h", 241, 1440], [">24 h", 1441, Infinity]].map(function (b) {
    return { label: b[0], count: facts.filter(function (f) { return f.responseMin != null && f.responseMin >= b[1] && f.responseMin <= b[2]; }).length };
  });
  buckets.push({ label: "No contact logged", count: facts.filter(function (f) { return f.responseMin == null; }).length });

  const fu = await followUps(company, leadScope, ctx.cust, query.salesperson);
  const now = Date.now();
  const sla = ctx.settings.slaFirstContactMinutes || 60;
  const slaAlerts = [
    { key: "uncontacted", label: "New leads not contacted (> " + sla + " min)", count: facts.filter(function (f) { return !f.attempted && !f.isLost && !f.isWon && now - new Date(f.createdAt).getTime() > sla * 60000; }).length, drill: { uncontacted: "1" } },
    { key: "overdue", label: "Follow-ups overdue (all open leads)", count: fu.missed, drill: { overdue: "1" } },
    { key: "hotNoFollowUp", label: "Qualified leads with no next follow-up", count: facts.filter(function (f) { return f.isQualified && !f.isWon && !f.isLost && !f.nextFollowUpAt; }).length, drill: { reached: "qualified", noFollowUp: "1" } },
    { key: "staleProposals", label: "Proposals with no activity for " + ctx.settings.proposalStaleDays + "+ days", count: facts.filter(function (f) { return f.isProposal && !f.isWon && !f.isLost && f.lastActivityAt && now - new Date(f.lastActivityAt).getTime() > ctx.settings.proposalStaleDays * 86400000; }).length, drill: { reached: "proposal", stale: "1" } },
  ];

  return {
    range: { from: ctx.range.since, to: ctx.range.until },
    totals: agg(facts),
    funnel: funnel(facts),
    stageSkips: facts.filter(function (f) { return f.stageSkip; }).length,
    statuses: statuses,
    campaignQuality: camps,
    lostReasons: reasonCount(lost), lostByCampaign: lostByCampaign.slice(0, 15), lostReasonTaxonomy: LOST_REASONS,
    response: Object.assign(responseStats(facts, sla), { buckets: buckets, byChannel: byChannelResp, slaMinutes: sla }),
    salesExec: salesExec(facts, names.map),
    followups: fu, slaAlerts: slaAlerts,
    sync: syncInfo(ctx),
  };
}

// Cross-channel drill-down report.
// level: channel | campaign | adset | ad | adGroup | keyword
async function report({ company, query, leadScope, refresh }) {
  const level = query.level || "channel";
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh, includeGclid: level === "keyword" || level === "adGroup" });
  let facts = applyFilters(ctx.facts, Object.assign({}, query, { campaign: level === "campaign" ? "" : query.campaign }));
  const rows = [];
  if (level === "channel") {
    const g = groupBy(facts, function (f) { return f.channel; });
    const keys = new Set(Array.from(g.keys()));
    if (ctx.metaData.totals.spend > 0) keys.add("meta");
    if (ctx.googleData.totals.spend > 0) keys.add("google");
    keys.forEach(function (ch) {
      rows.push(row({ key: ch, name: ch, channel: ch, next: "campaign" }, g.get(ch) || [], ch === "meta" ? ctx.metaData.totals.spend : ch === "google" ? ctx.googleData.totals.spend : 0));
    });
  } else if (level === "campaign") {
    campaignRows(ctx, facts).forEach(function (c) {
      if (query.channel && c.channel !== query.channel) return;
      c.next = c.channel === "meta" && c.platformId ? "adset" : c.channel === "google" && c.platformId ? "adGroup" : "leads";
      rows.push(c);
    });
  } else if (level === "adset") {
    const cid = String(query.campaign || "").replace("meta:", "");
    facts = facts.filter(function (f) { return f.meta && f.meta.campaignId === cid; });
    const g = groupBy(facts, function (f) { return f.meta.adsetId || "(no ad set id)"; });
    const sets = (ctx.metaData.adsets || []).filter(function (a) { return a.campaignId === cid; });
    const seen = {};
    sets.forEach(function (a) { seen[a.id] = 1; rows.push(row({ key: a.id, name: a.name, status: a.status, next: "ad" }, g.get(a.id) || [], a.metrics.spend)); });
    g.forEach(function (fs, k) { if (!seen[k]) rows.push(row({ key: k, name: k === "(no ad set id)" ? "Leads without ad-set ID" : ((fs[0] && fs[0].adSetName) || k), next: "leads" }, fs, 0)); });
  } else if (level === "ad") {
    const sid = String(query.adset || "");
    facts = facts.filter(function (f) { return f.meta && f.meta.adsetId === sid; });
    const g = groupBy(facts, function (f) { return f.meta.adId || "(no ad id)"; });
    const seen = {};
    (ctx.metaData.ads || []).filter(function (a) { return a.adsetId === sid; }).forEach(function (a) { seen[a.id] = 1; rows.push(row({ key: a.id, name: a.name, status: a.status, next: "leads" }, g.get(a.id) || [], a.metrics.spend)); });
    g.forEach(function (fs, k) { if (!seen[k]) rows.push(row({ key: k, name: k === "(no ad id)" ? "Leads without ad ID (attributed at ad-set level)" : k, next: "leads" }, fs, 0)); });
  } else if (level === "adGroup") {
    const cid = String(query.campaign || "").replace("google:", "");
    facts = facts.filter(function (f) { return f.google && f.google.campaignId === cid; });
    const g = groupBy(facts, function (f) { return f.google.adGroupId || "(no ad group)"; });
    const seen = {};
    (ctx.googleData.adGroups || []).filter(function (a) { return a.campaignId === cid; }).forEach(function (a) { seen[a.id] = 1; rows.push(row({ key: a.id, name: a.name, status: a.status, next: "keyword" }, g.get(a.id) || [], a.metrics.spend)); });
    g.forEach(function (fs, k) { if (!seen[k]) rows.push(row({ key: k, name: k === "(no ad group)" ? "Leads without ad-group (no gclid match)" : k, next: "leads" }, fs, 0)); });
  } else if (level === "keyword") {
    const ag = String(query.adGroup || "");
    facts = facts.filter(function (f) { return f.google && f.google.adGroupId === ag; });
    const g = groupBy(facts, function (f) { return String(f.google.keyword || "(unknown keyword)").toLowerCase(); });
    const seen = {};
    (ctx.googleData.keywords || []).filter(function (k) { return k.adGroupId === ag; }).forEach(function (k) { const key = String(k.text).toLowerCase(); seen[key] = 1; rows.push(row({ key: key, name: k.text + " [" + String(k.matchType || "").toLowerCase() + "]", status: k.status, next: "leads" }, g.get(key) || [], k.metrics.spend)); });
    g.forEach(function (fs, k) { if (!seen[k]) rows.push(row({ key: k, name: k, next: "leads" }, fs, 0)); });
  }
  rows.sort(function (a, b) { return b.spend - a.spend || b.leads - a.leads; });
  const t = agg(facts);
  return { level: level, range: { from: ctx.range.since, to: ctx.range.until }, rows: rows, totals: Object.assign(t, ratios(t, rows.reduce(function (s, r) { return s + (r.spend || 0); }, 0))), sync: syncInfo(ctx) };
}

// Drill-down: "where did this number come from?"
async function leads({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  let facts = applyFilters(ctx.facts, query);
  const q = query;
  const now = Date.now();
  if (q.reached && F.STAGE_ORDER[q.reached] != null) facts = facts.filter(function (f) { return f.reached >= F.STAGE_ORDER[q.reached] && (q.reached !== "won" || f.isWon); });
  if (q.stage) facts = facts.filter(function (f) { return f.stage === q.stage; });
  if (q.statusCategory) facts = facts.filter(function (f) { return f.statusCategory === q.statusCategory; });
  if (q.uncontacted === "1") facts = facts.filter(function (f) { return !f.attempted && !f.isLost && !f.isWon; });
  if (q.lost === "1") facts = facts.filter(function (f) { return f.isLost; });
  if (q.lostReason) facts = facts.filter(function (f) { return (f.lostReason || "Not specified") === q.lostReason; });
  if (q.lostNoReason === "1") facts = facts.filter(function (f) { return f.lostReasonMissing; });
  if (q.noFollowUp === "1") facts = facts.filter(function (f) { return !f.nextFollowUpAt && !f.isWon && !f.isLost; });
  if (q.overdue === "1") facts = facts.filter(function (f) { return f.overdueFollowUps > 0; });
  if (q.stale === "1") facts = facts.filter(function (f) { return f.lastActivityAt && now - new Date(f.lastActivityAt).getTime() > ctx.settings.proposalStaleDays * 86400000 && !f.isWon && !f.isLost; });
  if (q.metaCampaignId) facts = facts.filter(function (f) { return f.meta && f.meta.campaignId === q.metaCampaignId; });
  if (q.metaAdsetId) facts = facts.filter(function (f) { return f.meta && f.meta.adsetId === q.metaAdsetId; });
  if (q.metaAdId) facts = facts.filter(function (f) { return f.meta && f.meta.adId === q.metaAdId; });
  if (q.googleCampaignId) facts = facts.filter(function (f) { return f.google && f.google.campaignId === q.googleCampaignId; });
  if (q.googleAdGroupId) facts = facts.filter(function (f) { return f.google && f.google.adGroupId === q.googleAdGroupId; });
  if (q.keyword) facts = facts.filter(function (f) { return f.google && String(f.google.keyword).toLowerCase() === String(q.keyword).toLowerCase(); });
  if (q.user) facts = facts.filter(function (f) { return (f.user || "unassigned") === q.user; });
  if (q.unattributed === "1") facts = facts.filter(function (f) { return f.attributionMethod === "none"; });
  if (q.nameMatched === "1") facts = facts.filter(function (f) { return f.attributionMethod === "name"; });
  if (q.wonNoValue === "1") facts = facts.filter(function (f) { return f.isWon && f.revenueType !== "actual"; });
  if (q.stageSkip === "1") facts = facts.filter(function (f) { return f.stageSkip; });
  if (q.search) { const s = String(q.search).toLowerCase(); facts = facts.filter(function (f) { return f.name.toLowerCase().indexOf(s) >= 0 || String(f.mobile).indexOf(s) >= 0 || f.campaign.toLowerCase().indexOf(s) >= 0; }); }

  const names = await userNames(company);
  const limit = Math.min(1000, Number(q.limit) || 500);
  facts.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return {
    total: facts.length, summary: agg(facts),
    leads: facts.slice(0, limit).map(function (f) {
      return {
        _id: f._id, name: f.name, mobile: f.mobile, channel: f.channel, source: f.source, campaign: f.campaignLabel, adSet: f.adSetName,
        status: f.status, statusLabel: f.statusLabel, statusCategory: f.statusCategory, stage: f.stage, reached: f.reached,
        temperature: f.temperature, salesperson: f.user ? (names.map[f.user] || "Unknown") : "Unassigned",
        createdAt: f.createdAt, responseMin: f.responseMin, callCount: f.callCount, lastOutcome: f.lastOutcome,
        nextFollowUpAt: f.nextFollowUpAt, lostReason: f.lostReason, dealValue: f.dealValue, revenue: f.revenue, revenueType: f.revenueType,
        attributionMethod: f.attributionMethod, metaAdId: f.meta ? f.meta.adId : "", keyword: f.google ? f.google.keyword : "",
      };
    }),
  };
}

// Data Health + automatic reconciliation.
async function dataHealth({ company, query, leadScope, refresh }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope, refresh: refresh, includeGclid: true });
  const facts = ctx.facts;
  const md = ctx.metaData, gd = ctx.googleData;
  const ago = function (d) { return d ? new Date(d).toISOString() : null; };
  const LinkedInConfig = require("../../models/LinkedInConfig");
  const WebsiteConfig = require("../../models/WebsiteConfig");
  let ga4 = null;
  try { ga4 = await require("../../models/GoogleAnalyticsConfig").findOne({ company: company }).select("connected propertyId propertyName connectedAt").lean(); } catch (e) { ga4 = null; }
  const [liCount, webCfgs] = await Promise.all([
    LinkedInConfig.countDocuments({ company: company }).catch(function () { return 0; }),
    WebsiteConfig.find({ company: company }).select("sourceName isActive").lean().catch(function () { return []; }),
  ]);

  const metaFacts = facts.filter(function (f) { return f.channel === "meta"; });
  const googleFacts = facts.filter(function (f) { return f.channel === "google"; });
  const webFacts = facts.filter(function (f) { return f.channel === "website"; });
  const allWebish = facts.filter(function (f) { return /website|web form/i.test(f.source); });
  const withUtm = allWebish.filter(function (f) { return f.attribution && (f.attribution.utmSource || f.attribution.gclid || f.attribution.fbclid); }).length;

  const integrations = [];
  if (!(md.accounts || []).length) integrations.push({ name: "Meta Ads", status: "Not connected", tone: "warn", lastSync: null, records: "—", issue: "Add an Ad Account ID + ads_read token to a Meta campaign config." });
  (md.accounts || []).forEach(function (a) {
    integrations.push({ name: "Meta Ads · " + a.acct, status: a.ok ? "Connected" : (a.tokenExpired ? "Token expired" : "Error"), tone: a.ok ? "ok" : "error", lastSync: ago(md.fetchedAt), records: a.campaigns + " campaigns · " + a.ads + " ads with delivery", issue: a.ok ? "" : a.error });
  });
  const cfgNoAdset = ctx.metaConfigs.filter(function (c) { return !c.metaAdsetId; }).length;
  const metaName = metaFacts.filter(function (f) { return f.attributionMethod === "name"; }).length;
  const metaNone = metaFacts.filter(function (f) { return f.attributionMethod === "none"; }).length;
  const metaIssues = [];
  if (metaNone) metaIssues.push(metaNone + " leads with no campaign/ad-set ID");
  if (metaName) metaIssues.push(metaName + " leads matched by NAME only");
  if (cfgNoAdset) metaIssues.push(cfgNoAdset + " lead-form configs without a Meta ad-set ID (run Sync Meta)");
  integrations.push({ name: "Meta Lead Forms", status: metaIssues.length ? "Warning" : (ctx.metaConfigs.length ? "Connected" : "Not configured"), tone: metaIssues.length ? "warn" : (ctx.metaConfigs.length ? "ok" : "warn"), lastSync: null, records: metaFacts.length + " CRM leads · " + ctx.metaConfigs.length + " configs", issue: metaIssues.join(" · ") });

  integrations.push({
    name: "Google Ads", tone: gd.source === "api" ? (gd.error ? "error" : "ok") : gd.source === "manual" ? "warn" : "warn",
    status: gd.source === "api" ? (gd.error ? "Error" : "Connected (API)") : gd.reauth ? "Reconnect required" : gd.source === "manual" ? "Manual numbers" : "Not connected",
    lastSync: ago(gd.source === "api" ? gd.fetchedAt : gd.lastSyncedAt), records: gd.campaigns.length + " campaigns",
    issue: gd.error || (gd.source === "manual" ? "Spend/clicks are manually-entered lifetime totals — NOT filtered by date. Connect the Google Ads API for accurate CPL/CPQL." : gd.source === "none" ? "Connect Google Ads in CRM → Integrations." : Object.keys(gd.errors || {}).length ? "Partial: " + Object.keys(gd.errors).join(", ") + " unavailable" : ""),
  });
  const gNone = googleFacts.filter(function (f) { return !f.google || !f.google.campaignId; }).length;
  const gGclid = googleFacts.filter(function (f) { return f.attribution && f.attribution.gclid; }).length;
  integrations.push({ name: "Google Attribution", status: gNone ? "Warning" : "OK", tone: gNone ? "warn" : "ok", lastSync: null, records: googleFacts.length + " CRM leads · " + gGclid + " with GCLID", issue: gNone ? gNone + " Google leads missing campaign mapping" : "" });
  integrations.push({ name: "GA4", status: ga4 && ga4.connected ? "Connected" : "Not connected", tone: ga4 && ga4.connected ? "ok" : "warn", lastSync: ga4 && ga4.connectedAt ? ago(ga4.connectedAt) : null, records: ga4 && ga4.propertyName ? ga4.propertyName : "—", issue: ga4 && ga4.connected ? "" : "Connect GA4 for sessions / engagement on landing pages." });
  integrations.push({ name: "Website tracking", status: webCfgs.length ? (allWebish.length && withUtm < allWebish.length * 0.5 ? "Warning" : "Connected") : "Not configured", tone: webCfgs.length ? (allWebish.length && withUtm < allWebish.length * 0.5 ? "warn" : "ok") : "warn", lastSync: null, records: allWebish.length + " website leads · " + webCfgs.length + " forms", issue: allWebish.length ? (allWebish.length - withUtm) + " website leads without UTM / click-id — add hidden utm_* and gclid fields to the form." : "" });
  integrations.push({ name: "LinkedIn Ads", status: liCount ? "Lead forms connected" : "Not configured", tone: liCount ? "ok" : "neutral", lastSync: null, records: liCount + " configs", issue: liCount ? "Spend not imported — LinkedIn CPL/CPQL unavailable." : "" });
  const unmapped = facts.filter(function (f) { return f.statusCategory === "unmapped"; });
  integrations.push({ name: "CRM", status: unmapped.length ? "Warning" : "Connected", tone: unmapped.length ? "warn" : "ok", lastSync: new Date().toISOString(), records: facts.length + " leads in range", issue: unmapped.length ? unmapped.length + " leads with statuses not in Customize CRM: " + Array.from(new Set(unmapped.map(function (f) { return f.status || "(blank)"; }))).slice(0, 5).join(", ") : "" });
  const won = facts.filter(function (f) { return f.isWon; });
  const wonActual = won.filter(function (f) { return f.revenueType === "actual"; }).length;
  integrations.push({ name: "Revenue tracking", status: !won.length ? "No wins in range" : wonActual === won.length ? "Complete" : (wonActual || ctx.settings.defaultDealValue ? "Partial" : "Not configured"), tone: !won.length ? "neutral" : wonActual === won.length ? "ok" : "warn", lastSync: null, records: wonActual + "/" + won.length + " won leads with deal value", issue: won.length > wonActual ? (won.length - wonActual) + " won leads without a deal value" + (ctx.settings.defaultDealValue ? " (estimated at default " + money(ctx.settings.defaultDealValue) + ")" : "") : "" });

  // Reconciliation checks
  const checks = [];
  const add = function (label, a, aLabel, b, bLabel, tol, drill, note) {
    const diff = a - b;
    const ok = Math.abs(diff) <= (tol ? Math.max(1, Math.abs(a) * tol) : 0);
    checks.push({ label: label, left: { label: aLabel, value: a }, right: { label: bLabel, value: b }, diff: diff, ok: ok, drill: drill || null, note: note || "" });
  };
  if (md.configured) add("Meta leads", md.totals.platformLeads || 0, "Meta platform leads", metaFacts.length, "CRM Meta leads", 0.05, null, "Differences = duplicates blocked by phone dedup, test leads, or webhook delivery failures.");
  if (md.configured) add("Meta attribution", metaFacts.length, "CRM Meta leads", metaFacts.filter(function (f) { return f.meta && f.meta.campaignId; }).length, "Mapped to a campaign ID", 0, { channel: "meta", unattributed: "1" });
  add("Google attribution", googleFacts.length, "CRM Google leads", googleFacts.filter(function (f) { return f.google && f.google.campaignId; }).length, "Mapped to a campaign ID", 0, { channel: "google", unattributed: "1" });
  add("Lifecycle status", facts.length, "Total leads", facts.length - unmapped.length, "Status-mapped leads", 0, { statusCategory: "unmapped" });
  add("Stage integrity", won.length, "Won leads", won.length - facts.filter(function (f) { return f.stageSkip; }).length, "Won with qualification evidence", 0, { stageSkip: "1" }, "Won leads with no Hot/Interested/meeting/proposal history skipped qualification — check stage definitions.");
  const chSum = {};
  facts.forEach(function (f) { chSum[f.channel] = (chSum[f.channel] || 0) + 1; });
  add("Channel totals", facts.length, "Total leads", Object.keys(chSum).reduce(function (s, k) { return s + chSum[k]; }, 0), "Σ leads by channel", 0);
  if (md.configured) checks.push({ label: "Meta campaign count", left: { label: "With delivery in range", value: (md.campaigns || []).length }, right: { label: "On ad account", value: (md.campaigns || []).length + (md.idleCampaigns || []).length }, diff: null, ok: true, note: "Paid Media lists campaigns with spend OR CRM leads in the range; idle campaigns are hidden by default." });

  const quality = [
    { label: "Lost leads without a reason", count: facts.filter(function (f) { return f.lostReasonMissing; }).length, drill: { lostNoReason: "1" } },
    { label: "Won leads without deal value", count: won.length - wonActual, drill: { wonNoValue: "1" } },
    { label: "Leads without salesperson", count: facts.filter(function (f) { return !f.user; }).length, drill: { user: "unassigned" } },
    { label: "Meta leads attributed by name only", count: metaName, drill: { nameMatched: "1" } },
  ];

  return { range: { from: ctx.range.since, to: ctx.range.until }, integrations: integrations, checks: checks, quality: quality, settings: ctx.settings, sync: syncInfo(ctx) };
}

// Evidence-based AI analysis: Observation → Evidence → Likely Cause → Action → Priority.
const aiCache = new Map();
async function aiAnalysis({ company, query, leadScope, refresh }) {
  const ov = await overview({ company: company, query: query, leadScope: leadScope, refresh: refresh });
  const cr = await creatives({ company: company, query: query, leadScope: leadScope });
  const key = String(company) + "|" + ov.range.from + "|" + ov.range.to + "|" + (query.channel || "") + "|" + (query.campaign || "");
  const hit = aiCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < 30 * 60000) return Object.assign({ cached: true }, hit.data);

  const fmt = function (m) { return m.label + ": " + (m.value == null ? "n/a" : m.value) + (m.deltaPct != null ? " (" + (m.deltaPct > 0 ? "+" : "") + m.deltaPct + "% vs previous)" : ""); };
  const L = [];
  L.push("Period " + ov.range.from + " to " + ov.range.to + (ov.compareRange ? " (compared with " + ov.compareRange.from + " to " + ov.compareRange.to + ")" : ""));
  L.push("BUSINESS: " + ov.business.map(fmt).join("; "));
  L.push("EFFICIENCY: " + ov.efficiency.map(fmt).join("; "));
  L.push("FUNNEL: " + ov.funnel.map(function (s) { return s.label + " " + s.count + (s.stepRate != null ? " (" + s.stepRate + "% of previous)" : ""); }).join(" → "));
  L.push("CHANNELS: " + ov.channels.map(function (c) { return c.channel + " spend ₹" + c.spend + ", leads " + c.leads + (c.platformLeads != null ? " (platform " + c.platformLeads + ")" : "") + ", qualified " + c.qualified + ", qual% " + c.qualRate + ", CPQL " + c.cpql + ", won " + c.won + ", CAC " + c.cac; }).join(" | "));
  L.push("TOP CAMPAIGNS BY CPQL: " + ov.topCampaigns.map(function (c) { return "\"" + c.name + "\" spend ₹" + c.spend + " leads " + c.leads + " qualified " + c.qualified + " CPQL ₹" + c.cpql; }).join(" | "));
  L.push("WORST CAMPAIGNS: " + ov.bottomCampaigns.map(function (c) { return "\"" + c.name + "\" spend ₹" + c.spend + " leads " + c.leads + " qualified " + c.qualified + " CPQL " + (c.cpql || "n/a"); }).join(" | "));
  const flagged = cr.ads.filter(function (a) { return a.rating === "Needs Attention" || a.fatigue; }).slice(0, 8);
  L.push("CREATIVES NEEDING ATTENTION: " + flagged.map(function (a) { return "\"" + a.name + "\" (" + a.platform + ") spend ₹" + a.metrics.spend + ", link CTR " + a.metrics.linkCtr + "%, CPC " + a.metrics.cpc + ", freq " + (a.metrics.frequency || "n/a") + " — " + a.reasons.map(function (r) { return r.text; }).join(" "); }).join(" | "));
  L.push("RESPONSE TIME: median " + ov.response.medianMin + " min, " + ov.response.pct60 + "% contacted within 1h, " + ov.response.uncontacted + " uncontacted");
  L.push("ACTION CENTER: " + ov.actionCenter.map(function (a) { return a.title; }).join(" | "));
  L.push("DIAGNOSTIC RULES: " + DIAGNOSTIC_RULES.map(function (r) { return r.when + " = " + r.means; }).join("; "));

  const system =
    "You are a senior performance-marketing analyst for an Indian B2B/service business. Analyse ONLY the evidence given. " +
    "Never give generic advice (e.g. 'improve your creatives') — every item must cite specific numbers and names from the evidence. " +
    "Prioritise optimization metrics (qualified leads, CPQL, CAC, revenue, ROAS) over diagnostic ones (CTR, CPM). " +
    "Distinguish advertising problems from landing-page, lead-quality and sales follow-up problems. " +
    "If data is incomplete or doesn't reconcile, say so and recommend NOT shifting budget until fixed. " +
    "Respond in STRICT JSON only: {\"summary\":\"2 sentences\",\"items\":[{\"observation\":\"\",\"evidence\":\"numbers from the data\",\"likelyCause\":\"\",\"action\":\"one concrete next step\",\"priority\":\"High|Medium|Low\",\"area\":\"Campaign|Creative|Landing page|Lead quality|Sales process|Tracking\"}]} with 4–8 items, most important first.";
  const { callGrok } = require("../../utils/leadActionSummary");
  const raw = await callGrok(system, L.join("\n").slice(0, 12000), 1500);
  let parsed;
  try { parsed = JSON.parse(String(raw || "").replace(/```json|```/g, "").trim()); }
  catch (e) { parsed = { summary: String(raw || "").slice(0, 600), items: [] }; }
  const data = { summary: parsed.summary || "", items: Array.isArray(parsed.items) ? parsed.items : [], generatedAt: new Date().toISOString(), range: ov.range };
  aiCache.set(key, { at: Date.now(), data: data });
  return data;
}

// Record the commercial outcome of a lead (marketing ↔ revenue loop).
async function updateLeadOutcome({ company, leadId, body, leadScope }) {
  const Lead = require("../../models/Leads");
  const { mergeLeadScope } = require("../../utils/adminLeadScope");
  if (!mongoose.Types.ObjectId.isValid(leadId)) { const e = new Error("Invalid lead id"); e.status = 400; throw e; }
  const lead = await Lead.findOne(mergeLeadScope({ _id: leadId, company: company }, leadScope || {})).select("_id").lean();
  if (!lead) { const e = new Error("Lead not found"); e.status = 404; throw e; }
  const set = {};
  const numF = ["dealValue", "revenueReceived", "proposalValue"];
  numF.forEach(function (k) { if (body[k] !== undefined) set[k] = body[k] === "" || body[k] === null ? null : Math.max(0, Number(body[k]) || 0); });
  if (body.lostReason !== undefined) set.lostReason = String(body.lostReason || "").slice(0, 200);
  if (body.qualificationStatus !== undefined) set.qualificationStatus = ["qualified", "unqualified"].indexOf(body.qualificationStatus) >= 0 ? body.qualificationStatus : null;
  if (body.lifecycleStage !== undefined) set.lifecycleStage = F.STAGE_KEYS.concat(["lost"]).indexOf(body.lifecycleStage) >= 0 ? body.lifecycleStage : null;
  if (body.wonAt !== undefined) set.wonAt = body.wonAt ? new Date(body.wonAt) : null;
  if (set.lifecycleStage === "won" && !set.wonAt) set.wonAt = new Date();
  if (set.lifecycleStage === "meeting" || set.lifecycleStage === "proposal") set.opportunityCreatedAt = new Date();
  await Lead.updateOne({ _id: leadId, company: company }, { $set: set });
  ctxCache.clear();
  return { ok: true, updated: Object.keys(set) };
}

function dictionary() { return { metrics: DICTIONARY, diagnosticRules: DIAGNOSTIC_RULES, lostReasons: LOST_REASONS, stages: STAGES }; }

async function filters({ company, query, leadScope }) {
  const ctx = await getContext({ company: company, query: query, leadScope: leadScope });
  const names = await userNames(company);
  return filterOptions(ctx, names.list);
}

function clearCache() { ctxCache.clear(); aiCache.clear(); }

module.exports = {
  overview, meta, google, creatives, pipeline, report, leads, dataHealth, aiAnalysis,
  updateLeadOutcome, dictionary, filters, getSettings, saveSettings, clearCache,
};
