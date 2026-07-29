const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
// SECURITY (A.8.24): work factor raised from 10 to 12.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

const superAdminSchema = mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    email:         { type: String, required: true, trim: true, unique: true },
    password: {
      type: String,
      required: true,
      // SECURITY (A.5.17): minimum length enforced at the schema layer so no
      // controller can bypass it. Complexity/breach checks live in
      // utils/passwordPolicy.js and are applied at set/change time.
      minlength: [12, "Password must be at least 12 characters"],
    },
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
  this.password = await bcrypt.hash(this.password, BCRYPT_COST);
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