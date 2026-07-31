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
      // SECURITY (A.5.17): enforced at the schema layer so no controller can
      // bypass it. Mongoose validates BEFORE the pre('save') hash hook, so this
      // applies to the plaintext.
      // PRODUCTION NOTE: defaults to 8 to avoid rejecting existing flows on
      // deploy. Raise to 12 via PASSWORD_MIN_LENGTH once all user-creation
      // paths issue longer passwords. utils/passwordPolicy.js enforces the
      // full policy (length + complexity + common/reuse checks) at set time.
      minlength: [
        Number(process.env.PASSWORD_MIN_LENGTH) || 8,
        `Password must be at least ${Number(process.env.PASSWORD_MIN_LENGTH) || 8} characters`,
      ],
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

// ── Full password policy (A.5.17) ────────────────────────────────────────────
// Enforces utils/passwordPolicy.js centrally so no super-admin creation/reset
// path can bypass it. Runs before the hash hook and is guarded by isModified.
const { validatePassword } = require("../utils/passwordPolicy");
superAdminSchema.pre("validate", function (next) {
  if (!this.isModified("password")) return next();
  const { valid, errors } = validatePassword(this.password, { email: this.email, name: this.name });
  if (!valid) this.invalidate("password", errors[0]);
  next();
});

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