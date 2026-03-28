const crypto = require("crypto");
const { APP_SECRET } = require("../config/meta");

const verifyMetaSignature = (req, res, next) => {
  try {
    const signature = req.headers["x-hub-signature-256"];

    if (!signature) {
      console.warn("Missing Meta signature header");
      return res.sendStatus(403);
    }

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.rawBody)
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