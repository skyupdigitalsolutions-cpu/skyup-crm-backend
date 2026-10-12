// services/screenshotAutoService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Automatic WhatsApp-screenshot processing for companies that have it switched on
// (Developer panel → Company → Features → "Auto WhatsApp Screenshot AI").
//
// For those companies, with nobody clicking anything:
//   1. every screenshot uploaded to a lead is READ by AI (messages, summary,
//      sentiment, topics) and saved on the lead;
//   2. the lead's AI ANALYSIS is queued as soon as new screenshot data exists;
//   3. a background sweep (jobs/screenshotAutoJob.js) catches everything that was
//      missed — screenshots uploaded before the switch was turned on, reads that
//      failed or got stuck — so ALL screenshots end up read and analysed.
//
// Cost control: at most MAX_READS_PER_TICK screenshots are read per sweep, a
// failed read is retried at most MAX_ATTEMPTS times, and the analysis queue keeps
// its existing batch limit.
//
// This file also owns readScreenshotChat() (moved here from
// controllers/meetingRemarkController.js so the job can use it without a circular
// import). Behaviour for companies WITHOUT the switch is unchanged: a fresh upload
// is still read in the background, as before.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Lead    = require("../models/Leads");
const Company = require("../models/Company");

const MAX_READS_PER_TICK    = 5;     // screenshots read per sweep (OpenAI vision cost control)
const MAX_ANALYSES_PER_TICK = 10;    // leads queued for analysis per sweep (the analysis job has its own batch cap too)
const STUCK_PENDING_MIN     = 10;    // a read still "pending" after this long is considered lost
const RETRY_AFTER_MIN       = 30;    // wait this long before retrying a failed read
const MAX_ATTEMPTS          = 3;     // give up on a screenshot after this many failed reads

// ── Is the feature on for this company? ──────────────────────────────────────
async function isAutoEnabled(companyId) {
  try {
    if (!companyId) return false;
    const { getCompanyEntitlements } = require("./entitlementService");
    const ent = await getCompanyEntitlements(String(companyId));
    return !!ent && ent.autoScreenshotAI === true;
  } catch (e) {
    return false;
  }
}

// ── Which screenshots still need reading? ────────────────────────────────────
// needsRead() is the readable rule; unreadCriteria() is the same rule as a MongoDB
// $elemMatch filter (the tests prove the two agree on every combination).
function needsRead(shot, now = Date.now()) {
  const chat = (shot && shot.chat) || {};
  const status = chat.status || null;
  if (status === "done" || status === "unavailable") return false;
  if (status === null) return true;                                   // never read
  const last = chat.lastTriedAt ? +new Date(chat.lastTriedAt) : (shot.uploadedAt ? +new Date(shot.uploadedAt) : 0);
  if (status === "pending") return now - last >= STUCK_PENDING_MIN * 60000;
  if (status === "failed")  return (chat.attempts || 0) < MAX_ATTEMPTS && now - last >= RETRY_AFTER_MIN * 60000;
  return false;
}

function unreadCriteria(now = Date.now()) {
  const stuck = new Date(now - STUCK_PENDING_MIN * 60000);
  const retry = new Date(now - RETRY_AFTER_MIN * 60000);
  return {
    $or: [
      { "chat.status": null },                                        // null also matches a missing chat / status
      { "chat.status": "pending", $or: [{ "chat.lastTriedAt": { $lt: stuck } }, { "chat.lastTriedAt": null, uploadedAt: { $lt: stuck } }] },
      { "chat.status": "failed", "chat.attempts": { $not: { $gte: MAX_ATTEMPTS } },
        $or: [{ "chat.lastTriedAt": { $lt: retry } }, { "chat.lastTriedAt": null, uploadedAt: { $lt: retry } }] },
    ],
  };
}

// Read but never analysed
const unanalysedCriteria = () => ({ "chat.status": "done", "chat.analysisQueuedAt": null });

// ── Queue the lead's AI analysis because of new screenshot data ──────────────
async function queueAnalysis(leadId, companyId) {
  const { enqueueLeadAnalysis } = require("../jobs/leadAIAnalysisJob");   // lazy: avoids load-order issues
  await enqueueLeadAnalysis(leadId, companyId, "screenshot");
  // Remember it, so the sweep doesn't queue the same screenshots again
  await Lead.updateOne(
    { _id: leadId },
    { $set: { "whatsappScreenshots.$[s].chat.analysisQueuedAt": new Date() } },
    { arrayFilters: [{ "s.chat.status": "done", "s.chat.analysisQueuedAt": null }], timestamps: false },   // bookkeeping, not lead activity
  ).catch((e) => console.warn("[screenshotAuto] stamp failed:", e.message));
}

