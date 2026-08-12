// controllers/googleAnalyticsController.js
const jwt = require("jsonwebtoken");
const GoogleAnalyticsConfig = require("../models/GoogleAnalyticsConfig");
const { encryptToken, decryptToken } = require("../utils/tokenCrypto");
const ga4 = require("../services/ga4Service");

// SECURITY (A.8.24): no fallback secret. A missing JWT_SECRET must fail loudly
// at boot rather than silently signing tokens with a publicly-known string.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set — refusing to start with an insecure fallback secret.");
}

// Resolve the caller's company id without optional chaining (Beautify-safe).
const companyOf = (req) => {
  const admin = req.admin || {};
  const company = admin.company;
  if (!company) return null;
  return company._id ? company._id : company;
};

const adminIdOf = (req) => {
  const admin = req.admin || {};
  return admin._id ? String(admin._id) : "";
};

// Fetch the company's config (or null). Used to resolve per-company OAuth creds.
const loadConfig = (companyId) => GoogleAnalyticsConfig.findOne({ company: companyId });

// GET /api/google-analytics/status
const getStatus = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req)).lean();
    const connected = !!(cfg && cfg.connected && cfg.refreshToken);
    res.json({
      connected,
      connectedEmail: cfg && cfg.connectedEmail ? cfg.connectedEmail : null,
      propertyId:     cfg && cfg.propertyId ? cfg.propertyId : null,
      propertyName:   cfg && cfg.propertyName ? cfg.propertyName : null,
      needsProperty:  !!(cfg && cfg.connected && !cfg.propertyId),
      oauthConfigured: ga4.isConfigured(cfg),
      oauthSource:     ga4.configHasCreds(cfg) ? "db" : (ga4.envConfigured() ? "env" : null),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-analytics/oauth-config
// Returns the current OAuth app credentials (client secret is never returned).
const getOAuthConfig = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req)).lean();
    const fromDb = ga4.configHasCreds(cfg);
    const env = ga4.envCreds();
    res.json({
      configured:  ga4.isConfigured(cfg),
      source:      fromDb ? "db" : (ga4.envConfigured() ? "env" : null),
      // Prefill values (safe, non-secret) so the form can be edited.
      clientId:    fromDb ? cfg.oauthClientId : env.clientId,
      redirectUri: fromDb ? cfg.oauthRedirectUri : env.redirectUri,
      hasSecret:   fromDb ? !!cfg.oauthClientSecret : !!env.clientSecret,
      // env creds can only be changed on the server; DB creds are editable here.
      editable:    true,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /api/google-analytics/oauth-config  { clientId, clientSecret, redirectUri }
// Saves per-company OAuth app credentials (overrides env). Secret encrypted at rest.
const saveOAuthConfig = async (req, res) => {
  try {
    const body = req.body || {};
    const clientId    = typeof body.clientId    === "string" ? body.clientId.trim()    : "";
    const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri.trim() : "";
    const clientSecretRaw = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";

    if (!clientId)    return res.status(400).json({ message: "Client ID is required." });
    if (!redirectUri) return res.status(400).json({ message: "Redirect URI is required." });

    if (!/^https?:\/\//i.test(redirectUri)) {
      return res.status(400).json({ message: "Redirect URI must start with http:// or https://" });
    }

    const companyId = companyOf(req);
    const existing = await loadConfig(companyId);

    // Allow keeping the previously-saved secret when the field is left blank on edit.
    let secretToStore;
    if (clientSecretRaw) {
      secretToStore = encryptToken(clientSecretRaw);
    } else if (existing && existing.oauthClientSecret) {
      secretToStore = existing.oauthClientSecret;
    } else {
      return res.status(400).json({ message: "Client Secret is required." });
    }

    const update = {
      company:           companyId,
      oauthClientId:     clientId,
      oauthClientSecret: secretToStore,
      oauthRedirectUri:  redirectUri,
    };

    const cfg = await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: companyId },
      update,
      { upsert: true, returnDocument: "after", new: true }
    );

    res.json({
      configured:  true,
      source:      "db",
      clientId:    cfg.oauthClientId,
      redirectUri: cfg.oauthRedirectUri,
      hasSecret:   !!cfg.oauthClientSecret,
      editable:    true,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /api/google-analytics/oauth-config  → clear per-company creds (revert to env)
const clearOAuthConfig = async (req, res) => {
  try {
    const companyId = companyOf(req);
    await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: companyId },
      { oauthClientId: null, oauthClientSecret: null, oauthRedirectUri: null }
    );
    const cfg = await loadConfig(companyId).lean();
    res.json({
      configured:  ga4.isConfigured(cfg),
      source:      ga4.envConfigured() ? "env" : null,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-analytics/connect-url  → returns the Google consent URL
const getConnectUrl = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cfg = await loadConfig(companyId).lean();
    const creds = ga4.resolveCreds(cfg);
    const company = String(companyId || "");
    const adminId = adminIdOf(req);
    // Short-lived signed state ties the callback back to this company/admin.
    const state = jwt.sign({ company, adminId, t: "ga_oauth" }, JWT_SECRET, { expiresIn: "15m" });
    res.json({ url: ga4.buildAuthUrl(state, creds) });
  } catch (err) {
    if (err.code === "OAUTH_NOT_CONFIGURED") return res.status(503).json({ message: err.message });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/google-analytics/callback?code=&state=  (Google redirects the browser here)
const oauthCallback = async (req, res) => {
  const frontend = process.env.GA_POST_CONNECT_REDIRECT || process.env.FRONTEND_URL || "/";
  const bounce = (status) => res.redirect(`${frontend}${frontend.includes("?") ? "&" : "?"}ga=${status}`);
  try {
    const { code, state, error } = req.query;
    if (error) return bounce("denied");
    if (!code || !state) return bounce("error");

    let payload;
    try { payload = jwt.verify(state, JWT_SECRET); } catch (e) { return bounce("expired"); }
    if (payload.t !== "ga_oauth" || !payload.company) return bounce("error");

    // Resolve the SAME credentials that were used to build the consent URL.
    const existing = await loadConfig(payload.company);
    const creds = ga4.resolveCreds(existing);

    const tokens = await ga4.exchangeCodeForTokens(code, creds);
    if (!tokens.refresh_token) {
      // No refresh token (user previously consented). Still store access token;
      // but we need refresh for long-term. prompt=consent should prevent this.
      console.warn("[GA4] No refresh_token returned on callback");
    }
    const email = await ga4.fetchUserEmail(tokens.access_token);

    const setFields = {
      company: payload.company,
      accessToken: encryptToken(tokens.access_token),
      accessTokenExpiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
      scope: tokens.scope || "",
      connectedEmail: email,
      connected: true,
      connectedAt: new Date(),
      connectedBy: payload.adminId || null,
    };
    if (tokens.refresh_token) setFields.refreshToken = encryptToken(tokens.refresh_token);

    await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: payload.company },
      setFields,
      { upsert: true, returnDocument: "after" }
    );

    return bounce("connected");
  } catch (err) {
    const detail = err && err.response && err.response.data ? err.response.data : err.message;
    console.error("[GA4] callback error:", detail);
    return bounce("error");
  }
};

// GET /api/google-analytics/properties  → list GA4 properties for connected account
const listProperties = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req));
    if (!cfg || !cfg.refreshToken) return res.status(400).json({ message: "Not connected" });
    const token = await ga4.getValidAccessToken(cfg);
    const props = await ga4.listProperties(token);
    res.json({ properties: props });
  } catch (err) {
    if (err.code === "RECONNECT_REQUIRED" || err.code === "NOT_CONNECTED") {
      return res.status(400).json({ message: err.message, code: err.code });
    }
    console.error("[GA4] listProperties error:", err);
    const fbData = err && err.response && err.response.data;
    const fbErr  = fbData && fbData.error;
    const apiMsg = typeof fbErr === "string"
      ? (fbData.error_description || fbErr)
      : (fbErr && fbErr.message) || null;
    res.status(500).json({ message: apiMsg || err.message });
  }
};

