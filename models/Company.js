// models/Company.js
const mongoose = require("mongoose");

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },
    plan:    { type: String, enum: ["basic", "pro", "enterprise"], default: "basic" },
    isActive:{ type: Boolean, default: true },
  },
  { timestamps: true }
);  

const Company = mongoose.model("Company", companySchema);
module.exports = Company;