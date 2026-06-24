const mongoose = require("mongoose");

// A tiny atomic counter collection. Each document represents one named sequence
// (e.g. "invoice") and holds the last issued value. findOneAndUpdate with $inc
// is atomic at the document level, so concurrent checkouts never collide or skip.
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // sequence name, e.g. "invoice"
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

const Counter = mongoose.model("Counter", counterSchema);
module.exports = Counter;
