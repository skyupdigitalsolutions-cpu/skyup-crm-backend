// models/TermsAndConditions.js
// ─────────────────────────────────────────────────────────────────────────────
// Stores the platform Terms & Conditions as VERSIONED documents.
//
// Every time the terms are updated, a NEW document with an incremented `version`
// is published and the previous one is marked isActive:false. Acceptance is
// tracked per-version (see TermsAcceptance), so publishing a new version
// automatically re-prompts every user the next time they log in — that is what
// satisfies the "when terms are updated, ask again" requirement.
//
// Content is stored as an ordered array of sections so the frontend can render
// it cleanly (heading + body) without parsing HTML. `effectiveDate` is the
// human-facing date shown at the top of the document.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");

const sectionSchema = new mongoose.Schema(
  {
    heading: { type: String, default: "" }, // e.g. "1. Acceptance of Terms"
    body:    { type: String, default: "" }, // paragraph text
  },
  { _id: false }
);

const termsSchema = new mongoose.Schema(
  {
    // Monotonically increasing. v1 is the first published set.
    version: { type: Number, required: true, unique: true, index: true },

    title:         { type: String, default: "Terms & Conditions" },
    effectiveDate: { type: String, default: "" }, // free-text date string shown to users

    // Ordered content. intro = paragraph(s) before section 1.
    intro:    { type: String, default: "" },
    sections: { type: [sectionSchema], default: [] },

    // Only ONE document should ever have isActive:true at a time.
    isActive: { type: Boolean, default: false, index: true },

    publishedAt: { type: Date, default: Date.now },
    // Which developer published it (Developer._id). Optional.
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Developer", default: null },
  },
  { timestamps: true }
);

const TermsAndConditions = mongoose.model("TermsAndConditions", termsSchema);
module.exports = TermsAndConditions;
