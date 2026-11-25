// models/FinanceCredential.js — Finance dashboard → Credentials vault.
// Logins for the company's own tools, client accounts it manages, and employee
// work logins. Secrets (password, apiKey, secretNotes) are stored ENCRYPTED
// (AES-256-GCM via utils/fieldCrypto, "v1:…") and only ever decrypted for a
// single, logged "Reveal" — never in a list.
const mongoose = require("mongoose");

const revealSchema = new mongoose.Schema({
  field:  { type: String, enum: ["password", "apiKey", "secretNotes"], required: true },
  byName: { type: String, default: "" },
  byId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  at:     { type: Date, default: Date.now },
}, { _id: false });

const financeCredentialSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    kind:    { type: String, enum: ["tool", "client", "employee"], required: true },   // our tools · client accounts · employee logins
    name:    { type: String, required: true, trim: true, maxlength: 120 },          // "AWS root", "Meta Ads — GC Traders", "Anu — Google Workspace"
    service: { type: String, default: "", trim: true, maxlength: 80 },              // AWS, MSG91, Meta Business, Shopify, Gmail…
    url:      { type: String, default: "", trim: true, maxlength: 400 },
    username: { type: String, default: "", trim: true, maxlength: 200 },            // shown in the list (not secret)
    // ── encrypted ──
    password:    { type: String, default: "" },
    apiKey:      { type: String, default: "" },
    secretNotes: { type: String, default: "" },                                     // 2FA backup codes, recovery answers…
    // ── plain context ──
    notes:       { type: String, default: "", trim: true, maxlength: 1000 },        // non-secret: who owns it, 2FA on whose phone
    clientName:  { type: String, default: "", trim: true, maxlength: 160 },         // kind = client
    employee:    { type: mongoose.Schema.Types.ObjectId, ref: "FinanceEmployee", default: null },   // kind = employee
    employeeName:{ type: String, default: "", trim: true, maxlength: 120 },
    tool:        { type: mongoose.Schema.Types.ObjectId, ref: "FinanceTool", default: null },       // optional link to Tools
    expiresOn:   { type: Date, default: null },                                     // renewal / password-expiry reminder
    passwordChangedAt: { type: Date, default: null },
    revealLog:   { type: [revealSchema], default: [] },                            // last 200 reveals
    revealCount: { type: Number, default: 0 },
    createdByName: { type: String, default: "" },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);
financeCredentialSchema.index({ company: 1, kind: 1, name: 1 });

module.exports = mongoose.model("FinanceCredential", financeCredentialSchema);
