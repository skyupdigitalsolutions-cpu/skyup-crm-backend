// models/AgentPushSubscription.js
// One web-push subscription per phone/browser for the /agent web app (PWA).
// Kept separate from User.fcmToken on purpose: that field belongs to the Android app, and storing a web
// subscription there would replace the Android token. An employee can have several (phone + tablet).
// The same phone signing in as another employee moves the subscription to that employee (keyed by endpoint).
const mongoose = require('mongoose');

const agentPushSubscriptionSchema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company:  { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth:   { type: String, required: true },
    },
    userAgent:  { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AgentPushSubscription', agentPushSubscriptionSchema);
