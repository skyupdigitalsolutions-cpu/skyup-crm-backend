// models/FinanceTool.js — tools / services the company subscribes to, with renewal reminders. Per company.
const mongoose = require("mongoose");

// A project/app this tool or server hosts or is used for (e.g. a server hosting several apps).
const toolProjectSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  note: { type: String, default: "", trim: true, maxlength: 300 },
}, { _id: true });

const financeToolSchema = new mongoose.Schema({
  company:      { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  active:       { type: Boolean, default: true },

  name:         { type: String, required: true, trim: true, maxlength: 160 },   // "Canva Pro", "AWS", "Zoom"
  category:     { type: String, default: "", trim: true, maxlength: 120 },
  cost:         { type: Number, default: 0, min: 0 },                           // amount per cycle (for per-seat = seats × perSeatCost, stored here too)
  pricingType:  { type: String, enum: ["flat", "per_seat"], default: "flat" },  // flat price, or seat-based team subscription
  seats:        { type: Number, default: 0, min: 0 },                           // number of seats/users (per-seat only)
  perSeatCost:  { type: Number, default: 0, min: 0 },                           // price per seat per cycle (per-seat only)
  seatAssignees:{ type: [String], default: [] },                                // who the seats are assigned to (names)
  currency:     { type: String, default: "INR", trim: true },
  billingCycle: { type: String, enum: ["monthly", "quarterly", "half-yearly", "yearly", "one-time"], default: "monthly" },

  reason:       { type: String, default: "", trim: true, maxlength: 500 },      // reason of requirement
  description:  { type: String, default: "", trim: true, maxlength: 2000 },     // longer description (server specs, etc.)
  projects:     { type: [toolProjectSchema], default: [] },                     // projects/apps this server/tool hosts
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
