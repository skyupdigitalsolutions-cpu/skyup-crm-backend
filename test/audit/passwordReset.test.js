// test/audit/passwordReset.test.js
// ─────────────────────────────────────────────────────────────────────────────
// EVENT 3 — PASSWORD RESET AUDIT LOGGING
//
// Reuses test/audit/_setup.js (extended additively to mount the forgot-password
// routes — the existing login route mounts from Events 1/2 are unchanged).
// Scope is strictly the forgot-password flow — Login Success, Failed Login,
// User Creation, User Deletion, and Role Change are untouched by this file.
//
// SCOPE NOTE — "Password Reset Company Suspended":
// Traced the entire forgotPasswordController.js: there is no company-suspension
// check anywhere in requestOtp or verifyOtpAndReset. This is a real,
// pre-existing gap in business logic (out of scope for an audit-LOGGING task —
// fixing it would change functional behaviour, not just add logging). No test
// for this scenario is included, since the described behaviour does not exist
// in the code; fabricating one would misrepresent the system.
// ─────────────────────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const {
  startDb, stopDb, clearDb, buildTestApp,
  makeCompany, makeSuperAdmin, makeEmployee, latestAuditEntry,
  User, AccessAuditLog,
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

// ── Helper: directly seed a valid, unexpired OTP on a user document ──────────
// Mirrors exactly what requestOtp itself does, so tests of the RESET stage
// don't depend on email delivery (Brevo) succeeding.
async function seedOtp(doc, rawOtp = "654321", { expired = false, attempts = 0 } = {}) {
  const otpHash = await bcrypt.hash(rawOtp, 10);
  doc.resetOtp = otpHash;
  doc.resetOtpExpiry = expired
    ? new Date(Date.now() - 60 * 1000) // 1 minute in the past
    : new Date(Date.now() + 10 * 60 * 1000);
  doc.resetOtpAttempts = attempts;
  await doc.save();
  return rawOtp;
}

// ── Forgot Password Request ───────────────────────────────────────────────────

test("PASSWORD_RESET_REQUESTED — success for a real account", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Vn3$xTgY71Bq");

  const res = await request(app)
    .post("/api/auth/forgot-password/request")
    .send({ email: user.email });

  // ── HTTP response ──────────────────────────────────────────────────────────
  assert.equal(res.status, 200);
  assert.match(res.body.message, /If an account with that email exists/);

  // ── Audit log entry ──────────────────────────────────────────────────────────
  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_requested" });
  assert.ok(entry, "expected a password_reset_requested entry");
  assert.equal(entry.action, "password_reset_requested");
  assert.equal(String(entry.actorId), String(user._id));
  assert.equal(entry.actorModel, "User");
  assert.equal(entry.statusCode, 200);
  assert.ok(entry.path.includes("otp_sent"), "metadata should record that an OTP was generated");

  // ── An OTP was actually set on the account ──────────────────────────────────
  const updated = await User.findById(user._id);
  assert.ok(updated.resetOtp, "resetOtp should now be set on the account");
});

test("PASSWORD_RESET_REQUESTED — unknown email still returns 200 (anti-enumeration), but is distinguished in the audit log", async () => {
  const res = await request(app)
    .post("/api/auth/forgot-password/request")
    .send({ email: "no-such-account@example.com" });

  // ── HTTP response — MUST be identical to the success case (anti-enumeration) ──
  assert.equal(res.status, 200);
  assert.match(res.body.message, /If an account with that email exists/);

  // ── Audit log entry — internally distinguished, unlike the HTTP response ────
  const entry = await latestAuditEntry({
    actorEmail: "no-such-account@example.com",
    action: "password_reset_requested",
  });
  assert.ok(entry, "expected a password_reset_requested entry even for an unknown email");
  assert.ok(entry.path.includes("email_not_found"));
  assert.equal(entry.actorId, null, "no real account exists — actorId must never be fabricated");
});

// ── OTP Verification (tested via the reset endpoint, since that's where OTP is checked) ──

test("OTP_VERIFICATION — success: correct OTP allows the reset to complete", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Hj5$wDpN82Ks");
  const otp = await seedOtp(user, "111222");

  const res = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "Rf6!bLcW93NtXq" });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset" });
  assert.ok(entry, "expected a password_reset (success) entry");
});

test("OTP_VERIFICATION — failure: wrong OTP is rejected and logged", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Ac1$mZqX54Pv");
  await seedOtp(user, "111222");

  const res = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp: "999999", newPassword: "Bd2$nYrW65Qu" });

  assert.equal(res.status, 400);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_failed" });
  assert.ok(entry, "expected a password_reset_failed entry");
  assert.ok(entry.path.includes("wrong_otp"));
});

// ── Password Reset Success ────────────────────────────────────────────────────

test("PASSWORD_RESET — success: password is actually changed and correctly attributed", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Qw8!zRkP24Lm");
  const otp = await seedOtp(user, "222333");

  const res = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "Vn3$xTgY71Bq" });

  assert.equal(res.status, 200);

  // ── Database entry: password genuinely changed ──────────────────────────────
  const updated = await User.findById(user._id);
  assert.ok(await updated.matchPassword("Vn3$xTgY71Bq"), "new password should now work");
  assert.equal(await updated.matchPassword("Qw8!zRkP24Lm"), false, "old password should no longer work");
  assert.equal(updated.resetOtp, null, "OTP should be cleared after a successful reset");

  // ── Audit log entry ──────────────────────────────────────────────────────────
  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset" });
  assert.ok(entry);
  assert.equal(entry.action, "password_reset");
  assert.equal(String(entry.actorId), String(user._id));
  assert.equal(entry.actorModel, "User");
  assert.equal(entry.statusCode, 200);
  assert.ok(entry.createdAt);
});