// POST /api/google-analytics/property  { propertyId, propertyName }
const saveProperty = async (req, res) => {
  try {
    const body = req.body || {};
    const { propertyId, propertyName } = body;
    if (!propertyId) return res.status(400).json({ message: "propertyId required" });
    const cfg = await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: companyOf(req) },
      { propertyId: String(propertyId), propertyName: propertyName || null },
      { returnDocument: "after", new: true, upsert: false }
    );
    if (!cfg) return res.status(404).json({ message: "Not connected — please reconnect Google Analytics first." });
    res.json({ propertyId: cfg.propertyId, propertyName: cfg.propertyName });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /api/google-analytics  → disconnect (keeps OAuth app creds intact)
const disconnect = async (req, res) => {
  try {
    // Only clear the connection/tokens; keep oauth app creds so they can reconnect.
    await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: companyOf(req) },
      {
        refreshToken: null, accessToken: null, accessTokenExpiry: null,
        scope: "", connectedEmail: null, propertyId: null, propertyName: null,
        connected: false, connectedAt: null, connectedBy: null,
      }
    );
    res.json({ message: "Disconnected" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-analytics/dashboard?from=&to=&ai=
const getDashboard = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req));
    if (!cfg || !cfg.connected || !cfg.refreshToken) return res.status(400).json({ message: "Google Analytics is not connected.", code: "NOT_CONNECTED" });
    if (!cfg.propertyId) return res.status(400).json({ message: "No GA4 property selected.", code: "NO_PROPERTY" });

    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const dash = await ga4.buildDashboard(cfg, { from, to });

    if (req.query.ai === "true") {
      try { dash.aiAnalysis = await ga4.runWebsiteAI(dash); }
      catch (e) {
        const status = e && e.response ? e.response.status : null;
        dash.aiAnalysisError = status === 429 ? "AI is busy (rate limited). Try again shortly." : (e.message || "AI unavailable.");
      }
    }
    res.json(dash);
  } catch (err) {
    const code = err.code;
    if (code === "NOT_CONNECTED" || code === "NO_PROPERTY" || code === "RECONNECT_REQUIRED") {
      return res.status(400).json({ message: err.message, code });
    }
    // Log the FULL stack server-side — without this, a 500 here only ever
    // shows up in the browser as a generic message with no way to trace it
    // back to the actual failing line from EB/CloudWatch logs.
    console.error("[GA4] getDashboard error:", err);
    const fbData = err && err.response && err.response.data;
    const fbErr  = fbData && fbData.error;
    // Handle BOTH shapes: Analytics API → { error: { message } }; OAuth token
    // endpoint → { error: "string", error_description: "..." }.
    const apiMsg = typeof fbErr === "string"
      ? (fbData.error_description || fbErr)
      : (fbErr && fbErr.message) || null;
    res.status(500).json({ message: apiMsg || err.message });
  }
};

module.exports = {
  getStatus, getOAuthConfig, saveOAuthConfig, clearOAuthConfig,
  getConnectUrl, oauthCallback, listProperties, saveProperty, disconnect, getDashboard,
};