// ── Read one screenshot's chat with AI (GPT-4o vision) ───────────────────────
// Stores { status, summary, sentiment, keyTopics, messages } on the screenshot.
// Never throws: failures are recorded on the screenshot so they can be retried.
// opts.companyId — when given and the company has auto mode on, the lead's AI
// analysis is queued as soon as the read succeeds.
async function readScreenshotChat(leadId, shotId, imageUrl, opts = {}) {
  // Update by array position, guarded so the element at that position must
  // still be THIS screenshot (works on MongoDB and MongoDB-compatible stores).
  const set = async (chat) => {
    try {
      const doc = await Lead.findOne({ _id: leadId })
        .select("whatsappScreenshots._id whatsappScreenshots.chat.attempts whatsappScreenshots.chat.analysisQueuedAt").lean();
      const arr = (doc && doc.whatsappScreenshots) || [];
      const idx = arr.findIndex((s) => String(s._id) === String(shotId));
      if (idx < 0) return;
      const prev = arr[idx].chat || {};
      const merged = Object.assign({}, chat, {
        attempts: (prev.attempts || 0) + 1,
        lastTriedAt: new Date(),
        analysisQueuedAt: prev.analysisQueuedAt || null,
      });
      await Lead.updateOne(
        { _id: leadId, [`whatsappScreenshots.${idx}._id`]: shotId },
        { $set: { [`whatsappScreenshots.${idx}.chat`]: merged } },
      );
    } catch (e) {
      console.warn("[screenshot chat] save failed:", e.message);
    }
  };

  if (!process.env.OPENAI_API_KEY) {
    await set({ status: "unavailable", error: "Chat reading isn't set up on the server (OPENAI_API_KEY missing).", messages: [], keyTopics: [] });
    return null;
  }
  try {
    const { extractFromVision } = require("../controllers/whatsappScreenshotController");
    const raw = await extractFromVision(imageUrl);
    const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
    const chat = {
      status:    "done",
      summary:   clip(raw && raw.summary, 1000),
      sentiment: clip(raw && raw.customerSentiment, 20).toUpperCase(),
      keyTopics: (Array.isArray(raw && raw.keyTopics) ? raw.keyTopics : []).slice(0, 10).map((t) => clip(t, 60)),
      messages:  (Array.isArray(raw && raw.messages) ? raw.messages : []).slice(0, 200).map((m) => ({
        direction:   m && m.direction === "outbound" ? "outbound" : "inbound",
        text:        clip(m && m.text, 2000),
        time:        clip(m && m.time, 20),
        date:        clip(m && m.date, 30),
        messageType: clip((m && m.messageType) || "text", 20),
      })),
      error:  "",
      readAt: new Date(),
    };
    if (!chat.messages.length && !chat.summary) {
      chat.status = "failed";
      chat.error = "No chat messages could be read from this image.";
    }
    await set(chat);
    if (chat.status === "done" && opts.companyId && (await isAutoEnabled(opts.companyId))) {
      await queueAnalysis(leadId, opts.companyId);
    }
    return chat;
  } catch (err) {
    const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) || (err && err.message) || "Reading failed";
    await set({ status: "failed", error: String(msg).slice(0, 300), messages: [], keyTopics: [] });
    return null;
  }
}

// Claim a screenshot before reading it, so two server instances never read the same one.
async function claimScreenshot(leadId, shotId, now = Date.now()) {
  const r = await Lead.updateOne(
    { _id: leadId, whatsappScreenshots: { $elemMatch: Object.assign({ _id: shotId }, unreadCriteria(now)) } },
    { $set: { "whatsappScreenshots.$.chat.status": "pending", "whatsappScreenshots.$.chat.lastTriedAt": new Date() } },
    { timestamps: false },   // bookkeeping, not lead activity
  );
  return !!(r && (r.modifiedCount === 1 || r.nModified === 1));
}

async function enabledCompanyIds() {
  const rows = await Company.find({
    isActive: { $ne: false },
    "devOverrides.featureToggles.autoScreenshotAI": true,
  }).select("_id").lean();
  return rows.map((r) => r._id);
}

// ── The sweep (called every few minutes by jobs/screenshotAutoJob.js) ────────
async function runAutoScreenshotBatch() {
  if (!process.env.OPENAI_API_KEY) return { skipped: "no OPENAI_API_KEY" };
  const ids = await enabledCompanyIds();
  if (!ids.length) return { companies: 0, read: 0, queued: 0 };

  const now = Date.now();
  let read = 0, queued = 0;

  // A) screenshots that were never read, got stuck, or failed
  const candidates = await Lead.find({ company: { $in: ids }, whatsappScreenshots: { $elemMatch: unreadCriteria(now) } })
    .select("_id company whatsappScreenshots._id whatsappScreenshots.url whatsappScreenshots.uploadedAt whatsappScreenshots.chat.status whatsappScreenshots.chat.attempts whatsappScreenshots.chat.lastTriedAt")
    .limit(MAX_READS_PER_TICK * 3).lean();
  outer:
  for (const lead of candidates) {
    for (const shot of lead.whatsappScreenshots || []) {
      if (!needsRead(shot, now)) continue;
      if (read >= MAX_READS_PER_TICK) break outer;
      if (!(await claimScreenshot(lead._id, shot._id, now))) continue;
      read++;
      await readScreenshotChat(lead._id, shot._id, shot.url, { companyId: lead.company });
    }
  }

  // B) leads whose screenshots were read (maybe long ago) but whose AI analysis was never queued
  const toAnalyse = await Lead.find({ company: { $in: ids }, whatsappScreenshots: { $elemMatch: unanalysedCriteria() } })
    .select("_id company").limit(MAX_ANALYSES_PER_TICK).lean();
  for (const lead of toAnalyse) {
    await queueAnalysis(lead._id, lead.company);
    queued++;
  }

  if (read || queued) console.log(`[screenshotAuto] read ${read} screenshot(s), queued analysis for ${queued} lead(s)`);
  return { companies: ids.length, read, queued };
}

module.exports = {
  isAutoEnabled, readScreenshotChat, queueAnalysis, runAutoScreenshotBatch,
  needsRead, unreadCriteria, unanalysedCriteria, claimScreenshot,
  MAX_READS_PER_TICK, MAX_ATTEMPTS,
};
