/**
 * scripts/mergeDuplicateLeads.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Merges EXACT duplicate leads (same company + same primary phone number) the
 * same way the CRM's own "Merge lead" button does:
 *
 *   • keeps ONE survivor per phone number
 *   • folds the duplicates' call history, scheduled follow-ups, meetings and
 *     activity timeline into the survivor
 *   • re-points mobile call logs + WhatsApp conversations to the survivor
 *   • hides the duplicates (mergedInto = survivor, phone freed) — NOTHING is deleted
 *   • sets normalizedPhone on the survivor so the unique index protects it
 *     from now on
 *
 * Survivor = the lead with the most sales activity (calls, meetings,
 * follow-ups, non-default status, assigned salesperson); tie → oldest.
 *
 * Groups that are NOT exact duplicates (number is primary on one lead and
 * secondary on another, or leads carry different second numbers) are only
 * REPORTED for manual review — never auto-merged.
 *
 * Usage (from the backend folder):
 *   node scripts/mergeDuplicateLeads.js                       DRY RUN (default) — writes nothing
 *   node scripts/mergeDuplicateLeads.js --company=<id>        one company only
 *   node scripts/mergeDuplicateLeads.js --limit=20 --apply    merge the first 20 groups (test run)
 *   node scripts/mergeDuplicateLeads.js --apply               merge everything
 *
 * Every --apply run first saves a full JSON backup of every lead it touches to
 * ./duplicate-merge/backup-<timestamp>.json, and writes a CSV of what it did.
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { normalizePhone } = require("../utils/normalizePhone");

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const APPLY = process.argv.includes("--apply");
const COMPANY = arg("company");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const OUT = path.resolve(arg("out") || "./duplicate-merge");

const csvEsc = (v) => { const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const len = (a) => (Array.isArray(a) ? a.length : 0);
const stripId = (arr) => (arr || []).map((d) => { const o = { ...d }; delete o._id; return o; });

// Activity score — the lead sales actually worked on wins.
function score(l, defaultStatuses) {
  let s = 0;
  s += len(l.callHistory) * 10;
  s += len(l.meetingRemarks) * 25;
  s += len(l.scheduledCalls) * 5;
  if (l.status && !defaultStatuses.has(String(l.status).toLowerCase())) s += 30;
  if (l.user) s += 8;
  if (l.temperature) s += 2;
  if (l.normalizedPhone) s += 1;           // already protected by the index
  if (l.dealValue) s += 50;
  return s;
}

// Pure planner (exported for tests): groups → { auto: [...], review: [...] }
function planMerges(leads, defaultStatuses) {
  const byPrimary = new Map();
  const secondaryOwners = new Map();
  for (const l of leads) {
    const p = normalizePhone(l.mobile || l.primaryPhone);
    l._p = p;
    l._s = normalizePhone(l.secondaryPhone);
    if (p) {
      const k = `${l.company}|${p}`;
      if (!byPrimary.has(k)) byPrimary.set(k, []);
      byPrimary.get(k).push(l);
    }
    if (l._s) {
      const k = `${l.company}|${l._s}`;
      if (!secondaryOwners.has(k)) secondaryOwners.set(k, []);
      secondaryOwners.get(k).push(l);
    }
  }
  const auto = [], review = [];
  byPrimary.forEach((group, key) => {
    const secClash = (secondaryOwners.get(key) || []).filter((x) => !group.includes(x));
    if (group.length < 2) {
      if (secClash.length) review.push({ key, leads: group.concat(secClash), reason: "Number is primary on one lead and secondary on another" });
      return;
    }
    const seconds = new Set(group.map((l) => l._s).filter(Boolean));
    if (seconds.size > 1) { review.push({ key, leads: group, reason: "Duplicates carry different second numbers (a lead can hold only 2)" }); return; }
    if (secClash.length) { review.push({ key, leads: group.concat(secClash), reason: "Number is also the secondary number of another lead" }); return; }
    const sorted = group.slice().sort((a, b) => (score(b, defaultStatuses) - score(a, defaultStatuses)) || (new Date(a.createdAt) - new Date(b.createdAt)));
    auto.push({ key, survivor: sorted[0], dups: sorted.slice(1) });
  });
  return { auto, review };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) { console.error("❌ No Mongo connection string (MONGO_URI / MONGODB_URI / DB_URI)."); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const leadsCol = db.collection("leads");
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`✅ Connected — mode: ${APPLY ? "🟠 APPLY (will merge)" : "🟢 DRY RUN (no writes)"}${COMPANY ? ` — company ${COMPANY}` : ""}\n`);

  const match = { mergedInto: null };
  if (COMPANY) match.company = new mongoose.Types.ObjectId(COMPANY);
  const leads = await leadsCol.find(match, {
    projection: { name: 1, mobile: 1, primaryPhone: 1, secondaryPhone: 1, normalizedPhone: 1, company: 1, status: 1, source: 1,
      campaign: 1, user: 1, temperature: 1, createdAt: 1, importedViaCsv: 1, dealValue: 1,
      callHistory: 1, meetingRemarks: 1, scheduledCalls: 1 },
  }).toArray();
  console.log(`Leads scanned: ${leads.length}`);

  const defaultStatuses = new Set(["new", "", "null", "undefined"]);
  const { auto, review } = planMerges(leads, defaultStatuses);
  const dupCount = auto.reduce((s, g) => s + g.dups.length, 0);
  const diffUser = auto.filter((g) => g.dups.some((d) => d.user && String(d.user) !== String(g.survivor.user || ""))).length;
  console.log(`Exact duplicate groups (auto-merge): ${auto.length}  →  ${dupCount} duplicate records to hide`);
  console.log(`   of which assigned to different salespeople: ${diffUser} (survivor's salesperson is kept)`);
  console.log(`Groups needing manual review:        ${review.length}`);
  const srcPairs = {};
  auto.forEach((g) => { const k = Array.from(new Set([g.survivor].concat(g.dups).map((l) => (l.importedViaCsv ? "CSV:" : "") + (l.source || "?")))).sort().join(" + "); srcPairs[k] = (srcPairs[k] || 0) + 1; });
  console.log("Sources in duplicate groups:");
  Object.entries(srcPairs).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));

  // Plan CSVs (always written)
  const planRows = [];
  auto.forEach((g, i) => [g.survivor].concat(g.dups).forEach((l) => planRows.push([
    i + 1, l._p, l === g.survivor ? "KEEP" : "merge → hide", l._id, l.name, l.mobile, l.source, l.importedViaCsv ? "yes" : "", l.status,
    len(l.callHistory), len(l.meetingRemarks), l.user || "", l.createdAt,
  ])));
  fs.writeFileSync(path.join(OUT, `plan-${stamp}.csv`), "\ufeff" + [["group", "phone", "action", "leadId", "name", "mobile", "source", "csvImport", "status", "calls", "meetings", "userId", "createdAt"].join(",")]
    .concat(planRows.map((r) => r.map(csvEsc).join(","))).join("\n"));
  fs.writeFileSync(path.join(OUT, `manual-review-${stamp}.csv`), "\ufeff" + [["phone", "reason", "leadId", "name", "mobile", "secondaryPhone", "source", "status", "createdAt"].join(",")]
    .concat(review.flatMap((g) => g.leads.map((l) => [g.key.split("|")[1], g.reason, l._id, l.name, l.mobile, l.secondaryPhone || "", l.source, l.status, l.createdAt].map(csvEsc).join(",")))).join("\n"));
  console.log(`\nPlan written to ${OUT}/plan-${stamp}.csv`);

  if (!APPLY) {
    console.log("\nDRY RUN complete — nothing changed. Review the plan CSV, then run with --apply (try --limit=20 first).");
    await mongoose.disconnect();
    return;
  }

  const todo = auto.slice(0, LIMIT);
  const touchedIds = todo.flatMap((g) => [g.survivor._id].concat(g.dups.map((d) => d._id)));
  const backup = await leadsCol.find({ _id: { $in: touchedIds } }).toArray();
  const backupFile = path.join(OUT, `backup-${stamp}.json`);
  fs.writeFileSync(backupFile, mongoose.mongo.BSON.EJSON.stringify(backup, { relaxed: false })); // exact types (ObjectId, Date) for restore
  console.log(`\nBackup of ${backup.length} leads saved to ${backupFile}`);
  const full = new Map(backup.map((d) => [String(d._id), d]));

  const now = new Date();
  let merged = 0, failed = 0;
  const done = [];
  for (const g of todo) {
    try {
      const sv = full.get(String(g.survivor._id));
      const dups = g.dups.map((d) => full.get(String(d._id))).filter(Boolean);
      const push = { callHistory: [], scheduledCalls: [], meetingRemarks: [], activityTimeline: [] };
      dups.forEach((d) => {
        push.callHistory.push(...stripId(d.callHistory));
        push.scheduledCalls.push(...stripId(d.scheduledCalls));
        push.meetingRemarks.push(...stripId(d.meetingRemarks));
        push.activityTimeline.push(...stripId(d.activityTimeline));
      });
      const note = `Auto-merged ${dups.length} duplicate lead(s) with the same number (${g.key.split("|")[1]}): ${dups.map((d) => `"${d.name}" [${d.source}]`).join(", ")}.`;
      push.activityTimeline.push({ action: "leads_merged", performedBy: null, role: "system", timestamp: now, note: note });
      const $push = {};
      Object.keys(push).forEach((k) => { if (push[k].length) $push[k] = { $each: push[k] }; });
      const $set = { mergedSourceName: dups.map((d) => d.name).filter(Boolean).slice(0, 3).join(", ") };
      if (!sv.secondaryPhone) { const sec = dups.map((d) => d.secondaryPhone).find(Boolean); if (sec) { $set.secondaryPhone = sec; $set.normalizedSecondaryPhone = normalizePhone(sec); } }
      if (!sv.email) { const em = dups.map((d) => d.email).find(Boolean); if (em) $set.email = em; }

      // 1) Hide duplicates first (frees the number from the unique index)
      await leadsCol.updateMany({ _id: { $in: dups.map((d) => d._id) } }, {
        $set: { mergedInto: sv._id, normalizedPhone: null, normalizedSecondaryPhone: null },
        $push: { activityTimeline: { action: "leads_merged", performedBy: null, role: "system", timestamp: now, note: `This lead was merged into "${sv.name}" (${sv.mobile}) as a duplicate.` } },
      });
      // 2) Survivor gets history + the protected normalizedPhone
      const norm = normalizePhone(sv.mobile || sv.primaryPhone);
      if (norm) $set.normalizedPhone = norm;
      await leadsCol.updateOne({ _id: sv._id }, { $set, ...(Object.keys($push).length ? { $push } : {}) });
      // 3) Re-point call logs + WhatsApp threads
      const dupIds = dups.map((d) => d._id);
      await db.collection("mobilecalllogs").updateMany({ matchedLead: { $in: dupIds } }, { $set: { matchedLead: sv._id } }).catch(() => {});
      await db.collection("whatsappconversations").updateMany({ lead: { $in: dupIds } }, { $set: { lead: sv._id } }).catch(() => {});
      merged++;
      done.push([g.key.split("|")[1], sv._id, sv.name, dupIds.join(" ")]);
    } catch (e) {
      failed++;
      done.push([g.key.split("|")[1], g.survivor._id, g.survivor.name, "FAILED: " + e.message]);
    }
    if ((merged + failed) % 100 === 0) process.stdout.write(`\r  merged ${merged} / failed ${failed}`);
  }
  fs.writeFileSync(path.join(OUT, `applied-${stamp}.csv`), "\ufeff" + [["phone", "survivorId", "survivorName", "hiddenDuplicateIds"].join(",")].concat(done.map((r) => r.map(csvEsc).join(","))).join("\n"));
  console.log(`\n\n✅ Merged ${merged} groups${failed ? `, ❌ ${failed} failed (see applied-${stamp}.csv)` : ""}. Backup: ${backupFile}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (e) => { console.error("❌", e.message); try { await mongoose.disconnect(); } catch (_) { /* ignore */ } process.exit(1); });
}
module.exports = { planMerges, score };
