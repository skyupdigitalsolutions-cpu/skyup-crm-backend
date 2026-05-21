const mongoose = require('mongoose');

const chatUserSchema = new mongoose.Schema({
  // The display identifier used in messages (employee name, or 'admin:<id>', 'superadmin:<id>')
  username:  { type: String, required: true, unique: true, trim: true },
  company:   { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  // 'employee' | 'admin' | 'super_admin'
  role:      { type: String, default: 'employee' },
  // For employees: their assigned admin's _id; for admins: null
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  // MongoDB _id of the actual User/Admin document for reference
  userId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  displayName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now },
});

chatUserSchema.index({ company: 1, role: 1 });

module.exports = mongoose.model('ChatUser', chatUserSchema);
