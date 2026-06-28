// controllers/termsController.js
// ─────────────────────────────────────────────────────────────────────────────
// Terms & Conditions acceptance flow.
//
//   GET  /api/terms/current   → active terms + whether THIS user has accepted it
//   POST /api/terms/accept    → record acceptance of the current active version
//   GET  /api/terms/admin/list    (developer) → all published versions
//   POST /api/terms/admin/publish (developer) → publish a new version
//
// All routes are mounted behind protectUnified, so req.user is the logged-in
// identity (Developer | Admin/SuperAdmin | User) with a normalised `role`.
//
// PRODUCT RULE: the Developer panel is EXEMPT from accepting. For developers,
// GET /current returns mustAccept:false so the gate never blocks them.
// ─────────────────────────────────────────────────────────────────────────────
const TermsAndConditions = require("../models/TermsAndConditions");
const TermsAcceptance    = require("../models/TermsAcceptance");

// Map normalised role → the Mongoose model name the identity lives in.
function modelForRole(role) {
  if (role === "developer") return "Developer";
  // protectUnified resolves both admin and super_admin from the Admin collection
  // (falling back to the legacy SuperAdmin collection only if not found there).
  if (role === "admin" || role === "super_admin") return "Admin";
  return "User"; // employee / user
}

// Developers are exempt from the acceptance gate.
function isExempt(role) {
  return role === "developer";
}

// ── GET /api/terms/current ────────────────────────────────────────────────────
// Returns the active terms document and whether the current user must accept it.
const getCurrentTerms = async (req, res) => {
  try {
    const role = req.user?.role || "user";

    const terms = await TermsAndConditions.findOne({ isActive: true }).lean();

    // No terms published yet → nobody is blocked.
    if (!terms) {
      return res.json({ terms: null, mustAccept: false, accepted: true, version: null });
    }

    // Developer panel is exempt — never blocked.
    if (isExempt(role)) {
      return res.json({ terms, mustAccept: false, accepted: true, version: terms.version });
    }

    const already = await TermsAcceptance.exists({
      userId:  req.user._id,
      version: terms.version,
    });

    return res.json({
      terms,
      version:    terms.version,
      accepted:   !!already,
      mustAccept: !already, // frontend gate uses this
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/terms/accept ────────────────────────────────────────────────────
// Records that the current user accepted the active version.
const acceptTerms = async (req, res) => {
  try {
    const role = req.user?.role || "user";

    // Developers don't need to accept; treat as success no-op.
    if (isExempt(role)) {
      return res.json({ ok: true, exempt: true });
    }

    const terms = await TermsAndConditions.findOne({ isActive: true }).select("version").lean();
    if (!terms) {
      return res.status(400).json({ message: "No active terms to accept." });
    }

    // Optional client confirmation that they accepted the version they saw.
    // If provided and it doesn't match the active version, reject so the client
    // re-fetches the latest terms (prevents accepting stale content).
    const clientVersion = req.body?.version;
    if (clientVersion !== undefined && Number(clientVersion) !== terms.version) {
      return res.status(409).json({
        message: "Terms have been updated. Please review the latest version.",
        code: "TERMS_VERSION_MISMATCH",
        currentVersion: terms.version,
      });
    }

    const company =
      req.user.company?._id || req.user.company || null;

    // Idempotent: unique index on (userId, version) prevents duplicates.
    await TermsAcceptance.updateOne(
      { userId: req.user._id, version: terms.version },
      {
        $setOnInsert: {
          userId:    req.user._id,
          userModel: modelForRole(role),
          role,
          company,
          version:   terms.version,
          acceptedAt: new Date(),
          ipAddress: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null,
        },
      },
      { upsert: true }
    );

    res.json({ ok: true, version: terms.version });
  } catch (err) {
    // Duplicate key (already accepted) is fine.
    if (err.code === 11000) return res.json({ ok: true, alreadyAccepted: true });
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/terms/admin/list (developer) ─────────────────────────────────────
const listTermsVersions = async (req, res) => {
  try {
    const versions = await TermsAndConditions.find()
      .sort({ version: -1 })
      .lean();
    res.json(versions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/terms/admin/publish (developer) ─────────────────────────────────
// Publishes a NEW version. Auto-increments version, deactivates the old active
// one. Body: { title, effectiveDate, intro, sections: [{heading, body}] }.
const publishTerms = async (req, res) => {
  try {
    const { title, effectiveDate, intro, sections } = req.body;

    if (!Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ message: "sections[] is required and cannot be empty." });
    }

    const latest = await TermsAndConditions.findOne().sort({ version: -1 }).select("version").lean();
    const nextVersion = (latest?.version || 0) + 1;

    // Deactivate any currently-active version.
    await TermsAndConditions.updateMany({ isActive: true }, { $set: { isActive: false } });

    const created = await TermsAndConditions.create({
      version:       nextVersion,
      title:         title || "Terms & Conditions",
      effectiveDate: effectiveDate || "",
      intro:         intro || "",
      sections,
      isActive:      true,
      publishedAt:   new Date(),
      publishedBy:   req.user?._id || null,
    });

    res.status(201).json({ ok: true, version: created.version, terms: created });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getCurrentTerms,
  acceptTerms,
  listTermsVersions,
  publishTerms,
};
