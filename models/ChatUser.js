const mongoose = require('mongoose');

const chatUserSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  createdAt: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('ChatUser', chatUserSchema);