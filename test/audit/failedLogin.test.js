// test/audit/failedLogin.test.js
// ─────────────────────────────────────────────────────────────────────────────
// EVENT 2 — FAILED LOGIN AUDIT LOGGING
//
// Reuses test/audit/_setup.js unchanged (per the approved workflow: no
// duplicated test infrastructure). Scope is strictly failed-login coverage
// across both live endpoints — Password Reset, User Creation, User Deletion,
// and Role Change are untouched by this file.
//
// NOTE on "disabled account" / "blocked account" scenarios:
// The Admin schema has an `isActive` field, but authController.js's login
// logic NEVER reads it — every `.isActive` check in the login code path
// checks `company.isActive` (tenant-level), not the individual account's own
// flag. There is no enforced per-account disable/block at login today.
// Rather than inventing a check that doesn't exist, this suite maps:
//   • "disabled account"  -> the real, existing company-suspended check
//   • "blocked account"   -> the real, existing endpoint-blocking checks
//                            (super_admin and marketing_user accounts are
//                            genuinely blocked from this endpoint by design)
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, latestAuditEntry,
  AccessAuditLog,
} = require("./_setup");

let app;

test.before(async () => {
  await startDb();
  app = buildTestApp();
});

test.after(async () => {
  await stopDb();
});

test.beforeEach(async () => {
  await clearDb();
});

// ── Wrong password ────────────────────────────────────────────────────────────

test("LOGIN_FAILED — wrong password — Employee (/api/auth/login)", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Vn3$xTgY71Bq");

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "WrongOne!987654" });

  // ── HTTP response ──────────────────────────────────────────────────────────
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "WRONG_PASSWORD");

  // ── Audit log entry ──────────────────────────────────────────────────────────
  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed AccessAuditLog entry");

  // ── Event type ───────────────────────────────────────────────────────────
  assert.equal(entry.action, "login_failed");

  // ── Failure reason (embedded in path, per the existing metadata convention) ──
  assert.ok(entry.path.includes("wrong_password"), "metadata should record the failure reason");

  // ── Metadata: IP, user-agent, method, path ──────────────────────────────────
  assert.ok(entry.method, "method should be recorded");
  assert.equal(entry.method, "POST");
  assert.ok(typeof entry.userAgent === "string", "userAgent should be recorded (even if empty string)");
  assert.ok(entry.path.includes("/api/auth/login"), "request path should be recorded");

  // ── Status code ──────────────────────────────────────────────────────────
  assert.equal(entry.statusCode, 401);

  // ── Actor identity — email is known here, since the account exists ─────────
  assert.equal(String(entry.actorId), String(user._id));
});

test("LOGIN_FAILED — wrong password — Admin (/api/auth/login)", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: admin.email, password: "TotallyWrong!456" });

  assert.equal(res.status, 401);

  const entry = await latestAuditEntry({ actorEmail: admin.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry for the admin's wrong-password attempt");
  assert.ok(entry.path.includes("wrong_password"));
  assert.equal(entry.statusCode, 401);
  // The account genuinely exists — the audit entry must identify WHO
  // attempted the login, not leave actorId null.
  assert.equal(String(entry.actorId), String(admin._id));
  assert.equal(entry.actorModel, "Admin");
});

test("LOGIN_FAILED — wrong password — legacy endpoint (/api/auth/user-login)", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Hj5$wDpN82Ks");

  const res = await request(app)
    .post("/api/auth/user-login")
    .send({ email: user.email, password: "NotTheRealOne!22" });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "WRONG_PASSWORD");

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login_failed" });
  assert.ok(entry, "legacy endpoint should also log a failed login");
  assert.ok(entry.path.includes("wrong_password"));
  assert.equal(String(entry.actorId), String(user._id));
});

// ── Non-existing email ────────────────────────────────────────────────────────

test("LOGIN_FAILED — non-existing email (/api/auth/login)", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "definitely-not-registered@example.com", password: "Whatever!2345" });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "EMAIL_NOT_FOUND");

  const entry = await latestAuditEntry({
    actorEmail: "definitely-not-registered@example.com",
    action: "login_failed",
  });
  assert.ok(entry, "expected a login_failed entry even for an unregistered email");
  assert.ok(entry.path.includes("email_not_found"));
  // No real account exists — actorId must be null, never fabricated.
  assert.equal(entry.actorId, null);
});

