// services/outcomeAutomationService.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends a WhatsApp + Email message DIRECTLY TO THE LEAD based on the call
// outcome an agent logs from the mobile "Call Remark" modal (or the web
// equivalent). Triggered fire-and-forget from controllers/leadController.js
// (patchLead) after the lead is updated.
//
// OUTCOMES HANDLED (mapped to a company.outcomeAutomation.<key> config):
//   "Answered"        → answered
//   "Not Answered"    → notAnswered   ┐
//   "Busy"            → busy          ├─ share the "crm_call_missed" template
//   "Switch Off"      → switchOff     ┘  by default (identical lead-facing msg)
//   "Call Back Later" → callBackLater
//   "Not Interested"  → notInterested
//
// OUTCOMES DELIBERATELY IGNORED (so we never double-send):
//   "Interested"     → handled by the existing interestedBlast flow.
//   "Client Meeting" → handled by the existing meeting-reminder flow.
//   "Invalid"        → no automation (usually a wrong/junk number).
//   Anything else / unmapped → ignored silently.
//
// DEDUPE: at most ONE message per lead, per outcome, per calendar day (IST).
//   Claimed atomically via Lead.outcomeAutomationSent (a Map of
//   outcomeKey → "YYYY-M-D"), so concurrent/duplicate saves can't double-fire.
//   The claim is RELEASED if neither channel actually sent (e.g. WhatsApp
//   template not yet approved AND email misconfigured), so a genuine send can
//   still succeed later that same day once the config is fixed.
//
// Reuses the exact WhatsApp (MSG91/Meta) + Email (MSG91→Brevo) senders already
// used by new-lead and Interested blasts — no duplicated provider logic.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const Lead    = require("../models/Leads");
const Company = require("../models/Company");
const { sendAutoWhatsApp, sendAutoEmail } = require("./autoTemplateService");

const IST_TIMEZONE = "Asia/Kolkata";

// Normalised outcome string → company.outcomeAutomation config key.
// Only these outcomes are handled; every other outcome returns undefined and
// is silently ignored (Interested / Client Meeting / Invalid / etc.).
const OUTCOME_KEY = {
  // ── Mobile app "Call Remark" modal outcomes ──────────────────────────────
  "answered":        "answered",
  "not answered":    "notAnswered",
  "busy":            "busy",
  "switch off":      "switchOff",
  "call back later": "callBackLater",
  "not interested":  "notInterested",
  // ── Web "Update Lead" panel outcomes (UserDashboard / UserLeadsPage) ──────
  // These come from a different dropdown than the mobile app, so they need
  // their own entries. "Call Back" and "Not Reachable" reuse the existing
  // crm_call_back_later / crm_call_missed templates (same lead-facing intent);
  // the rest use their own templates (see Company.outcomeAutomation).
  // NOTE: web "Interested" is handled by the existing Interested blast, and
  // web "Not Interested" uses the separate /not-interested reassign flow —
  // so neither is mapped here (avoids double-send).
  "call back":         "callBack",
  "not reachable":     "notReachable",
  "meeting scheduled": "meetingScheduled",
  "demo done":         "demoDone",
  "converted":         "converted",
};

