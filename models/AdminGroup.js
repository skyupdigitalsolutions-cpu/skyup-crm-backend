// models/AdminGroup.js
// A group of admins inside one company. Admins in the same group share their
// leads: each can see and assign the leads of every admin in the group and of
// those admins' employees (see utils/adminLeadScope.js). Managed by the
// company's super admin.
const mongoose = require("mongoose");

const adminGroupSchema = new mongoose.Schema(
  {
    company:   { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name:      { type: String, required: true, trim: true, maxlength: 80 },
    admins:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Admin" }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

adminGroupSchema.index({ company: 1, admins: 1 });
adminGroupSchema.index({ company: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.AdminGroup || mongoose.model("AdminGroup", adminGroupSchema);
