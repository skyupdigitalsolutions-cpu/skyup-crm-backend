/**
 * scripts/auditDuplicateLeads.js
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY audit: are duplicate leads being stored in the CRM?
 * Writes NOTHING to the database.
 *
 * Checks
 *   1. Do the dedup unique indexes actually exist in MongoDB?
 *      (If duplicates existed when the index was first built, Mongo refuses to
 *      create it and Mongoose only logs the error — dedup is then silently OFF.)
 *   2. Leads whose phone is stored but `normalizedPhone` is missing — these are
 *      invisible to every duplicate check (e.g. admin Excel/CSV import).
 *   3. Duplicate groups by phone (primary AND secondary, same 10-digit
 *      normalisation the CRM uses), per company.
 *   4. Duplicate Meta/Google lead IDs (leadgenId).
 *   5. Same email on different leads (informational).
 *   6. For each duplicate group: which sources collided and how far apart the
 *      leads were created (seconds apart = webhook race / double submit).
 *
 * Usage (from the backend folder):
 *   node scripts/auditDuplicateLeads.js
 *   node scripts/auditDuplicateLeads.js --company=<companyId>
 *   node scripts/auditDuplicateLeads.js --include-merged      (also count leads already merged away)
 *   node scripts/auditDuplicateLeads.js --out=./dup-audit     (report folder, default ./duplicate-audit)
 *
 * Output
 *   Console summary + CSV files:
 *     <out>/duplicate-phone-groups.csv   one row per lead in each duplicate group
 *     <out>/duplicate-leadgen-ids.csv
 *     <out>/duplicate-emails.csv
 *     <out>/missing-normalized-phone.csv
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { normalizePhone } = require("../utils/normalizePhone");

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const COMPANY = arg("company");
const OUT = path.resolve(arg("out") || "./duplicate-audit");
const INCLUDE_MERGED = process.argv.includes("--include-merged");

const csvEsc = (v) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file, header, rows) => {
  fs.writeFileSync(path.join(OUT, file), "\ufeff" + [header.join(",")].concat(rows.map((r) => r.map(csvEsc).join(","))).join("\n"));
};
const human = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

// ── Pure grouping logic (exported for testing) ───────────────────────────────
function findPhoneDuplicates(leads) {
  // Union-find so a lead linked through primary OR secondary joins one group.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byKey = new Map();
  const phonesOf = new Map();
  for (const l of leads) {
    const id = String(l._id);
    parent.set(id, id);
    const nums = new Set();
    [l.mobile, l.primaryPhone, l.secondaryPhone].forEach((p) => { const n = normalizePhone(p); if (n) nums.add(n); });
    phonesOf.set(id, nums);
    nums.forEach((n) => {
      const k = `${l.company}|${n}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(id);
    });
  }
  byKey.forEach((ids) => { for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]); });
  const groups = new Map();
  for (const l of leads) {
    const r = find(String(l._id));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(l);
  }
  return Array.from(groups.values())
    .filter((g) => g.length > 1)
    .map((g) => {
      g.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const shared = new Set();
      const counts = new Map();
      g.forEach((l) => phonesOf.get(String(l._id)).forEach((n) => counts.set(n, (counts.get(n) || 0) + 1)));
      counts.forEach((c, n) => { if (c > 1) shared.add(n); });
      const first = new Date(g[0].createdAt).getTime(), last = new Date(g[g.length - 1].createdAt).getTime();
      return { leads: g, phones: Array.from(shared), spanMs: last - first };
    });
}

function classifyCause(group) {
  const ls = group.leads;
  const missingNorm = ls.some((l) => !l.normalizedPhone && (l.mobile || l.primaryPhone));
  const csv = ls.some((l) => l.importedViaCsv);
  const secondaryHit = ls.some((l) => {
    const ns = normalizePhone(l.secondaryPhone);
    return ns && group.phones.includes(ns);
  });
  if (missingNorm && csv) return "Excel/CSV import saved without normalizedPhone";
  if (missingNorm) return "normalizedPhone missing on one lead (bypassed dedup)";
  if (secondaryHit) return "Number is primary on one lead and secondary on another";
  if (group.spanMs < 2 * 60 * 1000) return "Created within 2 min (double submit / webhook race) — unique index likely missing";
  return "Both leads have normalizedPhone — unique index likely missing or was dropped";
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) { console.error("❌ No Mongo connection string (MONGO_URI / MONGODB_URI / DB_URI)."); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const leadsCol = db.collection("leads");
  fs.mkdirSync(OUT, { recursive: true });
  console.log("✅ Connected (read-only audit — nothing will be written to the database)\n");

  // ── 1. Indexes ───────────────────────────────────────────────────────────
  const idx = await leadsCol.indexes();
  const need = ["company_normalizedPhone_unique", "company_normalizedSecondaryPhone_unique", "company_leadgenId_unique"];
  console.log("1) Dedup indexes in MongoDB");
  need.forEach((n) => {
    const i = idx.find((x) => x.name === n);
    console.log(`   ${i ? "✅" : "❌ MISSING"}  ${n}${i ? (i.unique ? "" : "  (exists but NOT unique!)") : ""}`);
  });
  const legacyLeadgen = idx.find((x) => x.key && x.key.leadgenId === 1 && Object.keys(x.key).length === 1 && x.unique);
  if (legacyLeadgen) console.log(`   ⚠  Old GLOBAL unique index "${legacyLeadgen.name}" on leadgenId still present (blocks same lead id across companies).`);

  // ── Load leads (projection only) ────────────────────────────────────────
  const match = {};
  if (COMPANY) match.company = new mongoose.Types.ObjectId(COMPANY);
  if (!INCLUDE_MERGED) match.mergedInto = null;
  const leads = await leadsCol.find(match, {
    projection: { name: 1, mobile: 1, primaryPhone: 1, secondaryPhone: 1, normalizedPhone: 1, normalizedSecondaryPhone: 1,
      email: 1, leadgenId: 1, source: 1, campaign: 1, company: 1, status: 1, createdAt: 1, importedViaCsv: 1, addedManually: 1, mergedInto: 1, isClosed: 1 },
  }).toArray();
  const companies = await db.collection("companies").find({}, { projection: { name: 1 } }).toArray().catch(() => []);
  const cname = new Map(companies.map((c) => [String(c._id), c.name || String(c._id)]));
  console.log(`\n   Leads scanned: ${leads.length}${COMPANY ? ` (company ${COMPANY})` : ""}${INCLUDE_MERGED ? " incl. merged" : " (merged-away leads excluded)"}`);

  // ── 2. Missing normalizedPhone ──────────────────────────────────────────
  const missing = leads.filter((l) => (l.mobile || l.primaryPhone) && !l.normalizedPhone && normalizePhone(l.mobile || l.primaryPhone));
  const invalid = leads.filter((l) => (l.mobile || l.primaryPhone) && !normalizePhone(l.mobile || l.primaryPhone));
  const missBySrc = {};
  missing.forEach((l) => { const k = l.importedViaCsv ? "Excel/CSV import" : (l.source || "(blank)"); missBySrc[k] = (missBySrc[k] || 0) + 1; });
  console.log(`\n2) Leads with a valid phone but NO normalizedPhone (invisible to duplicate checks): ${missing.length}`);
  Object.entries(missBySrc).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  console.log(`   Leads whose phone can't be normalised to 10 digits (never de-duplicated): ${invalid.length}`);
  writeCsv("missing-normalized-phone.csv", ["company", "leadId", "name", "mobile", "source", "importedViaCsv", "createdAt"],
    missing.map((l) => [cname.get(String(l.company)) || l.company, l._id, l.name, l.mobile || l.primaryPhone, l.source, !!l.importedViaCsv, l.createdAt]));

  // ── 3. Phone duplicates ─────────────────────────────────────────────────
  const groups = findPhoneDuplicates(leads);
  const extra = groups.reduce((s, g) => s + g.leads.length - 1, 0);
  const byCause = {}, byPair = {}, byCompany = {};
  groups.forEach((g) => {
    g.cause = classifyCause(g);
    byCause[g.cause] = (byCause[g.cause] || 0) + 1;
    const pair = Array.from(new Set(g.leads.map((l) => (l.importedViaCsv ? "CSV" : l.source || "?")))).sort().join(" + ");
    byPair[pair] = (byPair[pair] || 0) + 1;
    const c = cname.get(String(g.leads[0].company)) || String(g.leads[0].company);
    byCompany[c] = byCompany[c] || { groups: 0, extra: 0 };
    byCompany[c].groups++; byCompany[c].extra += g.leads.length - 1;
  });
  console.log(`\n3) Duplicate PHONE groups: ${groups.length}  →  ${extra} extra (duplicate) lead records`);
  if (groups.length) {
    console.log("   By company:");
    Object.entries(byCompany).sort((a, b) => b[1].extra - a[1].extra).forEach(([c, v]) => console.log(`   ${String(v.groups).padStart(6)} groups / ${v.extra} extra  ${c}`));
    console.log("   Likely cause:");
    Object.entries(byCause).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
    console.log("   Sources that collided:");
    Object.entries(byPair).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
    const fast = groups.filter((g) => g.spanMs < 120000).length;
    console.log(`   Groups created within 2 minutes of each other: ${fast}`);
    console.log("   Examples:");
    groups.slice().sort((a, b) => b.leads.length - a.leads.length).slice(0, 5).forEach((g) => {
      console.log(`   • ${g.phones.join("/")} — ${g.leads.length} leads over ${human(g.spanMs)}: ` + g.leads.map((l) => `"${l.name}" [${l.importedViaCsv ? "CSV" : l.source}]`).join(", "));
    });
  }
  const rows = [];
  groups.forEach((g, gi) => g.leads.forEach((l, i) => rows.push([
    gi + 1, g.phones.join("/"), i === 0 ? "OLDEST (keep?)" : "duplicate", g.cause, cname.get(String(l.company)) || l.company, l._id, l.name,
    l.mobile, l.secondaryPhone || "", l.normalizedPhone || "(missing)", l.source, l.campaign || "", l.status, !!l.importedViaCsv, l.createdAt, human(g.spanMs),
  ])));
  writeCsv("duplicate-phone-groups.csv", ["group", "phone", "role", "likelyCause", "company", "leadId", "name", "mobile", "secondaryPhone", "normalizedPhone", "source", "campaign", "status", "importedViaCsv", "createdAt", "groupSpan"], rows);

  // ── 4. leadgenId duplicates ─────────────────────────────────────────────
  const lg = new Map();
  leads.forEach((l) => { if (typeof l.leadgenId === "string" && l.leadgenId) { const k = `${l.company}|${l.leadgenId}`; if (!lg.has(k)) lg.set(k, []); lg.get(k).push(l); } });
  const lgDup = Array.from(lg.values()).filter((g) => g.length > 1);
  console.log(`\n4) Duplicate Meta/Google lead IDs (leadgenId): ${lgDup.length} groups`);
  writeCsv("duplicate-leadgen-ids.csv", ["leadgenId", "company", "leadId", "name", "mobile", "source", "createdAt"],
    lgDup.flatMap((g) => g.map((l) => [l.leadgenId, cname.get(String(l.company)) || l.company, l._id, l.name, l.mobile, l.source, l.createdAt])));

  // ── 5. Same email, different leads ──────────────────────────────────────
  const em = new Map();
  leads.forEach((l) => {
    const e = String(l.email || "").trim().toLowerCase();
    if (!e || !e.includes("@")) return;
    const k = `${l.company}|${e}`;
    if (!em.has(k)) em.set(k, []);
    em.get(k).push(l);
  });
  const emDup = Array.from(em.values()).filter((g) => g.length > 1);
  const emDiffPhone = emDup.filter((g) => new Set(g.map((l) => normalizePhone(l.mobile) || l.mobile)).size > 1);
  console.log(`\n5) Same email on more than one lead: ${emDup.length} groups (${emDiffPhone.length} with DIFFERENT phones — same person, new number?)`);
  writeCsv("duplicate-emails.csv", ["email", "company", "leadId", "name", "mobile", "source", "createdAt"],
    emDup.flatMap((g) => g.map((l) => [l.email, cname.get(String(l.company)) || l.company, l._id, l.name, l.mobile, l.source, l.createdAt])));

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────────────");
  const idxOk = need.slice(0, 2).every((n) => idx.find((x) => x.name === n && x.unique));
  if (!groups.length && !lgDup.length && idxOk && !missing.length) console.log("VERDICT: ✅ No duplicate leads found and dedup protection is in place.");
  else {
    console.log("VERDICT: ⚠  Duplicates found or protection gaps exist:");
    if (!idxOk) console.log("   • A phone unique index is MISSING → the database is not blocking duplicates.");
    if (missing.length) console.log(`   • ${missing.length} leads have no normalizedPhone → they bypass every duplicate check.`);
    if (groups.length) console.log(`   • ${groups.length} duplicate phone groups (${extra} extra records).`);
    if (lgDup.length) console.log(`   • ${lgDup.length} duplicate leadgenId groups.`);
  }
  console.log(`\nReports written to ${OUT}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (e) => { console.error("❌", e.message); try { await mongoose.disconnect(); } catch (_) { /* ignore */ } process.exit(1); });
}
module.exports = { findPhoneDuplicates, classifyCause };
