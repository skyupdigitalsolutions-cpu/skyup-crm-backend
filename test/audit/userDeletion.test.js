// test/audit/userDeletion.test.js
// ─────────────────────────────────────────────────────────────────────────────
// EVENT 5 — USER DELETION AUDIT LOGGING
//
// SCOPE NOTE: 6 real, live, routed deletion paths were found across 3
// controllers during analysis (see the Backend Implementation Report):
//   1. adminController.js::deleteAdmin              (Admin, by an existing Admin)
//   2. adminController.js::deleteCompanyUser         (Employee, by an Admin)
//   3. superAdminController.js::deleteCompany        (Company, simple delete)
//   4. superAdminController.js::deleteMarketingUser  (Admin/marketing_user)
//   5. developerController.js::deleteCompany         (Company, CASCADE delete
//      of ~26 related collections)
//   6. developerController.js::createCompanySuperAdmin's orphan-admin cleanup
//      (Admin, deleted as a SIDE EFFECT of a create operation, not a
//      standalone delete request — included because it is a real account
//      deletion regardless of the triggering endpoint's primary purpose)
//
// All 6 were instrumented. This file tests a representative selection
// exercising every distinct authentication middleware chain, exactly as
// Event 4 did, plus the two structurally distinct company-deletion paths
// (simple vs. cascade) since they have materially different blast radius.
//
// Reuses test/audit/_setup.js (extended additively — Events 1-4's routes are
// unchanged, confirmed by the full regression run in the same test command).
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, makeDeveloper, latestAuditEntry, makeToken,
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

// ── Successful Employee Deletion ──────────────────────────────────────────────

test("USER_DELETED — successful employee deletion by an Admin", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });
  const token = makeToken(admin._id, "admin");
  const employee = await makeEmployee(company, "Vn3$xTgY71Bq", { createdBy: admin._id });

  const res = await request(app)
    .delete(`/api/admin/user/${employee._id}`)
    .set("Authorization", `Bearer ${token}`);

  // ── HTTP response ──────────────────────────────────────────────────────────
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  // ── Database entry ──────────────────────────────────────────────────────────
  const stillExists = await User.findById(employee._id);
  assert.equal(stillExists, null, "the User document should no longer exist");

  // ── Audit log entry — every required field present ──────────────────────────
  const entry = await latestAuditEntry({ action: "delete", resourceType: "User" });
  assert.ok(entry, "expected a delete/User AccessAuditLog entry");
  assert.equal(String(entry.actorId), String(admin._id));       // actor id
  assert.equal(entry.actorModel, "Admin");
  assert.equal(entry.actorRole, "admin");                        // actor role
  assert.equal(entry.actorEmail, admin.email);                   // actor email
  assert.equal(String(entry.resourceId), String(employee._id));  // deleted user id
  assert.ok(entry.path.includes(employee.email));                // deleted user email
  assert.ok(entry.path.includes("deletedRole"));                 // deleted user role
  assert.equal(String(entry.company), String(company._id));      // company id
  assert.equal(entry.action, "delete");                           // action
  assert.equal(entry.statusCode, 200);                            // status
  assert.ok(entry.createdAt);                                     // timestamp
  assert.ok(typeof entry.ip === "string");                        // IP
  assert.ok(typeof entry.userAgent === "string");                 // user agent
});

// ── Successful Admin Deletion ──────────────────────────────────────────────────

