const crypto = require("crypto");

const verifyMetaSignature = async (req, res, next) => {
  try {
    // ── DEBUG: Confirm rawBody was captured ──────────────────────────────────
    // If this logs "false", the body parser in server.js is not capturing it
    // correctly and HMAC will always fail.
    console.log(`🔍 rawBody present: ${!!req.rawBody} | size: ${req.rawBody?.length ?? 0} bytes`);

    // ── Resolve the correct App Secret ───────────────────────────────────────
    // Priority: per-campaign appSecret in DB → META_APP_SECRET env var
    // If neither is set (or is still the placeholder), SKIP verification with warning.
    let secret     = null;
    let secretFrom = null;

    try {
      const MetaConfig = require("../models/MetaConfig");
      const pageId = req.body?.entry?.[0]?.id;

      if (pageId) {
        const config = await MetaConfig.findOne({ pageId }).select("appSecret campaignName").lean();
        if (config?.appSecret && config.appSecret.trim() !== "") {
          secret     = config.appSecret.trim();
          secretFrom = `DB (campaign: "${config.campaignName}")`;
        } else {
          console.warn(`⚠️  No appSecret in DB for pageId "${pageId}" — falling back to env`);
        }
      } else {
        console.warn("⚠️  Could not extract pageId from req.body.entry[0].id — falling back to env");
      }
    } catch (dbErr) {
      console.warn("⚠️  DB lookup for appSecret failed:", dbErr.message, "— falling back to env");
    }

    // Fall back to env var — but reject placeholder value
    if (!secret) {
      const envSecret     = process.env.META_APP_SECRET;
      const isPlaceholder = !envSecret ||
        envSecret === "your_meta_app_secret" ||
        envSecret.startsWith("your_");

      if (!isPlaceholder) {
        secret     = envSecret;
        secretFrom = "ENV (META_APP_SECRET)";
      }
    }

    // No valid secret found — skip verification, log warning, allow through
    if (!secret) {
      console.warn("⚠️  META_APP_SECRET not configured — skipping signature check.");
      console.warn("   👉 Fix: Set META_APP_SECRET in .env OR save the App Secret per-campaign in CRM.");
      return next();
    }

    console.log(`🔑 Using App Secret from: ${secretFrom}`);

    // ── Verify HMAC-SHA256 signature ─────────────────────────────────────────
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      console.warn("❌ Missing x-hub-signature-256 header from Meta");
      console.warn("   👉 This usually means the request did not come from Meta,");
      console.warn("      or you are testing with a tool that doesn't sign the body.");
      return res.sendStatus(403);
    }

    // MUST use rawBody — JSON.stringify(req.body) byte-order is not guaranteed
    // to match Meta's original payload and will produce a wrong HMAC.
    if (!req.rawBody) {
      console.error("❌ req.rawBody is undefined — cannot verify HMAC.");
      console.error("   👉 Fix: Make sure the raw body capture middleware in server.js");
      console.error("      runs BEFORE any other body parser and BEFORE this route.");
      return res.sendStatus(500);
    }

    const expected = "sha256=" + crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expected) {
      console.warn("❌ Invalid Meta signature — HMAC mismatch.");
      console.warn(`   Received : ${signature}`);
      console.warn(`   Computed : ${expected}`);
      console.warn("   👉 Fix: Check that the App Secret in your CRM / .env exactly");
      console.warn("      matches your Meta App's App Secret (no extra spaces).");
      return res.sendStatus(403);
    }

    console.log("✅ Meta signature verified");
    next();
  } catch (err) {
    console.error("Signature verification error:", err);
    res.sendStatus(500);
  }
};

module.exports = verifyMetaSignature;