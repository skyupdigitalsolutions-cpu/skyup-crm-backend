// middlewares/entitlementMiddleware.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Express middleware factory built on top of entitlementService.
//
// Usage patterns:
//
//   // 1. Attach entitlements to every request (use early in the chain)
//   router.use(attachEntitlements);
//
//   // 2. Block if subscription is not active/trial
//   router.post('/leads', requireNotReadOnly(), createLead);
//
//   // 3. Block if a specific feature is disabled
//   router.get('/recordings', requireFeature('callRecording'), listRecordings);
//
//   // 4. Block if company is at or above a numeric resource limit
//   router.post('/users', checkLimit('users'), createUser);
//
// All middleware return 403 JSON on failure so the frontend can handle it
// uniformly.
// ─────────────────────────────────────────────────────────────────────────────

const { getCompanyEntitlements } = require("../services/entitlementService");

// ── Resolve companyId from the request ───────────────────────────────────────
// Supports all auth contexts used in this codebase:
//   • Admin token  → req.admin.company._id  or  req.admin.company
//   • User token   → req.user.company
//   • Route param  → req.params.companyId  (developer / superadmin endpoints)
function resolveCompanyId(req) {
  return (
    req.admin?.company?._id ||
    req.admin?.company      ||
    req.user?.company?._id  ||
    req.user?.company       ||
    req.params?.companyId   ||
    null
  );
}

// ── attachEntitlements ────────────────────────────────────────────────────────
/**
 * Middleware that resolves and attaches `req.entitlements` to every request.
 * Must be mounted AFTER auth middleware so req.admin / req.user is populated.
 *
 * On failure (company not found, DB error) the middleware logs and passes
 * through WITHOUT blocking — controllers should still handle missing
 * entitlements gracefully.
 */
const attachEntitlements = async (req, res, next) => {
  const companyId = resolveCompanyId(req);

  if (!companyId) {
    // No company context (e.g. developer/superadmin global endpoints)
    req.entitlements = null;
    return next();
  }

  try {
    req.entitlements = await getCompanyEntitlements(companyId);
  } catch (err) {
    console.error("[attachEntitlements] failed:", err.message);
    req.entitlements = null;
  }

  return next();
};

// ── requireNotReadOnly ────────────────────────────────────────────────────────
/**
 * Middleware factory — blocks the request if the company's subscription is not
 * active or trial (i.e. suspended, paused, expired, cancelled).
 *
 * Requires attachEntitlements to have run first, OR resolves on its own.
 *
 * @returns {function} Express middleware
 */
const requireNotReadOnly = () => async (req, res, next) => {
  try {
    let ent = req.entitlements;

    if (!ent) {
      const companyId = resolveCompanyId(req);
      if (!companyId) {
        return res.status(401).json({
          success: false,
          message: "Company context not found",
          code:    "NO_COMPANY_CONTEXT",
        });
      }
      ent = await getCompanyEntitlements(companyId);
    }

    if (ent.readOnly) {
      return res.status(403).json({
        success: false,
        message: `Your subscription is ${ent.subscriptionStatus}. This action is not available in read-only mode.`,
        code:    "SUBSCRIPTION_READ_ONLY",
        subscriptionStatus: ent.subscriptionStatus,
      });
    }

    // Attach for downstream use even if attachEntitlements wasn't in chain
    req.entitlements = ent;
    return next();
  } catch (err) {
    console.error("[requireNotReadOnly]", err.message);
    return res.status(500).json({ success: false, message: "Entitlement check failed" });
  }
};

// ── requireFeature ────────────────────────────────────────────────────────────
/**
 * Middleware factory — blocks the request if the given feature is not enabled
 * for the company.
 *
 * @param {string} featureKey — key in the entitlements object
 *   e.g. "callRecording", "apiAccess", "whiteLabel"
 * @returns {function} Express middleware
 */
const requireFeature = (featureKey) => async (req, res, next) => {
  try {
    let ent = req.entitlements;

    if (!ent) {
      const companyId = resolveCompanyId(req);
      if (!companyId) {
        return res.status(401).json({
          success: false,
          message: "Company context not found",
          code:    "NO_COMPANY_CONTEXT",
        });
      }
      ent = await getCompanyEntitlements(companyId);
    }

    if (!ent[featureKey]) {
      return res.status(403).json({
        success: false,
        message: `Your current plan does not include "${featureKey}". Please upgrade to access this feature.`,
        code:    "FEATURE_NOT_ENABLED",
        feature: featureKey,
        plan:    ent.plan,
      });
    }

    req.entitlements = ent;
    return next();
  } catch (err) {
    console.error("[requireFeature]", err.message);
    return res.status(500).json({ success: false, message: "Entitlement check failed" });
  }
};

// ── checkLimit ────────────────────────────────────────────────────────────────
/**
 * Middleware factory — blocks the request if the company is AT or ABOVE a
 * numeric resource limit.
 *
 * The caller must supply a `countFn` — an async function that receives `req`
 * and returns the current count.  This keeps the middleware decoupled from
 * any specific collection.
 *
 * @param {string} resource — key in entitlements (e.g. "users", "leads", "admins")
 * @param {function} countFn — async (req) => number
 * @returns {function} Express middleware
 *
 * @example
 *   router.post(
 *     '/users',
 *     checkLimit('users', async (req) => {
 *       const companyId = req.admin.company._id;
 *       return User.countDocuments({ company: companyId, isActive: true });
 *     }),
 *     createUser
 *   );
 */
const checkLimit = (resource, countFn) => async (req, res, next) => {
  if (typeof countFn !== "function") {
    throw new Error(`checkLimit: countFn is required for resource "${resource}"`);
  }

  try {
    let ent = req.entitlements;

    if (!ent) {
      const companyId = resolveCompanyId(req);
      if (!companyId) {
        return res.status(401).json({
          success: false,
          message: "Company context not found",
          code:    "NO_COMPANY_CONTEXT",
        });
      }
      ent = await getCompanyEntitlements(companyId);
    }

    const limit = ent[resource];

    // If limit is undefined or 0 (feature not in plan), treat as blocked
    if (limit === undefined || limit === null) {
      return res.status(403).json({
        success:  false,
        message:  `Resource "${resource}" is not available on your current plan.`,
        code:     "RESOURCE_NOT_IN_PLAN",
        resource,
      });
    }

    // 0 as a deliberate "unlimited" sentinel (e.g. enterprise leads = 999999)
    // We use 999999 not 0, so 0 means "blocked" on basic plan.
    const current = await countFn(req);

    if (current >= limit) {
      return res.status(403).json({
        success:  false,
        message:  `You have reached the ${resource} limit (${limit}) for your plan. Please upgrade or purchase an addon.`,
        code:     "RESOURCE_LIMIT_REACHED",
        resource,
        limit,
        current,
      });
    }

    req.entitlements = ent;
    return next();
  } catch (err) {
    console.error("[checkLimit]", err.message);
    return res.status(500).json({ success: false, message: "Entitlement check failed" });
  }
};

module.exports = {
  attachEntitlements,
  requireNotReadOnly,
  requireFeature,
  checkLimit,
};
