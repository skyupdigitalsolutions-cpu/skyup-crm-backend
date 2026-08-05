// models/WhatsAppTemplate.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Local cache of the WhatsApp templates that actually exist and are APPROVED
// in MSG91, synced via services/msg91TemplateService.js.
//
// WHY CACHE THEM
//   1. The nurture builder can show a real dropdown instead of asking an admin
//      to type one of 1,760 template names by hand.
//   2. jobs/nurtureSequenceJob.js can VERIFY a resolved name exists before
//      sending, so a typo or a missing vertical fails quietly in our logs
//      instead of being rejected by Meta after the fact.
//   3. Avoids hitting the MSG91 API on every send.
//
// Synced templates are matched to the nurture library by parsing their name:
//   <industry>_<service>_<stage>_v<n>  →  interior_designers_crm_action_v5
// Templates that don't match that shape are still stored (so the dropdown can
// show legacy ones like crm_followup_leads) but have isNurtureTemplate=false.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const whatsAppTemplateSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    // Exact template name as it exists in MSG91 / Meta.
    name: { type: String, required: true, trim: true, index: true },

    // The WhatsApp sender this template belongs to (MSG91 integrated number).
    integratedNumber: { type: String, default: "", trim: true },

    language: { type: String, default: "en", trim: true },
    category: { type: String, default: "", trim: true }, // MARKETING | UTILITY | AUTHENTICATION
    status:   { type: String, default: "", trim: true }, // APPROVED | PENDING | REJECTED

    // How many {{n}} body variables this template declares. Critical: Meta
    // rejects a send whose parameter count doesn't match, so the sender uses
    // this to decide whether to attach body_2.
    bodyVariableCount: { type: Number, default: 0 },

    // ── Parsed nurture-library metadata (empty for non-nurture templates) ────
    isNurtureTemplate: { type: Boolean, default: false, index: true },
    industrySlug: { type: String, default: "", trim: true, index: true },
    serviceSlug:  { type: String, default: "", trim: true, index: true },
    funnelStage:  { type: String, default: "", trim: true, index: true },
    variation:    { type: Number, default: 0 },

    // Raw payload from MSG91, kept for debugging when a template behaves
    // unexpectedly (e.g. unexpected component shape).
    raw: { type: mongoose.Schema.Types.Mixed, default: null },

    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One row per template name per company per sender number.
whatsAppTemplateSchema.index(
  { company: 1, name: 1, integratedNumber: 1 },
  { unique: true }
);

// Fast lookup for the nurture job: "does this exact template exist & approved?"
whatsAppTemplateSchema.index({ company: 1, isNurtureTemplate: 1, funnelStage: 1 });

module.exports = mongoose.model("WhatsAppTemplate", whatsAppTemplateSchema);