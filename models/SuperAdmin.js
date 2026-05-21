const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const superAdminSchema = mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    email:         { type: String, required: true, trim: true, unique: true },
    password:      { type: String, required: true },
    role:          { type: String, default: "superadmin" },

    // ── OTP fields ──────────────────────────────────────────────────────────
    otp:            { type: String, default: null },   // bcrypt-hashed OTP
    otpExpiry:      { type: Date,   default: null },   // expiry timestamp
    otpAttempts:    { type: Number, default: 0 },      // failed attempt counter
    otpLockedUntil: { type: Date,   default: null },   // lockout timestamp
  },
  { timestamps: true }
);

superAdminSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

superAdminSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

superAdminSchema.methods.matchOtp = async function (enteredOtp) {
  if (!this.otp) return false;
  return await bcrypt.compare(enteredOtp, this.otp);
};

const SuperAdmin = mongoose.model("SuperAdmin", superAdminSchema);
module.exports = SuperAdmin;