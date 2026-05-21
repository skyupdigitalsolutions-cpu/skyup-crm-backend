const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Who sent it (username string for employees, 'admin:<adminId>' for admins, 'superadmin:<adminId>' for super admins)
  from:      { type: String, required: true },
  // Who receives it (same format)
  to:        { type: String, required: true },
  message:   { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  isDeleted: { type: Boolean, default: false },
  editedAt:  { type: Date, default: null },

  // ── Multi-tenant & role-scoping fields ───────────────────────────────────────
  // Every message belongs to a company — used for isolation
  company:   { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  // The admin involved in this conversation (for employee↔admin threads)
  // For superadmin↔admin threads this is the regular admin's _id
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  // Conversation key — stable identifier for the thread
  // Format: "<companyId>:<participantA>:<participantB>" (sorted alphabetically)
  threadKey: { type: String, index: true },
});

messageSchema.index({ company: 1, threadKey: 1, timestamp: 1 });

module.exports = mongoose.model('Message', messageSchema);
