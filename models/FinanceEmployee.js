// models/FinanceEmployee.js — staff records for the Finance dashboard (HR info, assets assigned, tools handled).
// Scoped per company. May optionally link to a CRM user (`userRef`) when the employee also logs into the CRM.
const mongoose = require("mongoose");

const assetSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true, maxlength: 120 },   // "Dell Laptop", "SIM 9xxxx"
  identifier: { type: String, default: "", trim: true, maxlength: 120 },      // serial / asset tag / number
  assignedOn: { type: Date, default: null },
  note:       { type: String, default: "", trim: true, maxlength: 300 },
}, { _id: true });

const toolSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true, maxlength: 120 },        // tool / software the employee uses or handles
  role:  { type: String, default: "", trim: true, maxlength: 120 },           // "admin", "editor", "handles billing"
  note:  { type: String, default: "", trim: true, maxlength: 300 },
}, { _id: true });

const financeEmployeeSchema = new mongoose.Schema({
  company:     { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  userRef:     { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },   // optional link to a CRM login
  active:      { type: Boolean, default: true },

  name:        { type: String, required: true, trim: true, maxlength: 120 },
  employeeCode:{ type: String, default: "", trim: true, maxlength: 60 },
  designation: { type: String, default: "", trim: true, maxlength: 120 },
  department:  { type: String, default: "", trim: true, maxlength: 120 },
  email:       { type: String, default: "", trim: true, lowercase: true },
  phone:       { type: String, default: "", trim: true },
  dob:         { type: Date, default: null },
  dateOfJoining:{ type: Date, default: null },

  bankName:    { type: String, default: "", trim: true },
  bankAcNo:    { type: String, default: "", trim: true },

  assets:      { type: [assetSchema], default: [] },
  tools:       { type: [toolSchema], default: [] },

  createdBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName:{ type: String, default: "" },
}, { timestamps: true });

financeEmployeeSchema.index({ company: 1, name: 1 });
module.exports = mongoose.model("FinanceEmployee", financeEmployeeSchema);
