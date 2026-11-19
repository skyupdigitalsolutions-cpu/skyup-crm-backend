// models/FinanceTool.js — tools / services the company subscribes to, with renewal reminders. Per company.
const mongoose = require("mongoose");

const financeToolSchema = new mongoose.Schema({
  company:      { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  active:       { type: Boolean, default: true },

  name:         { type: String, required: true, trim: true, maxlength: 160 },   // "Canva Pro", "AWS", "Zoom"
  category:     { type: String, default: "", trim: true, maxlength: 120 },
  cost:         { type: Number, default: 0, min: 0 },                           // amount per cycle
  currency:     { type: String, default: "INR", trim: true },
  billingCycle: { type: String, enum: ["monthly", "quarterly", "half-yearly", "yearly", "one-time"], default: "monthly" },

  reason:       { type: String, default: "", trim: true, maxlength: 500 },      // reason of requirement
  takenBy:      { type: String, default: "", trim: true, maxlength: 120 },      // who procured / owns it
  usedBy:       { type: String, default: "", trim: true, maxlength: 300 },      // who uses / handles it

  startDate:    { type: Date, default: null },
  renewalDate:  { type: Date, default: null, index: true },                     // next renewal / expiry
  reminderDays: { type: Number, default: 7, min: 0, max: 90 },                  // remind this many days before
  lastReminderAt:{ type: Date, default: null },
  renewalReminderDay:{ type: String, default: "" },   // "YYYY-MM-DD" in IST — once-per-day reminder guard
  autoRenews:   { type: Boolean, default: true },

  note:         { type: String, default: "", trim: true, maxlength: 500 },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName:{ type: String, default: "" },
}, { timestamps: true });

financeToolSchema.index({ company: 1, renewalDate: 1 });
module.exports = mongoose.model("FinanceTool", financeToolSchema);
