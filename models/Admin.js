const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const adminSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true },
    password: { type: String, required: true },
    company:  {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true, // Every admin belongs to a company
    },
    role: { type: String, enum: ["superadmin", "admin"], default: "admin" },
  },
  { timestamps: true }
);

// Hashing the password before saving
adminSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Compare the hashed password from DB to verify
adminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── FIX 4A: Performance indexes ───────────────────────────────────────────────
adminSchema.index({ email: 1 }, { unique: true });
adminSchema.index({ company: 1 });

const Admin = mongoose.model("Admin", adminSchema);
module.exports = Admin;