test("USER_DELETED — successful admin deletion by a super_admin (second super_admin exists)", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Hj5$wDpN82Ks");
  const token = makeToken(superAdmin._id, "super_admin");
  const victim = await makeSuperAdmin(company, "Ac1$mZqX54Pv", { role: "admin" });

  const res = await request(app)
    .delete(`/api/admin/${victim._id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const stillExists = await Admin.findById(victim._id);
  assert.equal(stillExists, null);

  const entry = await latestAuditEntry({ action: "delete", resourceType: "Admin", resourceId: victim._id });
  assert.ok(entry);
  assert.equal(String(entry.actorId), String(superAdmin._id));
  assert.equal(entry.statusCode, 200);
});

// ── Successful Marketing User Deletion ────────────────────────────────────────

test("USER_DELETED — successful marketing user deletion (protectUnified chain)", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Rf6!bLcW93NtXq");
  const token = makeToken(superAdmin._id, "super_admin");
  const marketingUser = await Admin.create({
    name: "Marketing To Delete", email: "mkdelete@example.com", password: "Bd2$nYrW65Qu",
    role: "marketing_user", company: company._id, marketingAccess: true, isActive: true,
  });

  const res = await request(app)
    .delete(`/api/superadmin/marketing-users/${marketingUser._id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const stillExists = await Admin.findById(marketingUser._id);
  assert.equal(stillExists, null);

  const entry = await latestAuditEntry({ action: "delete", resourceType: "Admin", resourceId: marketingUser._id });
  assert.ok(entry);
  assert.ok(entry.path.includes("marketing_user"));
});

// ── Successful Company Deletion (two structurally distinct paths) ────────────

test("USER_DELETED — successful company deletion by a super_admin (simple)", async () => {
  const company = await makeCompany();
  const superAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm");
  const token = makeToken(superAdmin._id, "super_admin");
  const target = await makeCompany({ name: "Company To Delete", email: "delco@example.com" });

  const res = await request(app)
    .delete(`/api/superadmin/companies/${target._id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const stillExists = await Company.findById(target._id);
  assert.equal(stillExists, null);

  const entry = await latestAuditEntry({ action: "delete", resourceType: "Company", resourceId: target._id });
  assert.ok(entry);
  assert.ok(entry.path.includes("Company To Delete"));
});

test("USER_DELETED — successful company deletion via the developer panel (CASCADE)", async () => {
  const developer = await makeDeveloper();
  const token = makeToken(developer._id, "developer");
  const target = await makeCompany({ name: "Cascade Target Co", email: "cascade@example.com" });
  // A related record that should be cascaded away with the company.
  await makeEmployee(target, "Ac1$mZqX54Pv");

  const res = await request(app)
    .delete(`/api/developer/companies/${target._id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const companyGone = await Company.findById(target._id);
  assert.equal(companyGone, null, "the company itself should be deleted");

  const relatedGone = await User.countDocuments({ company: target._id });
  assert.equal(relatedGone, 0, "related employees should be cascaded away with the company");

  const entry = await latestAuditEntry({ action: "delete", resourceType: "Company", resourceId: target._id });
  assert.ok(entry, "expected a delete/Company entry for the cascade deletion");
  assert.ok(entry.path.includes("cascadeSummary"), "metadata should record what was cascaded");
});

// ── Deleting a Non-Existing User ──────────────────────────────────────────────

test("USER_DELETED — deleting a non-existent user returns 404 and writes no audit entry", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Vn3$xTgY71Bq", { role: "admin" });
  const token = makeToken(admin._id, "admin");
  const fakeId = "507f1f77bcf86cd799439011"; // valid ObjectId shape, not in DB

  const res = await request(app)
    .delete(`/api/admin/user/${fakeId}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 404);

  const entry = await latestAuditEntry(
    { action: "delete", resourceType: "User", resourceId: fakeId },
    { timeoutMs: 300 }
  );
  assert.equal(entry, null, "deleting a non-existent user must not write a delete entry");
});

// ── Deleting With Invalid ObjectId ─────────────────────────────────────────────

test("USER_DELETED — invalid ObjectId format is rejected before any deletion logic runs", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Rf6!bLcW93NtXq", { role: "admin" });
  const token = makeToken(admin._id, "admin");

  const res = await request(app)
    .delete("/api/admin/user/not-a-valid-object-id")
    .set("Authorization", `Bearer ${token}`);

  // validateObjectId rejects this before the controller ever runs.
  assert.notEqual(res.status, 200);

  const entry = await latestAuditEntry(
    { action: "delete", resourceType: "User", actorId: admin._id },
    { timeoutMs: 300 }
  );
  assert.equal(entry, null, "an invalid ObjectId must never reach the point of writing a delete entry");
});

// ── Unauthorized Deletion ──────────────────────────────────────────────────────

test("USER_DELETED — unauthorized: no token at all is rejected and logs nothing", async () => {
  const company = await makeCompany();
  const employee = await makeEmployee(company, "Bd2$nYrW65Qu");

  const res = await request(app).delete(`/api/admin/user/${employee._id}`);

  assert.equal(res.status, 401);

  const stillExists = await User.findById(employee._id);
  assert.ok(stillExists, "the employee must not have been deleted");

  const entry = await latestAuditEntry(
    { action: "delete", resourceType: "User", resourceId: employee._id },
    { timeoutMs: 300 }
  );
  assert.equal(entry, null);
});

// ── Forbidden Deletion ─────────────────────────────────────────────────────────

test("USER_DELETED — forbidden: a plain admin (not super_admin) cannot delete another admin", async () => {
  const company = await makeCompany();
  const plainAdmin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });
  const token = makeToken(plainAdmin._id, "admin");
  const victim = await makeSuperAdmin(company, "Hj5$wDpN82Ks", { role: "admin" });

  const res = await request(app)
    .delete(`/api/admin/${victim._id}`)
    .set("Authorization", `Bearer ${token}`);

  // requireCompanySuperAdmin blocks this — only a super_admin may delete an admin.
  assert.equal(res.status, 403);

  const stillExists = await Admin.findById(victim._id);
  assert.ok(stillExists, "the victim admin must not have been deleted");

  const entry = await latestAuditEntry(
    { action: "delete", resourceType: "Admin", resourceId: victim._id },
    { timeoutMs: 300 }
  );
  assert.equal(entry, null, "a forbidden deletion attempt must not log a false success");
});

test("USER_DELETED — forbidden: cannot delete the only super_admin", async () => {
  const company = await makeCompany();
  const onlySuperAdmin = await makeSuperAdmin(company, "Ac1$mZqX54Pv");
  const token = makeToken(onlySuperAdmin._id, "super_admin");

  const res = await request(app)
    .delete(`/api/admin/${onlySuperAdmin._id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 400);

  const stillExists = await Admin.findById(onlySuperAdmin._id);
  assert.ok(stillExists, "the only super_admin must not have been deleted");

  const entry = await latestAuditEntry(
    { action: "delete", resourceType: "Admin" },
    { timeoutMs: 300 }
  );
  assert.equal(entry, null, "a blocked deletion must not produce a delete audit entry");
});

// ── Duplicate Deletion Attempts ────────────────────────────────────────────────

test("USER_DELETED — duplicate deletion: second attempt on an already-deleted account is a no-op, not a second entry", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Rf6!bLcW93NtXq", { role: "admin" });
  const token = makeToken(admin._id, "admin");
  const employee = await makeEmployee(company, "Vn3$xTgY71Bq", { createdBy: admin._id });

  const first = await request(app)
    .delete(`/api/admin/user/${employee._id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(first.status, 200, `expected the first deletion to succeed, got ${first.status}: ${JSON.stringify(first.body)}`);

  const second = await request(app)
    .delete(`/api/admin/user/${employee._id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(second.status, 404, "the second attempt should find nothing to delete");

  let count = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({ action: "delete", resourceType: "User", resourceId: employee._id });
    if (count >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(count, 1, "exactly one delete entry should exist, not two, after a duplicate attempt");
});

// ── No Sensitive Data Stored ───────────────────────────────────────────────────

test("USER_DELETED — audit entries never contain secrets", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Hj5$wDpN82Ks", { role: "admin" });
  const token = makeToken(admin._id, "admin");
  const employee = await makeEmployee(company, "Ac1$mZqX54Pv", { createdBy: admin._id });

  const res = await request(app)
    .delete(`/api/admin/user/${employee._id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const entry = await latestAuditEntry({ action: "delete", resourceType: "User", resourceId: employee._id });
  assert.ok(entry);
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("Ac1$mZqX54Pv"), "the deleted account's password must never appear in the audit log");
});

// ── Multiple Deletions → Multiple Entries ─────────────────────────────────────

test("USER_DELETED — multiple employee deletions produce multiple distinct audit entries", async () => {
  const company = await makeCompany();
  const admin = await makeSuperAdmin(company, "Qw8!zRkP24Lm", { role: "admin" });
  const token = makeToken(admin._id, "admin");
  const e1 = await makeEmployee(company, "Vn3$xTgY71Bq", { createdBy: admin._id });
  const e2 = await makeEmployee(company, "Hj5$wDpN82Ks", { createdBy: admin._id });
  const e3 = await makeEmployee(company, "Rf6!bLcW93NtXq", { createdBy: admin._id });

  await request(app).delete(`/api/admin/user/${e1._id}`).set("Authorization", `Bearer ${token}`);
  await request(app).delete(`/api/admin/user/${e2._id}`).set("Authorization", `Bearer ${token}`);
  await request(app).delete(`/api/admin/user/${e3._id}`).set("Authorization", `Bearer ${token}`);

  let count = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({ action: "delete", resourceType: "User", actorId: admin._id });
    if (count >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(count, 3, "three separate employee deletions should produce three separate audit entries");
});