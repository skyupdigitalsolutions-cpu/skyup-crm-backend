const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from:      { type: String, required: true },
  to:        { type: String, required: true },
  message:   { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  isDeleted: { type: Boolean, default: false },
  editedAt:  { type: Date, default: null },
});

module.exports = mongoose.model('Message', messageSchema);