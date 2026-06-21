// controllers/metaConnectionController.js
// Meta connection helpers: verify credentials live against the Graph API,
// discover ad sets / lead forms, report per-config connection status, and
// return page-level leads grouped by ad set for the campaign cards.
//
// These are additive (new endpoints) — the existing metaConfigController is
// untouched. All routes are admin-protected.
const axios      = require("axios");
const MetaConfig = require("../models/MetaConfig");
const Lead       = require("../models/Leads");

const DEFAULT_VER = "v21.0";
const graphBase   = (ver) => `https://graph.facebook.com/${ver || DEFAULT_VER}`;

// Map a Graph API error into a short, human cause for the UI.
function describeGraphError(err) {
  const fb     = err?.response?.data?.error;
  const code   = fb?.code;
  const sub    = fb?.error_subcode;
  const msg    = fb?.message || err.message || "Unknown error";
  if (code === 190) return { ok: false, reason: "token_expired", message: "Access token is invalid or expired." };
  if (code === 200 || code === 10 || /permission/i.test(msg)) return { ok: false, reason: "missing_permission", message: "Token lacks the required permission (e.g. ads_read / leads_retrieval)." };
  if (code === 100) return { ok: false, reason: "not_found", message: "Object not found — check the ID (page / ad account / form)." };
  if (code === 4 || code === 17 || code === 32 || code === 613) return { ok: false, reason: "rate_limited", message: "Meta is rate-limiting requests. Try again shortly." };
  return { ok: false, reason: "error", message: msg, code, sub };
}

