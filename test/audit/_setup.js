// test/audit/_setup.js
// ─────────────────────────────────────────────────────────────────────────────
// SHARED TEST INFRASTRUCTURE for ISO Phase 4 audit logging events.
// Built for Event 1 (Login Success) — will be reused unchanged by Events 2-6.
//
// SCOPE DECISION (stated explicitly, not hidden):
// This test app mounts the REAL, unmodified controller functions from
// controllers/authController.js on a purpose-built minimal Express router,
// rather than the production route file (routes/authRoutes.js), because that
// file wires in authLimiter — Redis-backed rate limiting — which is a
// separate, already-implemented concern unrelated to audit logging. Requiring
// live Redis would make this suite unrunnable in any environment without it.
// Nothing about authController.js itself is modified for testing.
//
// Database: mongodb-memory-server — a real, ephemeral MongoDB instance.
// No mocking of Mongoose or the database layer. Every assertion in this
// suite queries the REAL AccessAuditLog collection after the REAL
// controller code has run.
// ─────────────────────────────────────────────────────────────────────────────

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-audit-suite-only";
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || "test-field-encryption-key-32-chars!!";

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// authController.js -> middlewares/rateLimiter.js opens a real Redis client
// at module-load time with an automatic reconnect loop. No live Redis exists
// in this test environment (by design — see the scope decision above). That
// retry loop's timers can still be pending in the background when the test
// file finishes, which Node's test runner reports as "asynchronous activity
// after the test ended" and can fail the whole file even though every
// individual test passed.
//
// Rather than tearing the real client down afterwards (tried first — the
// client's own reconnectStrategy schedules timers that outlive a simple
// disconnect() call), this stubs out rateLimiter.js's exports in Node's
// require cache BEFORE authController.js is loaded, so the real Redis client
// is never created in the test process at all. This changes nothing in
// production: rateLimiter.js itself is completely untouched, and its own
// fail-open design (used everywhere Redis might be down) is exactly what
// these no-op stand-ins imitate.
const path = require("path");
const rateLimiterPath = require.resolve("../../middlewares/rateLimiter");
const noop = () => {};
require.cache[rateLimiterPath] = {
  id: rateLimiterPath,
  filename: rateLimiterPath,
  loaded: true,
  exports: {
    redisClient: { isReady: false, on: noop, connect: async () => {}, disconnect: async () => {} },
    generalLimiter: (req, res, next) => next(),
    authLimiter: (req, res, next) => next(),
    blacklistToken: async () => {},
    isTokenBlacklisted: async () => false,
    acquireWaDedupLock: async () => true,
  },
};

const { loginUnified, login } = require("../../controllers/authController");
const { requestOtp, verifyOtpAndReset } = require("../../controllers/forgotPasswordController");
// Added for Event 4 — User Creation Audit Logging. Purely additive.
const { createAdmin: adminCreateAdmin, createCompanyUser, deleteAdmin: adminDeleteAdmin, deleteCompanyUser, updateAdmin } = require("../../controllers/adminController");
const {
  createCompany: superAdminCreateCompany,
  createAdmin: superAdminCreateAdmin,
  createMarketingUser,
  deleteCompany: superAdminDeleteCompany,
  deleteMarketingUser,
  toggleMarketingAccess,
} = require("../../controllers/superAdminController");
const {
  createCompany: devCreateCompany,
  createCompanySuperAdmin: devCreateCompanySuperAdmin,
  deleteCompany: devDeleteCompany,
} = require("../../controllers/developerController");
const { protectAdmin, requireCompanySuperAdmin } = require("../../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../../middlewares/superAdminMiddleware");
const { protectUnified, authorizeRoles } = require("../../middlewares/authMiddleware");
const companyIsolation = require("../../middlewares/companyIsolation");
const { validateObjectId } = require("../../middlewares/validateObjectId");
const generateToken = require("../../utils/generateToken");

const Admin = require("../../models/Admin");
const User = require("../../models/Users");
const Company = require("../../models/Company");
const Developer = require("../../models/Developer");
const AccessAuditLog = require("../../models/AccessAuditLog");

let mongod;

/** Boots an in-memory MongoDB and connects Mongoose to it. Call once per test file (before). */
async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

/** Tears down the connection and the in-memory server. Call once per test file (after). */
async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

/** Wipes all collections between tests so each test starts from a clean slate. */
async function clearDb() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

