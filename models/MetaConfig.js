const mongoose = require("mongoose");

const metaConfigSchema = new mongoose.Schema(
  {
    campaignName:    { type: String, required: true },
    pageId:          { type: String, required: true, unique: true },
    pageAccessToken: { type: String, required: true },
    formIds:         [{ type: String }], // empty = accept all forms
    isActive:        { type: Boolean, default: true },

    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // Round-robin: no single assignedUser — leads rotate across all company users
    roundRobinIndex: {
      type:    Number,
      default: 0, // pointer to the next user slot
    },

    defaultStatus: { type: String, default: "New" },
    defaultRemark: { type: String, default: "Lead from Meta Campaign" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MetaConfig", metaConfigSchema);