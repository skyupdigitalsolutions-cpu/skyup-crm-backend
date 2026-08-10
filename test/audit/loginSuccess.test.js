// test/audit/loginSuccess.test.js
// ─────────────────────────────────────────────────────────────────────────────
// EVENT 1 — LOGIN SUCCESS AUDIT LOGGING
// Scope: success paths only, for all 3 roles reachable via both live login
// endpoints. Failed-login coverage is deliberately OUT of scope here — that
// is Event 2, tested separately once approved.
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, latestAuditEntry,
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

test("LOGIN_SUCCESS — unified login (/api/auth/login) — Admin (non-super_admin role)", async () => {
  const company = await makeCompany();
  // Explicitly role: "admin" — the unified endpoint deliberately blocks
  // super_admin accounts (see the dedicated test below), so a genuine
  // Admin-login-success case must use the plain "admin" role.
  const admin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: admin.email, password: "Qw8!zRkP24Lm" });

  // ── API Response ─────────────────────────────────────────────────────────
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, "response should include a JWT token");
  assert.equal(res.body.email, admin.email);

  // ── Database entry (AccessAuditLog) ─────────────────────────────────────
  const entry = await latestAuditEntry({ actorEmail: admin.email, action: "login" });
  assert.ok(entry, "expected an AccessAuditLog entry with action=login for this admin");

  // ── Event type ───────────────────────────────────────────────────────────
  assert.equal(entry.action, "login");

  // ── Actor ────────────────────────────────────────────────────────────────
  assert.equal(entry.actorModel, "Admin");
  assert.equal(String(entry.actorId), String(admin._id));
  assert.equal(entry.actorEmail, admin.email);
  assert.equal(entry.actorRole, "admin");

  // ── Company / tenant ────────────────────────────────────────────────────
  assert.equal(String(entry.company), String(company._id));

  // ── Status / timestamp ───────────────────────────────────────────────────
  assert.equal(entry.statusCode, 200);
  assert.ok(entry.createdAt, "entry should have a timestamp");
  assert.ok(new Date(entry.createdAt) instanceof Date && !isNaN(new Date(entry.createdAt)));
});

test("LOGIN_SUCCESS — super_admin is correctly BLOCKED on the unified endpoint (no false login logged)", async () => {
  // This documents real, intended application security behaviour: super_admin
  // accounts must use the separate, OTP-secured /superadmin/login flow, not
  // this endpoint. This is not a login success — the audit log must NOT
  // record one.
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "super_admin" });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: superAdmin.email, password: "Qw8!zRkP24Lm" });

  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.redirectTo, "/superadmin/login");

  const entry = await latestAuditEntry({ actorEmail: superAdmin.email, action: "login" });
  assert.equal(entry, null, "a blocked super_admin attempt must not be logged as a successful login");
});

test("LOGIN_SUCCESS — unified login (/api/auth/login) — Employee", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Vn3$xTgY71Bq");

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "Vn3$xTgY71Bq" });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login" });
  assert.ok(entry, "expected an AccessAuditLog entry with action=login for this employee");
  assert.equal(entry.actorModel, "User");
  assert.equal(String(entry.actorId), String(user._id));
  assert.equal(entry.statusCode, 200);
  assert.equal(String(entry.company), String(company._id));
});

test("LOGIN_SUCCESS — legacy endpoint (/api/auth/user-login) — Employee", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Hj5$wDpN82Ks");

  const res = await request(app)
    .post("/api/auth/user-login")
    .send({ email: user.email, password: "Hj5$wDpN82Ks" });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login" });
  assert.ok(entry, "legacy login endpoint should also write a login audit entry");
  assert.equal(entry.actorModel, "User");
  assert.equal(entry.statusCode, 200);
});

test("LOGIN_SUCCESS — audit entry does not contain the password", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Rf6!bLcW93NtXq");

  await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "Rf6!bLcW93NtXq" });

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "login" });
  assert.ok(entry, "expected a login entry");
  const serialized = JSON.stringify(entry);
  assert.ok(
    !serialized.includes("Rf6!bLcW93NtXq"),
    "the audit entry must never contain the plaintext password"
  );
});

test("LOGIN_SUCCESS — two different accounts produce two distinct audit entries", async () => {
  const company = await makeCompany();
  const userA = await makeEmployee(company, "Ac1$mZqX54Pv");
  const userB = await makeEmployee(company, "Bd2$nYrW65Qu");

  await request(app).post("/api/auth/login").send({ email: userA.email, password: "Ac1$mZqX54Pv" });
  await request(app).post("/api/auth/login").send({ email: userB.email, password: "Bd2$nYrW65Qu" });

  const entryA = await latestAuditEntry({ actorEmail: userA.email, action: "login" });
  const entryB = await latestAuditEntry({ actorEmail: userB.email, action: "login" });

  assert.ok(entryA, "expected an entry for user A");
  assert.ok(entryB, "expected an entry for user B");
  assert.notEqual(String(entryA._id), String(entryB._id));
  assert.equal(String(entryA.actorId), String(userA._id));
  assert.equal(String(entryB.actorId), String(userB._id));
});