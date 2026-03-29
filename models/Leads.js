const mongoose = require("mongoose");

const leadSchema = mongoose.Schema(
  {
    leadgenId: { type: String, default: null, unique: true, sparse: true }, // Meta lead ID for duplicate check
    name: { type: String, required: true, trim: true },
    mobile: { type: String, required: true },
    source: { type: String, required: true, trim: true },
    campaign: { type: String, required: false, default: null },
    status: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    remark: { type: String, required: true, trim: true }, 
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
  },
  { timestamps: true },
);

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;
