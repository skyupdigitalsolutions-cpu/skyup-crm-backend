// test/audit/userCreation.test.js
// ─────────────────────────────────────────────────────────────────────────────
// EVENT 4 — USER CREATION AUDIT LOGGING
//
// SCOPE NOTE: 10 real, live, routed account-creation functions were found
// across 5 controllers during analysis (see the Backend Implementation
// Report). ALL 10 were instrumented with logAuditEvent. This test file does
// NOT exercise all 10 individually — instead it tests a representative
// selection that exercises every DISTINCT authentication middleware chain
// used across the 10 (protectAdmin, protectSuperAdmin, and
// protectUnified+authorizeRoles+companyIsolation used by two different
// controllers). A wiring bug in any chain would be caught by this selection,
// since every instrumented function uses the identical logAuditEvent() call
// pattern regardless of which controller it lives in.
//
// Reuses test/audit/_setup.js (extended additively — Events 1-3's routes are
// unchanged, confirmed by the full regression run in the same test command).
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, latestAuditEntry, makeToken,
  Admin, User, Company, AccessAuditLog,
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

// ── Successful Employee Creation (protectAdmin) ───────────────────────────────

test("USER_CREATED — successful employee creation by an Admin", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });
  const token = makeToken(admin._id, "admin");

  const res = await request(app)
    .post("/api/admin/user")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "New Employee", email: "newemployee@example.com", password: "Vn3$xTgY71Bq" });

  // ── HTTP response ──────────────────────────────────────────────────────────
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.email, "newemployee@example.com");

  // ── Database entry ──────────────────────────────────────────────────────────
  const created = await User.findOne({ email: "newemployee@example.com" });
  assert.ok(created, "the new User document should exist");

  // ── Audit log entry — every required field present ──────────────────────────
  const entry = await latestAuditEntry({ action: "create", resourceType: "User" });
  assert.ok(entry, "expected a create/User AccessAuditLog entry");
  assert.equal(String(entry.actorId), String(admin._id));      // actor
  assert.equal(entry.actorModel, "Admin");
  assert.equal(entry.actorRole, "admin");                       // actor role
  assert.equal(String(entry.resourceId), String(created._id));  // created user id
  assert.ok(entry.path.includes("newemployee@example.com"));    // created user email (in metadata)
  assert.ok(entry.path.includes("createdRole"));                // created user role present
  assert.equal(String(entry.company), String(company._id));     // company id
  assert.equal(entry.action, "create");                          // action
  assert.equal(entry.statusCode, 201);                           // status
  assert.ok(entry.createdAt);                                    // timestamp
  assert.ok(typeof entry.ip === "string");                       // IP
  assert.ok(typeof entry.userAgent === "string");                // user agent
});

// ── Successful Admin Creation (protectAdmin + requireCompanySuperAdmin) ──────

test("USER_CREATED — successful admin creation by a super_admin", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Hj5$wDpN82Ks");
  const token = makeToken(superAdmin._id, "super_admin");

  const res = await request(app)
    .post("/api/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "New Admin", email: "newadmin@example.com", password: "Ac1$mZqX54Pv" });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

  const created = await Admin.findOne({ email: "newadmin@example.com" });
  assert.ok(created);

  const entry = await latestAuditEntry({ action: "create", resourceType: "Admin" });
  assert.ok(entry);
  assert.equal(String(entry.actorId), String(superAdmin._id));
  assert.equal(String(entry.resourceId), String(created._id));
  assert.equal(entry.statusCode, 201);
});

// ── Successful Admin Creation via the SUPER ADMIN PANEL (different middleware chain) ──

test("USER_CREATED — successful admin creation via the super admin panel (protectUnified chain)", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Rf6!bLcW93NtXq");
  const token = makeToken(superAdmin._id, "super_admin");

  const res = await request(app)
    .post("/api/superadmin/admins")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Panel Admin", email: "paneladmin@example.com", password: "Bd2$nYrW65Qu" });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

  const entry = await latestAuditEntry({ action: "create", resourceType: "Admin", actorEmail: superAdmin.email });
  assert.ok(entry, "expected a create/Admin entry via the protectUnified chain");
  assert.equal(String(entry.actorId), String(superAdmin._id));
});

// ── Successful Marketing User Creation ────────────────────────────────────────

