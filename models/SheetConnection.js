// models/SheetConnection.js — NEW
// ─────────────────────────────────────────────────────────────────────────────
// Employee-specific Excel / Google Sheet connection.
//
// COMPLETELY SEPARATE from Daily Report / Telegram / campaign reporting. This is
// the employee-panel integration described in the spec.
//
// Architecture mirrors models/WebsiteConfig.js (the closest existing "connection"
// analog):
//   • company / employee scoping (WebsiteConfig has company + createdBy).
//   • the shared secret (secretKey) is ENCRYPTED AT REST via the same
//     fieldCrypto plugin used by WebsiteConfig.webhookSecret and the various
//     Company API keys, and auto-decrypted on read so the employee UI can show
//     a masked value / re-test. Unlike WebsiteConfig we do NOT need an HMAC
//     lookup hash here: the CRM SENDS the secret outbound to the employee's
//     Apps Script Web App (pull model) — it never has to match an INBOUND
//     secret, so there is nothing to look up by hash.
//
// One connection per (company, employee) — enforced by the compound unique
// index below. "Connect" upserts, "Disconnect" deletes.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

// One header → CRM field mapping entry. Mirrors the CSV/Excel import field set
// already used in controllers/leadController.js (name, mobile, email, source,
// campaign, status, remark, secondaryPhone …).
const columnMapSchema = new mongoose.Schema(
  {
    sheetColumn: { type: String, required: true, trim: true }, // header text in the sheet
    crmField:    { type: String, required: true, trim: true }, // one of CRM_FIELDS (controller)
  },
  { _id: false }
);

const sheetConnectionSchema = new mongoose.Schema(
  {
    // ── Ownership / tenant scoping (Section 4 + 8) ───────────────────────────
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Company",
      required: true,
      index: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "User",
      required: true,
      index: true,
    },

    // ── Connection details (Section 3) ───────────────────────────────────────
    sheetName:     { type: String, default: "", trim: true },
    googleSheetId: { type: String, default: "", trim: true },
    appsScriptUrl: { type: String, default: "", trim: true },

    // Shared secret between the employee's Apps Script Web App and this CRM.
    // Stored ENCRYPTED at rest (fieldCrypto plugin below); auto-decrypted on
    // read so the controller can send it back out to the Apps Script on sync.
    secretKey: { type: String, default: "" },

    // ── Column mapping (Section 6) ───────────────────────────────────────────
    columnMapping: { type: [columnMapSchema], default: [] },

    // ── Import defaults (mirror WebsiteConfig.defaultStatus/defaultRemark) ────
    defaultStatus: { type: String, default: "New" },
    defaultRemark: { type: String, default: "Lead from Google Sheet" },

    isActive: { type: Boolean, default: true },

    // ── Sync bookkeeping ─────────────────────────────────────────────────────
    lastSyncAt:      { type: Date,   default: null },
    lastSyncStatus:  { type: String, default: "" },  // "success" | "error" | ""
    lastSyncMessage: { type: String, default: "" },
    lastSyncStats: {
      totalRows:  { type: Number, default: 0 },
      created:    { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      errors:     { type: Number, default: 0 },
    },
    lastTestedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One connection per employee per company. "Connect" upserts on this key.
sheetConnectionSchema.index({ company: 1, employee: 1 }, { unique: true });

// Encrypt the secret at rest (auto-decrypts on read). Applied BEFORE model
// compilation so save + find hooks attach reliably (same pattern as
// WebsiteConfig / Company).
sheetConnectionSchema.plugin(encryptedFieldsPlugin, { fields: ["secretKey"] });

module.exports = mongoose.model("SheetConnection", sheetConnectionSchema);
