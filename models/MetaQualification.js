// models/MetaQualification.js
// Stores lead qualification rules for a specific Meta Ad Set (MetaConfig).
// One document per MetaConfig._id.
const mongoose = require("mongoose");

const answerScoreSchema = new mongoose.Schema(
  {
    value: { type: String, default: "" },  // the answer text
    score: { type: Number, default: 0 },   // points awarded if answer matches
  },
  { _id: false }
);

const questionRuleSchema = new mongoose.Schema(
  {
    questionKey:   { type: String, required: true }, // field key from Meta form
    questionLabel: { type: String, default: "" },    // human-readable label
    answers:       { type: [answerScoreSchema], default: [] },
  },
  { _id: false }
);

const metaQualificationSchema = new mongoose.Schema(
  {
    // The MetaConfig (ad set) this ruleset belongs to
    adSetConfig: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "MetaConfig",
      required: true,
      unique:   true,   // one qualification ruleset per ad set
    },

    adSetName: { type: String, default: "" },
    formId:    { type: String, default: "" },

    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // Per-question scoring rules
    rules: { type: [questionRuleSchema], default: [] },

    // Hot/Warm percentage thresholds (0-100)
    // Score >= hot%   → Hot
    // Score >= warm%  → Warm
    // Score <  warm%  → Cold
    thresholds: {
      hot:  { type: Number, default: 70, min: 0, max: 100 },
      warm: { type: Number, default: 40, min: 0, max: 100 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MetaQualification", metaQualificationSchema);
