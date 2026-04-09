const mongoose = require("mongoose");

const websiteConfigSchema = new mongoose.Schema(
  {
    sourceName:      { type: String, required: true },
    webhookSecret:   { type: String, required: true, unique: true },
    pageUrl:         { type: String, default: "" },
    isActive:        { type: Boolean, default: true },
    defaultStatus:   { type: String, default: "New" },
    defaultRemark:   { type: String, default: "Lead from Website" },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Company",
      required: true,
    },
    roundRobinIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebsiteConfig", websiteConfigSchema);