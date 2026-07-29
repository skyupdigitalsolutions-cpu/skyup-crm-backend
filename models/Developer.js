// models/Developer.js — NEW FILE
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
// SECURITY (A.8.24): work factor raised from 10 to 12.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

const developerSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true, unique: true },
    password: { type: String, required: true },
    role:     { type: String, default: "developer" },
  },
  { timestamps: true }
);

developerSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_COST);
});

developerSchema.methods.matchPassword = async function (p) {
  return await bcrypt.compare(p, this.password);
};

const Developer = mongoose.model("Developer", developerSchema);
module.exports = Developer;