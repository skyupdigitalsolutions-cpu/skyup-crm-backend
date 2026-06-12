// models/LimitOverrideInvoice.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Invoice / payment record created when a developer or super-admin grants an
// additional per-company LIMIT override that carries a price + time limit.
//
// One record is created per priced limit field at the moment it is saved with a
// non-zero price. It serves as the billing/audit entry the operator asked for —
// independent of the Razorpay-coupled `Payment` model (which is for plan
// subscriptions).
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const limitOverrideInvoiceSchema = new mongoose.Schema(
  {
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    // Human-readable invoice number, e.g. LIM-1718200000000-AB12
    invoiceId: {
      type:     String,
      required: true,
      unique:   true,
    },

    // Which limit this charge is for — matches a devOverrides numeric key
    // (admins, users, leads, websites, metaCampaigns, googleAccounts,
    //  storageMB, transcriptionsLimit, summariesLimit, voiceBotLimit).
    limitKey: {
      type:     String,
      required: true,
    },

    // Friendly label shown on the invoice (e.g. "Leads", "Storage (MB)")
    limitLabel: { type: String, default: "" },

    // The absolute cap that was granted for this company
    value: { type: Number, required: true },

    // Amount charged for granting this override (in the platform currency)
    price: { type: Number, required: true, min: 0 },

    currency: { type: String, default: "INR" },

    // Validity window for the override this invoice paid for
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }, // null = no time limit

    // Who granted it
    actorId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    actorRole: { type: String, enum: ["developer", "super_admin", "system"], default: "system" },

    status: {
      type:    String,
      enum:    ["paid", "pending", "void"],
      default: "paid", // manually granted overrides are recorded as paid by default
    },

    note: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LimitOverrideInvoice", limitOverrideInvoiceSchema);