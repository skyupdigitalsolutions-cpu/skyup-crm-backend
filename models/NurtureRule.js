// models/NurtureRule.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// A single "if this lead has been sitting like THIS for THIS long, nudge it"
// rule. Rules are evaluated by jobs/nurtureSequenceJob.js, once daily, ONLY
// for companies with devOverrides.featureToggles.leadNurtureSequence = true
// (see services/entitlementService.js). This is intentionally a separate
// collection from Company.outcomeAutomation because that system is
// event-triggered (fires once, right after an agent logs an outcome) while
// this one is time-triggered (fires because N days passed with no movement,
// regardless of what the agent last logged).
//
// Reuses the exact same WhatsApp (MSG91/Meta) + Email (MSG91→Brevo) senders
// as outcomeAutomationService.js / followUpReminderJob.js via
// services/autoTemplateService.js — no new provider logic.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const nurtureRuleSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true }, // shown in admin UI, e.g. "Cold lead re-engage — Day 3"

    enabled: { type: Boolean, default: true },

    // ── Trigger basis (all conditions must match — AND) ─────────────────────
    trigger: {
      // Only fire for leads currently in one of these statuses. Empty array = any.
      statuses: { type: [String], default: [] }, // e.g. ["In Progress", "Interested"]

      // Only fire for leads currently at one of these temperatures. Empty = any.
      temperatures: {
        type: [String],
        enum: ["Hot", "Warm", "Cold"],
        default: [],
      },

      // Minimum days since the lead's last touch (last callHistory entry, or
      // lead.date if no calls logged yet) before this rule is eligible.
      minDaysSinceLastTouch: { type: Number, required: true, min: 0 },

      // Only fire while there's still a pending (not done) follow-up call
      // scheduled — set true for "nudge only if a follow-up is overdue".
      requirePendingFollowUp: { type: Boolean, default: false },

      // Sources this rule applies to. Empty = all EXCEPT manual/import
      // (mirrors the guard already in outcomeAutomationService.js so manually
      // added / CSV-imported leads aren't spammed by default).
      sources: { type: [String], default: [] },
      includeManualOrImported: { type: Boolean, default: false },

      // ── Domain-wise filter ────────────────────────────────────────────────
      // Only fire for leads whose Lead.industry is in this list. Empty = any
      // industry (including leads with no industry tag at all).
      // Values must match utils/templateNameResolver.js INDUSTRIES.
      //
      // NOTE: this field previously existed only in the admin UI — the schema
      // was missing it, so Mongoose silently discarded whatever the frontend
      // sent and the filter never actually applied. Adding it here makes the
      // chips in the nurture builder take effect.
      industries: { type: [String], default: [] },
    },

    // ── Action ────────────────────────────────────────────────────────────
    action: {
      whatsapp: {
        enabled: { type: Boolean, default: true },
        // Default/fallback template — used when templateVariations is empty.
        templateName: { type: String, default: "" }, // must exist & be approved in MSG91

        // Sequential variation pool — V1 through V5 template names in order.
        // The job picks the next unused variation per lead per stage, resetting
        // to V1 whenever the lead moves to a new status stage.
        // e.g. ["real_estate_crm_awareness_v1", ..., "real_estate_crm_awareness_v5"]
        templateVariations: { type: [String], default: [] },

        // Which CRM status this rule's stage corresponds to — used to detect
        // when a lead has moved to a new stage so the variation index resets.
        // e.g. "New" for Awareness, "In Progress" for Interest, etc.
        statusStage: { type: String, default: "" },

        // ── Auto-resolved templates (the 1,760-template library) ────────────
        // When true, templateVariations is IGNORED and the template name is
        // computed per-lead at send time from the lead's own industry+service:
        //   slug(industry)_slug(service)_<funnelStage>_v<n>
        // This is what makes 1,760 templates usable with 4 rules per company
        // instead of 352. See utils/templateNameResolver.js.
        //
        // If a lead is missing industry or service, the job falls back to
        // templateVariations / templateName rather than guessing a vertical.
        autoResolveTemplate: { type: Boolean, default: false },

        // Which funnel stage this rule represents — becomes part of the
        // resolved template name. Only used when autoResolveTemplate is true.
        funnelStage: {
          type: String,
          enum: ["", "awareness", "interest", "desire", "action"],
          default: "",
        },

        // How many variations exist per stage in the approved library (V1–V5).
        // The job cycles V1→V2→…→V{n}→V1 and resets to V1 on stage change.
        variationCount: { type: Number, default: 5, min: 1, max: 10 },

        // Per-status overrides — kept for backward compatibility.
        templatesByStatus: { type: Map, of: String, default: () => ({}) },
        languageCode: { type: String, default: "en" },
      },
      email: {
        enabled: { type: Boolean, default: false },
        subject: { type: String, default: "" },
        fromName: { type: String, default: "" },
        bodyTemplate: { type: String, default: "" }, // supports {{name}}
      },
      // If true, also pings the assigned agent (internal notification) rather
      // than / in addition to messaging the lead directly. Uses the existing
      // fcmService — see jobs/nurtureSequenceJob.js.
      notifyAgent: { type: Boolean, default: false },
      notifyAgentMessage: { type: String, default: "" },
    },

    // Re-fire cadence once triggered once — e.g. re-nudge every 3 days if the
    // lead is STILL stuck in the same state. null = fire once only per lead.
    repeatEveryDays: { type: Number, default: null, min: 1 },
  },
  { timestamps: true }
);

nurtureRuleSchema.index({ company: 1, enabled: 1 });

module.exports = mongoose.model("NurtureRule", nurtureRuleSchema);