/** Builds the minimal test app for login (Event 1/2) and password reset (Event 3). */
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.post("/api/auth/login", loginUnified);
  app.post("/api/auth/user-login", login);
  // Added for Event 3 — purely additive, the 2 lines above are unchanged.
  app.post("/api/auth/forgot-password/request", requestOtp);
  app.post("/api/auth/forgot-password/reset", verifyOtpAndReset);

  // Added for Event 4 — purely additive, everything above is unchanged.
  app.post("/api/admin", protectAdmin, requireCompanySuperAdmin, adminCreateAdmin);
  app.post("/api/admin/user", protectAdmin, createCompanyUser);
  app.post("/api/superadmin/companies", protectSuperAdmin, superAdminCreateCompany);
  app.post(
    "/api/superadmin/admins",
    protectUnified, authorizeRoles("super_admin"), companyIsolation, superAdminCreateAdmin
  );
  app.post(
    "/api/superadmin/marketing-users",
    protectUnified, authorizeRoles("super_admin"), companyIsolation, createMarketingUser
  );

  // Added for Event 5 — purely additive, everything above is unchanged.
  // validateObjectId is included ONLY where the real routes have it —
  // confirmed by direct comparison against routes/adminRoute.js,
  // routes/superAdminRoute.js, and routes/developerRoutes.js.
  app.delete("/api/admin/:id", protectAdmin, validateObjectId("id"), requireCompanySuperAdmin, adminDeleteAdmin);
  app.delete("/api/admin/user/:id", protectAdmin, validateObjectId("id"), deleteCompanyUser);
  app.delete("/api/superadmin/companies/:id", protectSuperAdmin, validateObjectId("id"), superAdminDeleteCompany);
  app.delete(
    "/api/superadmin/marketing-users/:id",
    protectUnified, authorizeRoles("super_admin"), companyIsolation, deleteMarketingUser
  );
  app.delete(
    "/api/developer/companies/:id",
    protectUnified, authorizeRoles("developer"), devDeleteCompany
  );
  app.post(
    "/api/developer/companies/:id/super-admin",
    protectUnified, authorizeRoles("developer"), devCreateCompanySuperAdmin
  );

  // Added for Event 6 — purely additive, everything above is unchanged.
  app.put("/api/admin/:id", protectAdmin, validateObjectId("id"), requireCompanySuperAdmin, updateAdmin);
  app.patch(
    "/api/superadmin/marketing-users/:id/toggle",
    protectUnified, authorizeRoles("super_admin"), companyIsolation, toggleMarketingAccess
  );

  return app;
}

/** Generates a valid JWT for a given account ID/role, exactly as the real login endpoints do. */
function makeToken(id, role) {
  return generateToken(id, role);
}

/** Creates a test Company (only the fields required by the schema). */
async function makeCompany(overrides = {}) {
  return Company.create({
    name: "Test Company",
    email: `company-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    plan: "enterprise",
    isActive: true,
    ...overrides,
  });
}

/** Creates a test super_admin Admin document. */
async function makeSuperAdmin(company, plainPassword = "Qw8!zRkP24Lm", overrides = {}) {
  const admin = await Admin.create({
    name: "Test Super Admin",
    email: `superadmin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: plainPassword,
    role: "super_admin",
    company: company._id,
    ...overrides,
  });
  return admin;
}

/** Creates a test Employee (User) document with a known plaintext password. */
async function makeEmployee(company, plainPassword = "Vn3$xTgY71Bq", overrides = {}) {
  return User.create({
    name: "Test Employee",
    email: `employee-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: plainPassword,
    company: company._id,
    role: "user",
    ...overrides,
  });
}

/**
 * Creates a real Developer document. Required for any test that authenticates
 * as role "developer" — protectUnified's developer branch looks the token's
 * id up specifically in the Developer collection (Developer.findById), not
 * Admin. An Admin document's _id will never resolve there, even with a token
 * whose role claims to be "developer".
 */
async function makeDeveloper(plainPassword = "Qw8!zRkP24Lm", overrides = {}) {
  return Developer.create({
    name: "Test Developer",
    email: `developer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: plainPassword,
    ...overrides,
  });
}

/**
 * Fetches the most recent AccessAuditLog entry matching a filter.
 *
 * Audit writes in the real controllers are deliberately fire-and-forget
 * (logAuditEvent() is called WITHOUT await, matching the existing
 * middlewares/accessAudit.js pattern, so audit logging never delays a real
 * user's request). That means there is a small, real timing gap between
 * "HTTP response sent" and "audit document actually written" — a test that
 * queries immediately after the response can occasionally run ahead of the
 * write. Rather than changing the production fire-and-forget behaviour (which
 * is correct), this helper polls briefly for the entry to appear.
 */
async function latestAuditEntry(filter = {}, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let found = null;
  while (Date.now() < deadline) {
    found = await AccessAuditLog.findOne(filter).sort({ createdAt: -1 }).lean();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return found; // null if it never showed up within the timeout
}

module.exports = {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, makeDeveloper, latestAuditEntry, makeToken,
  Admin, User, Company, Developer, AccessAuditLog,
};