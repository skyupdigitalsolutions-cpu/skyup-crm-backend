// models/MetaQualification.js
// Stores lead-qualification scoring rules for one Meta Ad Set config.
const mongoose = require("mongoose");

const answerScoreSchema = new mongoose.Schema(
  {
    value: { type: String, default: "" },  // answer text from the Meta form
    score: { type: Number, default: 0 },   // points awarded when this answer is chosen
  },
  { _id: false }
);

const questionRuleSchema = new mongoose.Schema(
  {
    questionKey:   { type: String, required: true }, // field_key from Meta lead-form
    questionLabel: { type: String, default: "" },    // human-readable label shown in UI
    answers:       [answerScoreSchema],
  },
  { _id: false }
);

const metaQualificationSchema = new mongoose.Schema(
  {
    adSetId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "MetaConfig",
      required: true,
      unique:   true,   // one rule-set per ad set
    },
    adSetName: { type: String, default: "" },
    formId:    { type: String, default: "" },
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },
    // Per-question scoring rules
    rules: [questionRuleSchema],
    // Percentage thresholds: score% >= hot → Hot, >= warm → Warm, else → Cold
    thresholds: {
      hot:  { type: Number, default: 70 },
      warm: { type: Number, default: 40 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MetaQualification", metaQualificationSchema);