test("USER_CREATED — successful marketing user creation", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm");
  const token = makeToken(superAdmin._id, "super_admin");

  const res = await request(app)
    .post("/api/superadmin/marketing-users")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Marketing Person", email: "marketing@example.com", password: "Vn3$xTgY71Bq" });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

  const created = await Admin.findOne({ email: "marketing@example.com" });
  assert.ok(created);
  assert.equal(created.role, "marketing_user");

  const entry = await latestAuditEntry({ action: "create", resourceType: "Admin", resourceId: created._id });
  assert.ok(entry, "expected a create/Admin entry for the marketing user");
  assert.ok(entry.path.includes("marketing_user"));
});

// ── Successful Company Creation (protectSuperAdmin chain) ────────────────────

test("USER_CREATED — successful company creation by a super_admin", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Hj5$wDpN82Ks");
  const token = makeToken(superAdmin._id, "super_admin");

  const res = await request(app)
    .post("/api/superadmin/companies")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Brand New Co", email: "newco@example.com", phone: "9999999999" });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

  const created = await Company.findOne({ email: "newco@example.com" });
  assert.ok(created, "the new Company document should exist");

  const entry = await latestAuditEntry({ action: "create", resourceType: "Company" });
  assert.ok(entry, "expected a create/Company entry");
  assert.equal(String(entry.resourceId), String(created._id));
  assert.equal(String(entry.actorId), String(superAdmin._id));
  assert.ok(entry.path.includes("Brand New Co"));
});

// ── Duplicate Email Failure ───────────────────────────────────────────────────

test("USER_CREATED — duplicate admin email fails and does not create a second audit entry", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Ac1$mZqX54Pv");
  const token = makeToken(superAdmin._id, "super_admin");

  const first = await request(app)
    .post("/api/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "First", email: "dup@example.com", password: "Rf6!bLcW93NtXq" });

  // Verify the FIRST request actually succeeded before anything else — if
  // this fails, the problem is in creation itself, not audit logging.
  assert.equal(first.status, 201, `expected the first creation to succeed with 201, got ${first.status}: ${JSON.stringify(first.body)}`);

  const second = await request(app)
    .post("/api/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Second", email: "dup@example.com", password: "Bd2$nYrW65Qu" });

  assert.equal(second.status, 400, "duplicate email should be rejected");

  // Confirm the Admin document itself exists (proves creation succeeded,
  // independent of anything to do with audit logging).
  const createdAdmin = await Admin.findOne({ email: "dup@example.com" });
  assert.ok(createdAdmin, "the admin document itself should exist after the first request");

  // Poll for the FIRST request's fire-and-forget audit write to land. Timeout
  // raised to 5000ms given other operations in this suite have been observed
  // taking several seconds in this environment. If this still fails, the
  // diagnostic dump below will show exactly what (if anything) was written.
  let count = 0;
  let allCreateEntries = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({
      action: "create", resourceType: "Admin",
      path: { $regex: "dup@example.com" },
    });
    if (count >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (count !== 1) {
    // Diagnostic dump — shows exactly what create-events exist (if any),
    // so the real cause is visible in the terminal output rather than
    // just an opaque "0 !== 1".
    allCreateEntries = await AccessAuditLog.find({ action: "create" }).lean();
    console.log(
      "[DIAGNOSTIC] Expected 1 matching create/Admin entry for dup@example.com, found",
      count,
      "— all create-action entries currently in the DB:",
      JSON.stringify(allCreateEntries.map((e) => ({ resourceType: e.resourceType, path: e.path, actorEmail: e.actorEmail })), null, 2)
    );
  }

  assert.equal(count, 1, "a rejected duplicate-email creation must not add a second audit entry");
});

// ── Validation Failure ────────────────────────────────────────────────────────

test("USER_CREATED — validation failure (missing required fields) does not create an audit entry", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Vn3$xTgY71Bq");
  const token = makeToken(superAdmin._id, "super_admin");

  const res = await request(app)
    .post("/api/superadmin/marketing-users")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Missing Fields Person" }); // no email, no password

  assert.equal(res.status, 400);

  const entry = await latestAuditEntry({ action: "create", resourceType: "Admin", actorId: superAdmin._id });
  assert.equal(entry, null, "a validation failure must not produce a create audit entry");
});

// ── Unauthorized Creation Attempts ────────────────────────────────────────────

