// controllers/googleAdsApiController.js
const jwt = require("jsonwebtoken");
const GoogleAdsApiConfig = require("../models/GoogleAdsApiConfig");
const { encryptToken } = require("../utils/tokenCrypto");
const ads = require("../services/googleAdsApiService");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

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
const loadConfig = (companyId) => GoogleAdsApiConfig.findOne({ company: companyId });

// GET /api/google-ads-api/status
const getStatus = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req)).lean();
    const connected = !!(cfg && cfg.connected && cfg.refreshToken);
    res.json({
      connected: connected,
      connectedEmail: cfg && cfg.connectedEmail ? cfg.connectedEmail : null,
      customerId:   cfg && cfg.customerId ? cfg.customerId : null,
      customerName: cfg && cfg.customerName ? cfg.customerName : null,
      needsAccount: !!(cfg && cfg.connected && !cfg.customerId),
      lastSyncedAt: cfg && cfg.lastSyncedAt ? cfg.lastSyncedAt : null,
      oauthConfigured: ads.isConfigured(cfg),
      oauthSource: ads.configHasCreds(cfg) ? "db" : (ads.envConfigured() ? "env" : null),
      developerToken: ads.hasDeveloperToken(cfg),
      developerTokenSource: (cfg && cfg.developerToken) ? "db" : (ads.envDeveloperToken().length ? "env" : null),
      loginCustomerId: cfg && cfg.loginCustomerId ? cfg.loginCustomerId : null,
      apiVersion: ads.apiVersion(),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-ads-api/oauth-config
const getOAuthConfig = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req)).lean();
    const fromDb = ads.configHasCreds(cfg);
    const env = ads.envCreds();
    res.json({
      configured: ads.isConfigured(cfg),
      source: fromDb ? "db" : (ads.envConfigured() ? "env" : null),
      clientId: fromDb ? cfg.oauthClientId : env.clientId,
      redirectUri: fromDb ? cfg.oauthRedirectUri : env.redirectUri,
      hasSecret: fromDb ? !!cfg.oauthClientSecret : !!env.clientSecret,
      developerToken: ads.hasDeveloperToken(cfg),
      hasDeveloperToken: !!(cfg && cfg.developerToken),
      loginCustomerId: cfg && cfg.loginCustomerId ? cfg.loginCustomerId : "",
      editable: true,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /api/google-ads-api/oauth-config { clientId, clientSecret, redirectUri }
const saveOAuthConfig = async (req, res) => {
  try {
    const body = req.body || {};
    const clientId    = typeof body.clientId    === "string" ? body.clientId.trim()    : "";
    const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri.trim() : "";
    const clientSecretRaw = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (!clientId)    return res.status(400).json({ message: "Client ID is required." });
    if (!redirectUri) return res.status(400).json({ message: "Redirect URI is required." });
    if (!/^https?:\/\//i.test(redirectUri)) return res.status(400).json({ message: "Redirect URI must start with http:// or https://" });

    const companyId = companyOf(req);
    const existing = await loadConfig(companyId);
    let secretToStore;
    if (clientSecretRaw) secretToStore = encryptToken(clientSecretRaw);
    else if (existing && existing.oauthClientSecret) secretToStore = existing.oauthClientSecret;
    else return res.status(400).json({ message: "Client Secret is required." });

    // Developer token (per company). Blank on edit keeps the saved one.
    const devTokenRaw = typeof body.developerToken === "string" ? body.developerToken.trim() : "";
    let devTokenToStore;
    if (devTokenRaw) devTokenToStore = encryptToken(devTokenRaw);
    else if (existing && existing.developerToken) devTokenToStore = existing.developerToken;
    else devTokenToStore = null;

    // Login customer id (manager id) — optional, digits only.
    const loginRaw = typeof body.loginCustomerId === "string" ? body.loginCustomerId.replace(/[^0-9]/g, "") : "";
    const loginToStore = loginRaw ? loginRaw : (existing && existing.loginCustomerId ? existing.loginCustomerId : null);

    const cfg = await GoogleAdsApiConfig.findOneAndUpdate(
      { company: companyId },
      {
        company: companyId, oauthClientId: clientId, oauthClientSecret: secretToStore, oauthRedirectUri: redirectUri,
        developerToken: devTokenToStore, loginCustomerId: loginToStore,
      },
      { upsert: true, returnDocument: "after", new: true }
    );
    res.json({
      configured: true, source: "db", clientId: cfg.oauthClientId, redirectUri: cfg.oauthRedirectUri,
      hasSecret: !!cfg.oauthClientSecret, hasDeveloperToken: !!cfg.developerToken,
      loginCustomerId: cfg.loginCustomerId || "", editable: true,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /api/google-ads-api/oauth-config
const clearOAuthConfig = async (req, res) => {
  try {
    const companyId = companyOf(req);
    await GoogleAdsApiConfig.findOneAndUpdate({ company: companyId }, { oauthClientId: null, oauthClientSecret: null, oauthRedirectUri: null, developerToken: null, loginCustomerId: null });
    const cfg = await loadConfig(companyId).lean();
    res.json({ configured: ads.isConfigured(cfg), source: ads.envConfigured() ? "env" : null });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-ads-api/connect-url
const getConnectUrl = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cfg = await loadConfig(companyId).lean();
    const creds = ads.resolveCreds(cfg);
    const state = jwt.sign({ company: String(companyId || ""), adminId: adminIdOf(req), t: "gads_oauth" }, JWT_SECRET, { expiresIn: "15m" });
    res.json({ url: ads.buildAuthUrl(state, creds) });
  } catch (err) {
    if (err.code === "OAUTH_NOT_CONFIGURED") return res.status(503).json({ message: err.message });
    res.status(500).json({ message: err.message });
  }
};

// GET /api/google-ads-api/callback
const oauthCallback = async (req, res) => {
  const frontend = process.env.GA_POST_CONNECT_REDIRECT || process.env.FRONTEND_URL || "/";
  const bounce = (status, reason) => {
    let url = frontend + (frontend.includes("?") ? "&" : "?") + "gads=" + status;
    if (reason) url += "&gads_reason=" + encodeURIComponent(String(reason).slice(0, 300));
    return res.redirect(url);
  };
  try {
    const { code, state, error } = req.query;
    if (error) return bounce("denied", error);
    if (!code || !state) return bounce("error", "Missing code or state from Google.");
    let payload;
    try { payload = jwt.verify(state, JWT_SECRET); } catch (e) { return bounce("expired", "OAuth state expired — please try connecting again."); }
    if (payload.t !== "gads_oauth" || !payload.company) return bounce("error", "Invalid OAuth state.");

    const existing = await loadConfig(payload.company);
    const creds = ads.resolveCreds(existing);
    const tokens = await ads.exchangeCodeForTokens(code, creds);
    const email = await ads.fetchUserEmail(tokens.access_token);

    const setFields = {
      company: payload.company,
      accessToken: encryptToken(tokens.access_token),
      accessTokenExpiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
      scope: tokens.scope || "",
      connectedEmail: email, connected: true, connectedAt: new Date(),
      connectedBy: payload.adminId || null,
    };
    if (tokens.refresh_token) setFields.refreshToken = encryptToken(tokens.refresh_token);

    await GoogleAdsApiConfig.findOneAndUpdate({ company: payload.company }, setFields, { upsert: true, returnDocument: "after" });
    return bounce("connected");
  } catch (err) {
    const apiErr = err && err.response && err.response.data && err.response.data.error;
    const detail = apiErr
      ? (apiErr.error_description || apiErr.message || JSON.stringify(apiErr))
      : (err && err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
    console.error("[GAds] callback error:", detail);
    return bounce("error", detail);
  }
};

// GET /api/google-ads-api/accounts  → list accessible Google Ads accounts
const listAccounts = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req));
    if (!cfg || !cfg.refreshToken) return res.status(400).json({ message: "Not connected" });
    const token = await ads.getValidAccessToken(cfg);
    const accounts = await ads.listAccessibleCustomers(token, cfg);
    res.json({ accounts: accounts });
  } catch (err) {
    if (err.code === "NO_DEV_TOKEN") return res.status(503).json({ message: err.message, code: "NO_DEV_TOKEN" });
    const apiMsg = err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : null;
    res.status(500).json({ message: apiMsg || err.message });
  }
};

// POST /api/google-ads-api/account { customerId, customerName, loginCustomerId }
const saveAccount = async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.customerId) return res.status(400).json({ message: "customerId required" });
    const cid = String(body.customerId).replace(/[^0-9]/g, "");
    const login = body.loginCustomerId ? String(body.loginCustomerId).replace(/[^0-9]/g, "") : null;
    const cfg = await GoogleAdsApiConfig.findOneAndUpdate(
      { company: companyOf(req) },
      { customerId: cid, customerName: body.customerName || null, loginCustomerId: login },
      { returnDocument: "after", new: true }
    );
    if (!cfg) return res.status(404).json({ message: "Not connected" });
    res.json({ customerId: cfg.customerId, customerName: cfg.customerName });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /api/google-ads-api/sync?from=&to=  → pull live metrics into GoogleAdsConfig
const sync = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req));
    if (!cfg || !cfg.connected || !cfg.refreshToken) return res.status(400).json({ message: "Google Ads is not connected.", code: "NOT_CONNECTED" });
    if (!cfg.customerId) return res.status(400).json({ message: "No Google Ads account selected.", code: "NO_ACCOUNT" });
    const result = await ads.syncToConfigs(companyOf(req), cfg, { from: req.query.from || null, to: req.query.to || null });
    res.json(result);
  } catch (err) {
    const code = err.code;
    if (code === "NO_DEV_TOKEN") return res.status(503).json({ message: err.message, code: code });
    if (code === "NOT_CONNECTED" || code === "NO_ACCOUNT") return res.status(400).json({ message: err.message, code: code });
    const apiMsg = err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : null;
    res.status(500).json({ message: apiMsg || err.message });
  }
};

