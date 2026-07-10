// controllers/googleAnalyticsController.js
const jwt = require("jsonwebtoken");
const GoogleAnalyticsConfig = require("../models/GoogleAnalyticsConfig");
const { encryptToken, decryptToken } = require("../utils/tokenCrypto");
const ga4 = require("../services/ga4Service");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const companyOf = (req) => req.admin?.company?._id || req.admin?.company;

// GET /api/google-analytics/status
const getStatus = async (req, res) => {
  try {
    const cfg = await GoogleAnalyticsConfig.findOne({ company: companyOf(req) }).lean();
    res.json({
      connected:    !!(cfg && cfg.connected && cfg.refreshToken),
      connectedEmail: cfg?.connectedEmail || null,
      propertyId:   cfg?.propertyId || null,
      propertyName: cfg?.propertyName || null,
      needsProperty: !!(cfg?.connected && !cfg?.propertyId),
      oauthConfigured: !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-analytics/connect-url  → returns the Google consent URL
const getConnectUrl = async (req, res) => {
  try {
    ga4.assertConfigured();
    const company = String(companyOf(req));
    const adminId = String(req.admin?._id || "");
    // Short-lived signed state ties the callback back to this company/admin.
    const state = jwt.sign({ company, adminId, t: "ga_oauth" }, JWT_SECRET, { expiresIn: "15m" });
    res.json({ url: ga4.buildAuthUrl(state) });
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
    try { payload = jwt.verify(state, JWT_SECRET); } catch { return bounce("expired"); }
    if (payload.t !== "ga_oauth" || !payload.company) return bounce("error");

    const tokens = await ga4.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // No refresh token (user previously consented). Still store access token;
      // but we need refresh for long-term. prompt=consent should prevent this.
      console.warn("[GA4] No refresh_token returned on callback");
    }
    const email = await ga4.fetchUserEmail(tokens.access_token);

    await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: payload.company },
      {
        company: payload.company,
        ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        accessToken: encryptToken(tokens.access_token),
        accessTokenExpiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
        scope: tokens.scope || "",
        connectedEmail: email,
        connected: true,
        connectedAt: new Date(),
        connectedBy: payload.adminId || null,
      },
      { upsert: true, returnDocument: "after" }
    );

    return bounce("connected");
  } catch (err) {
    console.error("[GA4] callback error:", err?.response?.data || err.message);
    return bounce("error");
  }
};

// GET /api/google-analytics/properties  → list GA4 properties for connected account
const listProperties = async (req, res) => {
  try {
    const cfg = await GoogleAnalyticsConfig.findOne({ company: companyOf(req) });
    if (!cfg || !cfg.refreshToken) return res.status(400).json({ message: "Not connected" });
    const token = await ga4.getValidAccessToken(cfg);
    const props = await ga4.listProperties(token);
    res.json({ properties: props });
  } catch (err) {
    res.status(500).json({ message: err?.response?.data?.error?.message || err.message });
  }
};

// POST /api/google-analytics/property  { propertyId, propertyName }
const saveProperty = async (req, res) => {
  try {
    const { propertyId, propertyName } = req.body;
    if (!propertyId) return res.status(400).json({ message: "propertyId required" });
    const cfg = await GoogleAnalyticsConfig.findOneAndUpdate(
      { company: companyOf(req) },
      { propertyId: String(propertyId), propertyName: propertyName || null },
      { returnDocument: "after" }
    );
    if (!cfg) return res.status(404).json({ message: "Not connected" });
    res.json({ propertyId: cfg.propertyId, propertyName: cfg.propertyName });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /api/google-analytics  → disconnect
const disconnect = async (req, res) => {
  try {
    await GoogleAnalyticsConfig.findOneAndDelete({ company: companyOf(req) });
    res.json({ message: "Disconnected" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/google-analytics/dashboard?from=&to=&ai=
const getDashboard = async (req, res) => {
  try {
    const cfg = await GoogleAnalyticsConfig.findOne({ company: companyOf(req) });
    if (!cfg || !cfg.connected || !cfg.refreshToken) return res.status(400).json({ message: "Google Analytics is not connected.", code: "NOT_CONNECTED" });
    if (!cfg.propertyId) return res.status(400).json({ message: "No GA4 property selected.", code: "NO_PROPERTY" });

    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const dash = await ga4.buildDashboard(cfg, { from, to });

    if (req.query.ai === "true") {
      try { dash.aiAnalysis = await ga4.runWebsiteAI(dash); }
      catch (e) { dash.aiAnalysisError = e?.response?.status === 429 ? "AI is busy (rate limited). Try again shortly." : (e.message || "AI unavailable."); }
    }
    res.json(dash);
  } catch (err) {
    const code = err.code;
    if (code === "NOT_CONNECTED" || code === "NO_PROPERTY") return res.status(400).json({ message: err.message, code });
    res.status(500).json({ message: err?.response?.data?.error?.message || err.message });
  }
};

module.exports = { getStatus, getConnectUrl, oauthCallback, listProperties, saveProperty, disconnect, getDashboard };