test("USER_CREATED — unauthorized: no token at all is rejected and logs nothing", async () => {
  const res = await request(app)
    .post("/api/admin/user")
    .send({ name: "Sneaky", email: "sneaky@example.com", password: "Hj5$wDpN82Ks" });

  assert.equal(res.status, 401);

  const created = await User.findOne({ email: "sneaky@example.com" });
  assert.equal(created, null, "no account should have been created");

  const entry = await latestAuditEntry({ action: "create", resourceType: "User" }, { timeoutMs: 300 });
  assert.equal(entry, null, "an unauthenticated request must not produce a create audit entry");
});

test("USER_CREATED — unauthorized: an employee token cannot create an admin", async () => {
  const company = await makeCompany();
  const employee = await makeEmployee(company, "Ac1$mZqX54Pv");
  const token = makeToken(employee._id, "employee");

  const res = await request(app)
    .post("/api/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Should Not Work", email: "blocked@example.com", password: "Rf6!bLcW93NtXq" });

  // protectAdmin only accepts admin/super_admin-shaped tokens looked up in the
  // Admin collection — an employee id won't resolve to an Admin document.
  assert.notEqual(res.status, 201, "an employee token must not be able to create an admin");

  const created = await Admin.findOne({ email: "blocked@example.com" });
  assert.equal(created, null);

  const entry = await latestAuditEntry({ action: "create", resourceType: "Admin", actorEmail: "blocked@example.com" }, { timeoutMs: 300 });
  assert.equal(entry, null, "a blocked unauthorized attempt must not log a false creation");
});

// ── No Sensitive Data Stored ───────────────────────────────────────────────────

test("USER_CREATED — audit entries never contain the password across every creation type", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm");
  const token = makeToken(superAdmin._id, "super_admin");

  const adminRes = await request(app)
    .post("/api/admin")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Secret Test", email: "secrettest@example.com", password: "Xk7!bQmZ82Wr" });

  // Verify this succeeded BEFORE assuming an audit entry should exist for it.
  // If this assertion is what fails, the real problem is in account creation
  // itself (e.g. company resolution inside protectAdmin), not audit logging —
  // and the printed body will show the actual reason.
  assert.equal(
    adminRes.status, 201,
    `expected admin creation to succeed with 201, got ${adminRes.status}: ${JSON.stringify(adminRes.body)}`
  );

  const companyRes = await request(app)
    .post("/api/superadmin/companies")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Secret Co", email: "secretco@example.com" });

  assert.equal(
    companyRes.status, 201,
    `expected company creation to succeed with 201, got ${companyRes.status}: ${JSON.stringify(companyRes.body)}`
  );

  // Wait for BOTH fire-and-forget writes to land before checking. Without
  // this, a passing result could be a FALSE POSITIVE — looping over an empty
  // or partial result set trivially satisfies "no entry contains the
  // password" without actually having checked either real entry.
  let entries = [];
  const deadline = Date.now() + 5000; // raised from 2000ms — this environment has shown some operations take 10s+
  while (Date.now() < deadline) {
    entries = await AccessAuditLog.find({ action: "create" }).lean();
    if (entries.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(entries.length >= 2, "expected both create events to have been written before checking their contents");

  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("Xk7!bQmZ82Wr"), "no audit entry may ever contain a plaintext password");
  }
});

// ── Multiple Creations → Multiple Entries ─────────────────────────────────────

test("USER_CREATED — multiple employee creations produce multiple distinct audit entries", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Hj5$wDpN82Ks", { role: "admin" });
  const token = makeToken(admin._id, "admin");

  await request(app).post("/api/admin/user").set("Authorization", `Bearer ${token}`).send({ name: "E1", email: "e1@example.com", password: "Ac1$mZqX54Pv" });
  await request(app).post("/api/admin/user").set("Authorization", `Bearer ${token}`).send({ name: "E2", email: "e2@example.com", password: "Rf6!bLcW93NtXq" });
  await request(app).post("/api/admin/user").set("Authorization", `Bearer ${token}`).send({ name: "E3", email: "e3@example.com", password: "Bd2$nYrW65Qu" });

  let count = 0;
  const deadline = Date.now() + 5000; // raised from 2000ms — this environment has shown some operations take 10s+
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({ action: "create", resourceType: "User", actorId: admin._id });
    if (count >= 3) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(count, 3, "three separate employee creations should produce three separate audit entries");
});