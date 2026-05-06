const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, trim: true },
    password: { type: String, required: true },
    role:     { type: String, default: "user" },
    company:  {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true, // Every user belongs to a company
    },

    // ── Device / app info captured on login & clock-in ────────────────────────
    appName:     { type: String, default: null },
    appVersion:  { type: String, default: null },
    platform:    { type: String, default: null },
    deviceModel: { type: String, default: null },
    osVersion:   { type: String, default: null },
    fcmToken:    { type: String, default: null },
  },
  { timestamps: true }
);
//Hashing the password before saving
userSchema.pre("save", async function (){
  if(!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

//compare the hashed password from DB to verify
userSchema.methods.matchPassword = async function (enteredPassword){
  return await bcrypt.compare(enteredPassword, this.password);
}

const User = mongoose.model("User", userSchema);

module.exports = User;