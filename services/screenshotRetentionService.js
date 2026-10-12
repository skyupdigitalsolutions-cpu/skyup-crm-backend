// services/screenshotRetentionService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Deletes WhatsApp chat screenshot IMAGES after 7 days, for companies that have
// "Auto WhatsApp Screenshot AI" switched on (Developer → Company → Features).
//
// What goes and what stays
//   • The image file is deleted from the company's Cloudinary account and its link is cleared.
//   • Everything the AI extracted from it stays: summary, sentiment, topics, every chat
//     message, and the lead's AI analysis. The UI shows "image deleted after 7 days".
//
// Safety rules
//   • A screenshot that has not been read yet (or is still being read, or can still be
//     retried) is NOT deleted — it is read first, so no information is lost.
//   • A deletion that fails (Cloudinary unreachable) is simply retried at the next sweep.
//   • Deleting an image is housekeeping, not lead activity: it never bumps the lead's
//     "updated" time, so it cannot trigger a new AI analysis.
// Screenshots imported through the Lead Journey importer are not covered here because in
// auto mode they are never stored at all (see controllers/whatsappScreenshotController.js).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Lead = require("../models/Leads");
const { enabledCompanyIds, MAX_ATTEMPTS } = require("./screenshotAutoService");

const DAY = 24 * 3600000;
const RETENTION_DAYS = 7;
const MAX_PER_SWEEP = 50;      // images handled per sweep (it runs hourly)

const idOf = (v) => (v == null ? "" : String(v._id || v));

// Older uploads were saved without the Cloudinary public id — recover it from the URL:
//   https://res.cloudinary.com/<cloud>/image/upload/v123/<folder>/<public_id>.<ext>
function publicIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)cloudinary\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(?:image|video|raw)\/upload\/(.+)$/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]).replace(/^v\d+\//, "").replace(/\.[A-Za-z0-9]+$/, "");
    return id || null;
  } catch (e) {
    return null;
  }
}

// ── Which screenshots are due for deletion? ──────────────────────────────────
// isDeletable() is the readable rule; deletableCriteria() is the same rule as a MongoDB
// $elemMatch filter (the tests prove the two agree on every combination).
function isDeletable(shot, now = Date.now()) {
  if (!shot || shot.deletedAt) return false;
  if (!shot.uploadedAt || now - +new Date(shot.uploadedAt) < RETENTION_DAYS * DAY) return false;
  const chat = shot.chat || {};
  const status = chat.status || null;
  if (status === "done" || status === "unavailable") return true;      // read (or can never be read)
  if (status === "failed") return (chat.attempts || 0) >= MAX_ATTEMPTS; // gave up reading it
  return false;                                                         // never read / still reading → read it first
}

function deletableCriteria(now = Date.now()) {
  return {
    deletedAt: null,
    uploadedAt: { $lt: new Date(now - RETENTION_DAYS * DAY) },
    $or: [
      { "chat.status": "done" },
      { "chat.status": "unavailable" },
      { "chat.status": "failed", "chat.attempts": { $gte: MAX_ATTEMPTS } },
    ],
  };
}

// Delete the file from the company's own Cloudinary account. "not found" counts as success.
async function destroyAsset(companyId, publicId) {
  const { getCloudinaryForCompany } = require("./cloudinaryService");   // lazy
  const { instance } = await getCloudinaryForCompany(idOf(companyId));
  const res = await instance.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  return !!res && (res.result === "ok" || res.result === "not found");
}

// ── The sweep (called hourly by jobs/screenshotRetentionJob.js) ──────────────
async function runScreenshotRetentionSweep() {
  const ids = await enabledCompanyIds();
  if (!ids.length) return { companies: 0, deleted: 0, failed: 0 };

  const now = Date.now();
  const leads = await Lead.find({ company: { $in: ids }, whatsappScreenshots: { $elemMatch: deletableCriteria(now) } })
    .select("_id company whatsappScreenshots._id whatsappScreenshots.url whatsappScreenshots.publicId whatsappScreenshots.uploadedAt whatsappScreenshots.deletedAt whatsappScreenshots.chat.status whatsappScreenshots.chat.attempts")
    .limit(MAX_PER_SWEEP).lean();

  let deleted = 0, failed = 0;
  outer:
  for (const lead of leads) {
    for (const shot of lead.whatsappScreenshots || []) {
      if (!isDeletable(shot, now)) continue;
      if (deleted + failed >= MAX_PER_SWEEP) break outer;

      const publicId = shot.publicId || publicIdFromUrl(shot.url);
      let ok = true;
      if (publicId) {
        try { ok = await destroyAsset(lead.company, publicId); }
        catch (e) { ok = false; console.warn(`[screenshotRetention] could not delete ${publicId}: ${e.message}`); }
      }
      if (!ok) { failed++; continue; }                      // try again at the next sweep

      await Lead.updateOne(
        { _id: lead._id, whatsappScreenshots: { $elemMatch: { _id: shot._id, deletedAt: null } } },
        { $set: { "whatsappScreenshots.$.deletedAt": new Date(), "whatsappScreenshots.$.url": "" } },
        { timestamps: false },                               // housekeeping, not lead activity
      );
      deleted++;
    }
  }
  if (deleted || failed) console.log(`[screenshotRetention] deleted ${deleted} screenshot image(s) older than ${RETENTION_DAYS} days${failed ? `, ${failed} will be retried` : ""}`);
  return { companies: ids.length, deleted, failed };
}

module.exports = { runScreenshotRetentionSweep, isDeletable, deletableCriteria, publicIdFromUrl, destroyAsset, RETENTION_DAYS };
