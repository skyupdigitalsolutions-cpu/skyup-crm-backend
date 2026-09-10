const jwt = require("jsonwebtoken");

// role: "user" | "admin" | "superadmin"
//
// FIX (forced re-login on every clock-in): tokens used a flat 24h expiry with
// NO refresh-token mechanism anywhere in the app. A field employee logging in
// once each morning hits that boundary almost exactly one day later — right
// when they next try to clock in — forcing a full email+password re-login
// before they can even reach the clock-in screen. A mobile app IS the auth
// factor (the device itself), unlike a shared browser, so a much longer
// expiry is an appropriate, low-risk trade-off there — and it remains fully
// revocable via the existing Redis token-blacklist on logout, so a longer
// expiry does not mean "can never be logged out."
//
// `expiresIn` is now a parameter so callers can choose per login context
// (see authController.js's loginUnified — mobile app logins get "30d", the
// web admin dashboard keeps the original "24h").
const generateToken = (id, role = "user", expiresIn = "24h") => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn,
  });
};

module.exports = generateToken;
