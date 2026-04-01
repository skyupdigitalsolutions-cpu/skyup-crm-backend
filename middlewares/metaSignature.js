const crypto    = require("crypto");
const { APP_SECRET } = require("../config/meta");

// BUG FIX: Look up the per-campaign appSecret from MetaConfig using the pageId
// embedded in the webhook body. Fall back to the global .env APP_SECRET.
// This allows multiple Facebook Pages (different apps) to each have their own secret.
const getAppSecret = async (reqBody) => {
  try {
    const MetaConfig = require("../models/MetaConfig");
    const pageId = reqBody?.entry?.[0]?.id;
    if (pageId) {
      const config = await MetaConfig.findOne({ pageId, isActive: true }).select("appSecret").lean();
      if (config?.appSecret) return config.appSecret;
    }
  } catch (_) { /* ignore — fall through to env */ }
  return APP_SECRET;
};

const verifyMetaSignature = async (req, res, next) => {
  // If APP_SECRET not configured at all, let request through with a warning
  const secret = await getAppSecret(req.body);

  if (!secret) {
    console.warn("⚠️  META_APP_SECRET is not set — skipping signature verification. Set it in .env for security.");
    return next();
  }

  try {
    const signature = req.headers["x-hub-signature-256"];

    if (!signature) {
      console.warn("Missing Meta signature header");
      return res.sendStatus(403);
    }

    // BUG FIX: req.rawBody may be undefined if the raw-body capture middleware
    // did not run (e.g. non-JSON content-type). Fall back to a serialised body.
    const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body));

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(bodyBuffer)
        .digest("hex");

    if (signature !== expected) {
      console.warn("Invalid Meta signature");
      return res.sendStatus(403);
    }

    next();
  } catch (err) {
    console.error("Signature verification error:", err);
    res.sendStatus(500);
  }
};

module.exports = verifyMetaSignature;