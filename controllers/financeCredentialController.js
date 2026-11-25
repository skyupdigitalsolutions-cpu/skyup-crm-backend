// controllers/financeCredentialController.js — Finance dashboard → Credentials vault.
//  · secrets are encrypted with utils/fieldCrypto (AES-256-GCM); saving is
//    REFUSED when FIELD_ENCRYPTION_KEY isn't configured, so a password is never
//    stored readable
//  · lists never contain secrets — only which ones exist
//  · a secret is decrypted only by POST /:id/reveal, and every reveal is logged
//  · platform developers (support access to finance) can see the list but can
//    never reveal a company's secrets
"use strict";
const mongoose = require("mongoose");
const FinanceCredential = require("../models/FinanceCredential");
const { encrypt, decrypt } = require("../utils/fieldCrypto");

const SECRET_FIELDS = ["password", "apiKey", "secretNotes"];
const KINDS = ["tool", "client", "employee"];
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const fail = (res, code, message) => res.status(code).json({ success: false, message });

function companyIdOf(req) {
  if (req.developer) return isId(req.params?.companyId) ? String(req.params.companyId) : null;
  const c = req.admin?.company?._id || req.admin?.company || req.user?.companyId || req.user?.company?._id || req.user?.company || null;
  return c ? String(c) : null;
}
function actorOf(req) {
  if (req.developer) return { id: req.developer._id, name: `${req.developer.name || "Developer"} (platform)` };
  if (req.admin) return { id: req.admin._id, name: req.admin.name || "Finance" };
  return { id: req.user?._id || null, name: req.user?.name || "Finance" };
}
// Encryption must actually be on: encrypt() falls back to plain text without a key.
const encryptionReady = () => { try { return String(encrypt("probe")).startsWith("v1:"); } catch { return false; } };

// Safe view: no secret values, just whether each one is set.
function dto(c) {
  const o = c.toObject ? c.toObject() : c;
  const out = { ...o };
  for (const f of SECRET_FIELDS) { out[`has_${f}`] = !!o[f]; delete out[f]; }
  out.lastReveal = (o.revealLog || []).slice(-1)[0] || null;
  delete out.revealLog;
  return out;
}

function plainFieldsFrom(b) {
  const out = {};
  if (b.kind !== undefined) out.kind = KINDS.includes(b.kind) ? b.kind : "tool";
  for (const [k, max] of [["name", 120], ["service", 80], ["url", 400], ["username", 200], ["notes", 1000], ["clientName", 160], ["employeeName", 120]]) {
    if (b[k] !== undefined) out[k] = str(b[k], max);
  }
  if (b.url && out.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(out.url)) out.url = `https://${out.url}`;
  if (b.employee !== undefined) out.employee = isId(b.employee) ? b.employee : null;
  if (b.tool !== undefined) out.tool = isId(b.tool) ? b.tool : null;
  if (b.expiresOn !== undefined) { const d = b.expiresOn ? new Date(b.expiresOn) : null; out.expiresOn = d && !isNaN(d) ? d : null; }
  return out;
}

async function listCredentials(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const q = { company };
    if (KINDS.includes(req.query.kind)) q.kind = req.query.kind;
    const list = await FinanceCredential.find(q).sort({ kind: 1, name: 1 }).lean();
    res.json({ success: true, credentials: list.map(dto), encryptionReady: encryptionReady(), canReveal: !req.developer });
  } catch (e) { fail(res, 500, "Could not load credentials."); }
}

async function createCredential(req, res) {
  try {
    if (!encryptionReady()) return fail(res, 503, "The vault is locked: FIELD_ENCRYPTION_KEY isn't set on the server, so passwords can't be stored safely. Ask your developer to set it.");
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const b = req.body || {};
    const plain = plainFieldsFrom({ kind: "tool", ...b });
    if (!plain.name) return fail(res, 400, "Give the credential a name.");
    const a = actorOf(req);
    const doc = { company, ...plain, createdByName: a.name, updatedByName: a.name };
    for (const f of SECRET_FIELDS) if (b[f]) doc[f] = encrypt(String(b[f]).slice(0, f === "secretNotes" ? 4000 : 1000));
    if (b.password) doc.passwordChangedAt = new Date();
    const c = await FinanceCredential.create(doc);
    res.json({ success: true, credential: dto(c) });
  } catch (e) { fail(res, 500, "Could not save the credential."); }
}

// Secrets change only when a new value is sent; clear_<field>: true removes one.
async function updateCredential(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid credential.");
    const c = await FinanceCredential.findOne({ _id: req.params.id, company });
    if (!c) return fail(res, 404, "Credential not found.");
    const b = req.body || {};
    const changingSecret = SECRET_FIELDS.some((f) => b[f]);
    if (changingSecret && !encryptionReady()) return fail(res, 503, "The vault is locked: FIELD_ENCRYPTION_KEY isn't set on the server.");
    Object.assign(c, plainFieldsFrom(b));
    if (!c.name) return fail(res, 400, "Give the credential a name.");
    for (const f of SECRET_FIELDS) {
      if (b[f]) c[f] = encrypt(String(b[f]).slice(0, f === "secretNotes" ? 4000 : 1000));
      else if (b[`clear_${f}`]) c[f] = "";
    }
    if (b.password) c.passwordChangedAt = new Date();
    c.updatedByName = actorOf(req).name;
    await c.save();
    res.json({ success: true, credential: dto(c) });
  } catch (e) { fail(res, 500, "Could not update the credential."); }
}

async function deleteCredential(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid credential.");
    const r = await FinanceCredential.deleteOne({ _id: req.params.id, company });
    if (!r.deletedCount) return fail(res, 404, "Credential not found.");
    res.json({ success: true });
  } catch (e) { fail(res, 500, "Could not delete the credential."); }
}

// POST /:id/reveal { field } → the decrypted value, logged.
async function revealCredential(req, res) {
  try {
    if (req.developer) return fail(res, 403, "Platform support access can't reveal a company's passwords.");
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid credential.");
    const field = SECRET_FIELDS.includes(req.body?.field) ? req.body.field : "password";
    const c = await FinanceCredential.findOne({ _id: req.params.id, company }).select(`${field} name`);
    if (!c) return fail(res, 404, "Credential not found.");
    if (!c[field]) return fail(res, 404, "Nothing saved there.");
    const value = decrypt(c[field]);
    const a = actorOf(req);
    await FinanceCredential.updateOne({ _id: c._id }, {
      $push: { revealLog: { $each: [{ field, byName: a.name, byId: isId(a.id) ? a.id : null, at: new Date() }], $slice: -200 } },
      $inc: { revealCount: 1 },
    });
    res.set("Cache-Control", "no-store");
    res.json({ success: true, value });
  } catch (e) { fail(res, 500, "Could not reveal the value."); }
}

async function credentialLog(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid credential.");
    const c = await FinanceCredential.findOne({ _id: req.params.id, company }).select("name revealLog revealCount").lean();
    if (!c) return fail(res, 404, "Credential not found.");
    res.json({ success: true, log: [...(c.revealLog || [])].reverse(), total: c.revealCount || 0 });
  } catch (e) { fail(res, 500, "Could not load the log."); }
}

module.exports = { listCredentials, createCredential, updateCredential, deleteCredential, revealCredential, credentialLog, dto, encryptionReady };
