const crypto = require("crypto");

const verifyMetaSignature = async (req, res, next) => {
  try {
    // ── Resolve the correct App Secret ───────────────────────────────────────
    // Priority: per-campaign appSecret in DB → META_APP_SECRET env var
    // If neither is set (or is still the placeholder), SKIP verification with warning.
    let secret = null;

    try {
      const MetaConfig = require("../models/MetaConfig");
      const pageId = req.body?.entry?.[0]?.id;
      if (pageId) {
        const config = await MetaConfig.findOne({ pageId }).select("appSecret").lean();
        if (config?.appSecret && config.appSecret.trim() !== "") {
          secret = config.appSecret.trim();
        }
      }
    } catch (_) { /* DB lookup failed — fall through */ }

    // Fall back to env var — but reject placeholder value
    if (!secret) {
      const envSecret = process.env.META_APP_SECRET;
      const isPlaceholder = !envSecret ||
        envSecret === "your_meta_app_secret" ||
        envSecret.startsWith("your_");
      if (!isPlaceholder) {
        secret = envSecret;
      }
    }

    // No valid secret found — skip verification, log warning, allow through
    if (!secret) {
      console.warn("⚠️  META_APP_SECRET not configured — skipping signature check. Set a real App Secret in .env or per-campaign config.");
      return next();
    }

    // ── Verify HMAC-SHA256 signature ─────────────────────────────────────────
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      console.warn("❌ Missing x-hub-signature-256 header from Meta");
      return res.sendStatus(403);
    }

    const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = "sha256=" + crypto
      .createHmac("sha256", secret)
      .update(bodyBuffer)
      .digest("hex");

    if (signature !== expected) {
      console.warn("❌ Invalid Meta signature — check that META_APP_SECRET matches your Meta App's App Secret exactly.");
      console.warn(`   Received:  ${signature}`);
      console.warn(`   Computed:  ${expected}`);
      return res.sendStatus(403);
    }

    next();
  } catch (err) {
    console.error("Signature verification error:", err);
    res.sendStatus(500);
  }
};

module.exports = verifyMetaSignature;