// ── POST /meta-config/test-connection ─────────────────────────────────────────
// Body: { pageId, pageAccessToken, adAccountId?, adsToken?, graphApiVersion? }
// Verifies each provided credential and returns a per-check result so the user
// sees exactly what works and what doesn't BEFORE/AFTER saving.
const testConnection = async (req, res) => {
  try {
    const { pageId, pageAccessToken, adAccountId, adsToken, graphApiVersion } = req.body;
    const ver  = graphApiVersion || DEFAULT_VER;
    const base = graphBase(ver);

    const checks = {};

    // 1. Page token → can we read the page?
    if (pageId && pageAccessToken) {
      try {
        const { data } = await axios.get(`${base}/${pageId}`, {
          params: { fields: "id,name", access_token: pageAccessToken }, timeout: 15000,
        });
        checks.page = { ok: true, name: data.name, id: data.id };
      } catch (e) { checks.page = describeGraphError(e); }
    } else {
      checks.page = { ok: false, reason: "missing", message: "Page ID and Page Access Token are required." };
    }

    // 2. Lead forms → does the token have leads access on this page?
    if (pageId && pageAccessToken) {
      try {
        const { data } = await axios.get(`${base}/${pageId}/leadgen_forms`, {
          params: { fields: "id,name,status", limit: 25, access_token: pageAccessToken }, timeout: 15000,
        });
        checks.forms = { ok: true, count: (data.data || []).length };
      } catch (e) { checks.forms = describeGraphError(e); }
    }

    // 3. Ad account + ads_read → only if provided (optional for metrics).
    if (adAccountId && adsToken) {
      const acct = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
      try {
        const { data } = await axios.get(`${base}/${acct}`, {
          params: { fields: "account_id,name,account_status", access_token: adsToken }, timeout: 15000,
        });
        checks.adAccount = { ok: true, name: data.name, id: data.account_id, status: data.account_status };
      } catch (e) { checks.adAccount = describeGraphError(e); }

      // Confirm ads_read specifically by hitting the insights edge.
      if (checks.adAccount?.ok) {
        try {
          await axios.get(`${base}/${acct}/insights`, {
            params: { fields: "spend", date_preset: "last_30d", limit: 1, access_token: adsToken }, timeout: 15000,
          });
          checks.adsRead = { ok: true };
        } catch (e) { checks.adsRead = describeGraphError(e); }
      }
    }

    const required = [checks.page, checks.forms].filter(Boolean);
    const optional = [checks.adAccount, checks.adsRead].filter(Boolean);
    const allRequiredOk = required.every(c => c.ok);
    const allOptionalOk = optional.length === 0 || optional.every(c => c.ok);

    res.json({
      ok: allRequiredOk,
      leadsReady: allRequiredOk,
      metricsReady: allRequiredOk && optional.length > 0 && allOptionalOk,
      checks,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

// ── GET /meta-config/:id/discover ─────────────────────────────────────────────
// Live-discover ad sets + lead forms for a saved config (uses its stored
// credentials), so the UI can offer pickers instead of manual ID entry.
const discover = async (req, res) => {
  try {
    const cfg = await MetaConfig.findById(req.params.id);
    if (!cfg) return res.status(404).json({ message: "Config not found" });
    const ver  = cfg.graphApiVersion || DEFAULT_VER;
    const base = graphBase(ver);

    const out = { forms: [], adsets: [] };

    if (cfg.pageId && cfg.pageAccessToken) {
      try {
        const { data } = await axios.get(`${base}/${cfg.pageId}/leadgen_forms`, {
          params: { fields: "id,name,status", limit: 100, access_token: cfg.pageAccessToken }, timeout: 15000,
        });
        out.forms = (data.data || []).map(f => ({ id: f.id, name: f.name, status: f.status }));
      } catch (e) { out.formsError = describeGraphError(e).message; }
    }

    if (cfg.adAccountId && cfg.adsToken) {
      const acct = cfg.adAccountId.startsWith("act_") ? cfg.adAccountId : `act_${cfg.adAccountId}`;
      try {
        const { data } = await axios.get(`${base}/${acct}/adsets`, {
          params: { fields: "id,name,campaign{name}", limit: 200, access_token: cfg.adsToken }, timeout: 20000,
        });
        out.adsets = (data.data || []).map(a => ({ id: a.id, name: a.name, campaignName: a.campaign?.name || "" }));
      } catch (e) { out.adsetsError = describeGraphError(e).message; }
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /meta-config/connection-status ────────────────────────────────────────
// For each config in the company, return a connection status the cards can show
// as a badge. Verifies the page token live (cheap call) and reports whether
// metrics creds exist. Cached-lightweight: one /me-style call per config.
const connectionStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });

    const configs = await MetaConfig.find({ company: companyId });
    const results = await Promise.all(configs.map(async (cfg) => {
      const base = graphBase(cfg.graphApiVersion);
      let status = "not_configured", detail = "";
      if (cfg.pageId && cfg.pageAccessToken) {
        try {
          await axios.get(`${base}/${cfg.pageId}`, {
            params: { fields: "id", access_token: cfg.pageAccessToken }, timeout: 12000,
          });
          status = "connected";
        } catch (e) {
          const d = describeGraphError(e);
          status = d.reason === "token_expired" ? "token_expired" : "error";
          detail = d.message;
        }
      }
      const metricsConfigured = !!(cfg.adAccountId && cfg.adsToken);
      return { configId: String(cfg._id), status, detail, metricsConfigured };
    }));

    res.json({ statuses: results });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /meta-config/page-leads?pageId=... ────────────────────────────────────
// Page-level lead summary: total leads for a page, broken down by ad set.
// Combines DB grouping (leads we already have, keyed by metaConfigId/adSetName/
// formId) with the configs registered for that page so empty ad sets still show.
const pageLeads = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });
    const { pageId } = req.query;
    if (!pageId) return res.status(400).json({ message: "pageId is required" });

    // All configs (ad sets) registered under this page.
    const configs = await MetaConfig.find({ company: companyId, pageId })
      .select("_id adSetName campaignName formId").lean();
    const configIds = configs.map(c => c._id);

    // All leads attributed to those configs.
    const leads = await Lead.find({ company: companyId, metaConfigId: { $in: configIds } })
      .select("_id name status metaConfigId adSetName formId createdAt").lean();

    // Group by config (ad set).
    const byConfig = new Map();
    for (const c of configs) {
      byConfig.set(String(c._id), {
        configId: String(c._id),
        adSetName: c.adSetName || c.campaignName || "(unnamed ad set)",
        formId: c.formId || "",
        total: 0, hot: 0, warm: 0, cold: 0, leads: [],
      });
    }
    for (const l of leads) {
      const k = String(l.metaConfigId);
      const g = byConfig.get(k);
      if (!g) continue;
      g.total++;
      const s = (l.status || "").toLowerCase();
      if (s.includes("hot")) g.hot++;
      else if (s.includes("warm")) g.warm++;
      else if (s.includes("cold")) g.cold++;
      g.leads.push({ id: String(l._id), name: l.name, status: l.status, createdAt: l.createdAt });
    }

    const adsets = [...byConfig.values()].sort((a, b) => b.total - a.total);
    const totalLeads = adsets.reduce((s, a) => s + a.total, 0);

    res.json({ pageId, totalLeads, adsetCount: adsets.length, adsets });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { testConnection, discover, connectionStatus, pageLeads };