// ── Password Reset Invalid OTP ────────────────────────────────────────────────

test("PASSWORD_RESET — invalid OTP does not change the password and is logged as a failure", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Hj5$wDpN82Ks");
  await seedOtp(user, "333444");

  const res = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp: "000000", newPassword: "Rf6!bLcW93NtXq" });

  assert.equal(res.status, 400);

  const unchanged = await User.findById(user._id);
  assert.ok(await unchanged.matchPassword("Hj5$wDpN82Ks"), "password must remain unchanged");

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_failed" });
  assert.ok(entry);
  assert.ok(entry.path.includes("wrong_otp"));
  assert.equal(entry.statusCode, 400);
});

// ── Password Reset Expired OTP ────────────────────────────────────────────────

test("PASSWORD_RESET — expired OTP is rejected and logged with the correct reason", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Ac1$mZqX54Pv");
  const otp = await seedOtp(user, "444555", { expired: true });

  const res = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "Bd2$nYrW65Qu" });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /expired/i);

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_failed" });
  assert.ok(entry, "expected a password_reset_failed entry");
  assert.ok(entry.path.includes("otp_expired"));
});

// ── Password Reset Reused OTP ─────────────────────────────────────────────────

test("PASSWORD_RESET — a successfully-used OTP cannot be reused for a second reset", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Qw8!zRkP24Lm");
  const otp = await seedOtp(user, "555666");

  // First reset — succeeds and clears the OTP.
  const first = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "Vn3$xTgY71Bq" });
  assert.equal(first.status, 200);

  // Second attempt — SAME OTP, now that it's been cleared by the first success.
  const second = await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "Hj5$wDpN82Ks" });

  assert.equal(second.status, 400, "a cleared/reused OTP must not be accepted a second time");

  // Confirm the SECOND attempt did not change the password again.
  const finalState = await User.findById(user._id);
  assert.ok(await finalState.matchPassword("Vn3$xTgY71Bq"), "password should still be what the FIRST reset set");

  // The reused-OTP attempt hits the same underlying reason as "no OTP
  // requested" — the field was already cleared by the prior success.
  const failEntry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_failed" });
  assert.ok(failEntry, "expected a password_reset_failed entry for the reuse attempt");
  assert.ok(failEntry.path.includes("no_otp_requested"));
});

// ── Multiple reset attempts create separate audit entries ────────────────────

test("PASSWORD_RESET — multiple failed attempts create multiple distinct audit entries", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Ac1$mZqX54Pv");
  await seedOtp(user, "666777");

  await request(app).post("/api/auth/forgot-password/reset").send({ email: user.email, otp: "111111", newPassword: "Bd2$nYrW65Qu" });
  await request(app).post("/api/auth/forgot-password/reset").send({ email: user.email, otp: "222222", newPassword: "Bd2$nYrW65Qu" });
  await request(app).post("/api/auth/forgot-password/reset").send({ email: user.email, otp: "333333", newPassword: "Bd2$nYrW65Qu" });

  let count = 0;
  const deadline = Date.now() + 5000; // raised from 2000ms — this environment has shown some operations take 10s+
  while (Date.now() < deadline) {
    count = await AccessAuditLog.countDocuments({ actorEmail: user.email, action: "password_reset_failed" });
    if (count >= 3) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(count, 3, "three separate wrong-OTP attempts should produce three separate audit entries");
});

// ── Security: never log secrets ───────────────────────────────────────────────

test("PASSWORD_RESET — audit entries never contain the new password", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Qw8!zRkP24Lm");
  const otp = await seedOtp(user, "777888");

  await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp, newPassword: "SuperSecretNewPass!789" });

  const entry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset" });
  assert.ok(entry);
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("SuperSecretNewPass!789"), "the new password must never appear in the audit log");
});

test("PASSWORD_RESET — audit entries never contain the OTP value, success or failure", async () => {
  const company = await makeCompany();
  const user = await makeEmployee(company, "Hj5$wDpN82Ks");
  const realOtp = await seedOtp(user, "999000");

  // Failed attempt — wrong OTP guessed
  await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp: "123123", newPassword: "Rf6!bLcW93NtXq" });

  const failEntry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset_failed" });
  assert.ok(failEntry);
  let serialized = JSON.stringify(failEntry);
  assert.ok(!serialized.includes("123123"), "the guessed OTP must never appear in the audit log");
  assert.ok(!serialized.includes("999000"), "the real OTP must never appear in the audit log");

  // Successful attempt — real OTP used
  await request(app)
    .post("/api/auth/forgot-password/reset")
    .send({ email: user.email, otp: realOtp, newPassword: "Rf6!bLcW93NtXq" });

  const successEntry = await latestAuditEntry({ actorEmail: user.email, action: "password_reset" });
  assert.ok(successEntry);
  serialized = JSON.stringify(successEntry);
  assert.ok(!serialized.includes("999000"), "the real OTP must never appear in the audit log, even on success");
});