test("LOGIN_FAILED — non-existing email — legacy endpoint (/api/auth/user-login)", async () => {
  const res = await request(app)
    .post("/api/auth/user-login")
    .send({ email: "also-not-registered@example.com", password: "Whatever!2345" });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "EMAIL_NOT_FOUND");

  const entry = await latestAuditEntry({
    actorEmail: "also-not-registered@example.com",
    action: "login_failed",
  });
  assert.ok(entry, "legacy endpoint should log unregistered-email attempts too");
  assert.equal(entry.actorId, null);
});

// ── "Disabled account" — mapped to the real, existing company-suspended check ─

test("LOGIN_FAILED — disabled account (company suspended) — Employee", async () => {
  const company = await makeCompany({ isActive: false });
  const user = await makeEmployee(company, "Rf6!bLcW93NtXq");

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "Rf6!bLcW93NtXq" });

  assert.equal(res.status, 403);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry for a suspended-company login attempt");
  assert.ok(entry.path.includes("company_suspended"));
  assert.equal(entry.statusCode, 403);
});

test("LOGIN_FAILED — disabled account (company suspended) — Admin", async () => {
  const company = await makeCompany({ isActive: false });
  const admin = await makeSuperAdmin(company, "Ac1$mZqX54Pv", { role: "admin" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: admin.email, password: "Ac1$mZqX54Pv" });

  assert.equal(res.status, 403);

  const entry = await latestAuditEntry({ actorEmail: admin.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry for a suspended-company admin login attempt");
  assert.ok(entry.path.includes("company_suspended"));
});

test("LOGIN_FAILED — disabled account (company suspended) — legacy endpoint", async () => {
  const company = await makeCompany({ isActive: false });
  const user = await makeEmployee(company, "Bd2$nYrW65Qu");

  const res = await request(app)
    .post("/api/auth/user-login")
    .send({ email: user.email, password: "Bd2$nYrW65Qu" });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, "Your company is deactivated");

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login_failed" });
  assert.ok(entry, "legacy endpoint should log the suspended-company attempt");
  assert.ok(entry.path.includes("company_deactivated"));
});

// ── "Blocked account" — real, existing endpoint-blocking checks ────────────────

test("LOGIN_FAILED — blocked account: super_admin using the wrong endpoint", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "super_admin" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: superAdmin.email, password: "Qw8!zRkP24Lm" });

  assert.equal(res.status, 403);
  assert.equal(res.body.redirectTo, "/superadmin/login");

  const entry = await latestAuditEntry({ actorEmail: superAdmin.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry for the blocked super_admin attempt");
  assert.ok(entry.path.includes("super_admin_wrong_endpoint"));
  assert.equal(entry.statusCode, 403);
});

test("LOGIN_FAILED — blocked account: marketing_user using the wrong endpoint", async () => {
  const company = await makeCompany();
  const marketingAdmin = await makeSuperAdmin(company, "Vn3$xTgY71Bq", { role: "marketing_user" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: marketingAdmin.email, password: "Vn3$xTgY71Bq" });

  assert.equal(res.status, 403);
  assert.equal(res.body.marketingOnly, true);

  const entry = await latestAuditEntry({ actorEmail: marketingAdmin.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry for the blocked marketing_user attempt");
  assert.ok(entry.path.includes("marketing_only_account"));
});

// ── Security: password never logged ───────────────────────────────────────────

test("LOGIN_FAILED — audit entry never contains the attempted password", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Ac1$mZqX54Pv");

  await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "MySecretGuess!007" });

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login_failed" });
  assert.ok(entry, "expected a login_failed entry");
  const serialized = JSON.stringify(entry);
  assert.ok(
    !serialized.includes("MySecretGuess!007"),
    "the audit entry must never contain the attempted password"
  );
});

// ── Multiple failures create multiple, distinct entries ────────────────────────

test("LOGIN_FAILED — repeated failed attempts create multiple distinct audit entries", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Bd2$nYrW65Qu");

  await request(app).post("/api/auth/login").send({ email: user.email, password: "Attempt1!xx" });
  await request(app).post("/api/auth/login").send({ email: user.email, password: "Attempt2!xx" });
  await request(app).post("/api/auth/login").send({ email: user.email, password: "Attempt3!xx" });

  // Poll briefly for all 3 fire-and-forget writes to land (same rationale as
  // latestAuditEntry's own polling — see _setup.js).
  let count = 0;
  const deadline = Date.now() + 5000; // raised from 2000ms — this environment has shown some operations take 10s+
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({ actorEmail: user.email, action: "login_failed" });
    if (count >= 3) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(count, 3, "three separate failed attempts should produce three separate audit entries");
});