// ── IST calendar-day key, e.g. "2026-7-3" — for once-per-day dedupe ─────────
function istDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendOutcomeAutomation(lead, companyId, outcome)
//   • lead      — the (updated) lead document or lean object; needs _id, name,
//                 mobile, email.
//   • companyId — the lead's company id.
//   • outcome   — the raw outcome string as sent by the client.
// Never throws. Returns { skipped } or { outcome, results } for logging/tests.
// ─────────────────────────────────────────────────────────────────────────────
async function sendOutcomeAutomation(lead, companyId, outcome) {
  try {
    if (!lead || !companyId || typeof outcome !== "string") {
      return { skipped: "missing lead / companyId / outcome" };
    }

    const key = OUTCOME_KEY[outcome.trim().toLowerCase()];
    if (!key) {
      // Interested / Client Meeting / Invalid / unknown — not handled here.
      return { skipped: `outcome "${outcome}" is not handled by outcomeAutomation` };
    }

    // ── Only CAMPAIGN leads get the "Not Answered" reminder ───────────────────
    // Per requirement: the crm_call_missed template on the "Not Answered"
    // outcome should fire ONLY for campaign leads (Meta / Website / Google Ads /
    // etc.). It must be SKIPPED for:
    //   • CSV/Excel-imported leads  → importedViaCsv === true (or source "Excel Import")
    //   • Manually-added leads (Add Lead button) → addedManually === true (or source "Manual")
    // Only this one outcome is affected — every other outcome still fires for
    // these leads. We check the passed lead first (fast path) and fall back to a
    // tiny DB read so leads created BEFORE these flags existed (carrying only
    // source "Excel Import" / "Manual") are also correctly excluded.
    if (key === "notAnswered") {
      const isExcluded = (l) =>
        !!l && (
          l.importedViaCsv === true ||
          l.addedManually  === true ||
          l.source === "Excel Import" ||
          l.source === "Manual"
        );
      let excluded = isExcluded(lead);
      if (!excluded && lead._id) {
        try {
          const src = await Lead.findById(lead._id).select("importedViaCsv addedManually source").lean();
          excluded = isExcluded(src);
        } catch (_) { /* if the lookup fails, fall through and treat as campaign lead */ }
      }
      if (excluded) {
        return { skipped: `lead ${lead._id} is CSV-imported or manually added — "Not Answered" automation only fires for campaign leads` };
      }
    }

    // NOTE: intentionally NOT using .lean() here. Mongoose does not apply
    // schema defaults to lean() results, and there is no admin UI that saves
    // `outcomeAutomation` to the DB (this automation is backend-only). Fetching
    // a hydrated document makes Mongoose materialise the schema defaults even
    // for company docs that predate this field, and .toObject() then gives us
    // plain values (with defaults applied) to read and pass downstream — so the
    // automation works out of the box with no DB migration or "Save" step.
    const companyDoc = await Company.findById(companyId).select("outcomeAutomation name");
    if (!companyDoc) return { skipped: "company not found" };
    const company = companyDoc.toObject();

    const cfg = company.outcomeAutomation && company.outcomeAutomation[key];
    if (!cfg) return { skipped: `no outcomeAutomation config for "${key}"` };

    const waOn = !!cfg.whatsapp?.enabled;
    const emOn = !!cfg.email?.enabled;
    if (!waOn && !emOn) {
      return { skipped: `both channels disabled for "${key}"` };
    }

    // ── Atomic once-per-lead-per-outcome-per-day claim ────────────────────────
    const todayKey = istDayKey();
    const fieldPath = `outcomeAutomationSent.${key}`;
    const claimed = await Lead.findOneAndUpdate(
      { _id: lead._id, [fieldPath]: { $ne: todayKey } },
      { $set: { [fieldPath]: todayKey } },
      { new: true }
    );
    if (!claimed) {
      console.log(`[outcomeAutomation] Skipped "${key}" for lead ${lead._id} — already sent today.`);
      return { skipped: `already sent "${key}" today` };
    }

    const results = [];

    if (waOn) {
      if (lead.mobile) {
        const r = await sendAutoWhatsApp({
          companyId,
          lead,
          whatsappSettings: cfg.whatsapp,
        }).catch((err) => ({ channel: "whatsapp", status: "failed", detail: err.message }));
        results.push(r);
      } else {
        results.push({ channel: "whatsapp", status: "skipped", detail: "Lead has no mobile number" });
      }
    }

    if (emOn) {
      if (lead.email) {
        const r = await sendAutoEmail({
          companyId,
          lead,
          emailSettings: cfg.email,
        }).catch((err) => ({ channel: "email", status: "failed", detail: err.message }));
        results.push(r);
      } else {
        results.push({ channel: "email", status: "skipped", detail: "Lead has no email address" });
      }
    }

    // If NOTHING actually sent, release the day-claim so a fixed config can
    // retry later today (mirrors the interestedBlast release-on-failure logic).
    const anySent = results.some((r) => r && r.status === "sent");
    if (!anySent) {
      await Lead.updateOne(
        { _id: lead._id },
        { $unset: { [fieldPath]: "" } }
      ).catch(() => {});
    }

    console.log(
      `[outcomeAutomation] outcome="${outcome}" (key=${key}) lead ${lead._id} ("${lead.name}"):`,
      JSON.stringify(results)
    );
    return { outcome, key, results };
  } catch (err) {
    console.error("[outcomeAutomation] error:", err.message);
    return { skipped: err.message };
  }
}

module.exports = { sendOutcomeAutomation, OUTCOME_KEY };