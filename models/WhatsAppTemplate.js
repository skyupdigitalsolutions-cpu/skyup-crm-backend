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
const { encryptedFieldsPlugin, hmac } = require("../utils/fieldCrypto");

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
    // Deterministic HMAC of integratedNumber — used for the sync upsert filter
    // and any future lookup by value, now that integratedNumber itself is
    // encrypted at rest with a random IV (so the same number never produces
    // the same ciphertext twice and can't be matched by equality directly).
    // Computed automatically from plaintext by the hooks below. The sync path
    // (services/msg91TemplateService.js) uses Model.bulkWrite(), which bypasses
    // Mongoose middleware entirely — so that service also sets this field (and
    // encrypts integratedNumber) explicitly; the hooks here are a safety net
    // for any other write path (e.g. a future admin edit endpoint).
    integratedNumberHash: { type: String, default: null, index: true },

    language: { type: String, default: "en", trim: true },
    category: { type: String, default: "", trim: true }, // MARKETING | UTILITY | AUTHENTICATION
    status:   { type: String, default: "", trim: true }, // APPROVED | PENDING | REJECTED

    // Exactly what MSG91 sent for status, e.g. "status=Enabled" — shown in the
    // UI so you can see the source value, not just our interpretation of it.
    rawStatusField: { type: String, default: "", trim: true },

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
// Uniqueness now lives on integratedNumberHash instead of the plaintext
// integratedNumber — see the field comment above for why.
whatsAppTemplateSchema.index(
  { company: 1, name: 1, integratedNumberHash: 1 },
  { unique: true }
);

// Fast lookup for the nurture job: "does this exact template exist & approved?"
whatsAppTemplateSchema.index({ company: 1, isNurtureTemplate: 1, funnelStage: 1 });

// ── Compute integratedNumberHash BEFORE encryption runs ───────────────────────
// Registered before encryptedFieldsPlugin below so it always sees the
// PLAINTEXT value — hook order follows registration order in Mongoose.
// NOTE: this does NOT fire for Model.bulkWrite() (the sync path uses it) —
// bulkWrite bypasses all schema middleware. msg91TemplateService.js computes
// the hash and encrypts the value itself for that reason.
// Zero-arity (no `next` param) is deliberate — see models/AccessAuditLog.js:
// a callback-style `function (next) { ...; next(); }` pre-save hook can
// silently fail with "next is not a function" on this Mongoose 9 setup.
whatsAppTemplateSchema.pre("save", function () {
  if (this.isModified("integratedNumber") && this.integratedNumber) {
    this.integratedNumberHash = hmac(this.integratedNumber);
  }
});

function computeIntegratedNumberHashOnUpdate() {
  const update = this.getUpdate();
  if (!update) return;
  const val = (update.$set && update.$set.integratedNumber !== undefined)
    ? update.$set.integratedNumber
    : update.integratedNumber;
  if (val) {
    if (!update.$set) update.$set = {};
    update.$set.integratedNumberHash = hmac(val);
  }
}
whatsAppTemplateSchema.pre("findOneAndUpdate", computeIntegratedNumberHashOnUpdate);
whatsAppTemplateSchema.pre("updateOne",        computeIntegratedNumberHashOnUpdate);
whatsAppTemplateSchema.pre("updateMany",       computeIntegratedNumberHashOnUpdate);

// Encrypt integratedNumber at rest (random IV) — display-only, decrypted on
// read. Registered AFTER the hash-computing hooks above so they see plaintext.
whatsAppTemplateSchema.plugin(encryptedFieldsPlugin, { fields: ["integratedNumber"] });

module.exports = mongoose.model("WhatsAppTemplate", whatsAppTemplateSchema);