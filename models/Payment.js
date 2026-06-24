const mongoose = require("mongoose");

// Per-line detail so the invoice receipt can render each plan/add-on as its own
// row with its own GST split. Optional — older payments without lineItems still
// render via the single-line fallback in InvoiceReceipt.jsx.
const lineItemSchema = new mongoose.Schema(
  {
    type:          { type: String, enum: ["plan", "addon"], default: "addon" },
    name:          { type: String, required: true },
    sub:           { type: String, default: "" },
    quantity:      { type: Number, default: 1, min: 1 },
    billingPeriod: { type: String, default: "" },
    autoRenew:     { type: Boolean, default: false },
    // GST-inclusive amount for this line (rate × qty incl. tax).
    amount:        { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    invoiceId: {
      type: String,
      required: true,
      unique: true,
    },
    planId: {
      // Accept both the canonical plan keys (basic/pro/advance) and the legacy
      // aliases (starter/growth) so historical rows + the new pricing resolver
      // both validate.
      type: String,
      enum: ["basic", "pro", "advance", "enterprise", "starter", "growth", "addon"],
      required: true,
    },
    planName: {
      type: String,
      required: true,
    },
    billing: {
      type: String,
      enum: ["monthly", "yearly", "one_time"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    // Per-line breakdown (plan + each add-on). Empty for legacy single-line rows.
    lineItems: {
      type: [lineItemSchema],
      default: [],
    },
    razorpayOrderId: {
      type: String,
      required: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["paid", "pending", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

const Payment = mongoose.model("Payment", paymentSchema);
module.exports = Payment;