// GET /api/google-ads-api/report?from=&to=  → raw live report (campaigns/devices/daily)
const getReport = async (req, res) => {
  try {
    const cfg = await loadConfig(companyOf(req));
    if (!cfg || !cfg.connected || !cfg.refreshToken) return res.status(400).json({ message: "Google Ads is not connected.", code: "NOT_CONNECTED" });
    if (!cfg.customerId) return res.status(400).json({ message: "No Google Ads account selected.", code: "NO_ACCOUNT" });
    const report = await ads.buildReport(cfg, { from: req.query.from || null, to: req.query.to || null });
    res.json(report);
  } catch (err) {
    const code = err.code;
    if (code === "NO_DEV_TOKEN") return res.status(503).json({ message: err.message, code: code });
    if (code === "NOT_CONNECTED" || code === "NO_ACCOUNT") return res.status(400).json({ message: err.message, code: code });
    const apiMsg = err && err.response && err.response.data && err.response.data.error ? err.response.data.error.message : null;
    res.status(500).json({ message: apiMsg || err.message });
  }
};

// DELETE /api/google-ads-api  → disconnect (keeps oauth app creds)
const disconnect = async (req, res) => {
  try {
    await GoogleAdsApiConfig.findOneAndUpdate(
      { company: companyOf(req) },
      { refreshToken: null, accessToken: null, accessTokenExpiry: null, scope: "",
        connectedEmail: null, customerId: null, customerName: null, loginCustomerId: null,
        connected: false, connectedAt: null, lastSyncedAt: null, connectedBy: null }
    );
    res.json({ message: "Disconnected" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = {
  getStatus, getOAuthConfig, saveOAuthConfig, clearOAuthConfig,
  getConnectUrl, oauthCallback, listAccounts, saveAccount, sync, getReport, disconnect,
};
