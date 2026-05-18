// middlewares/companyIsolation.js — NEW FILE
// Run AFTER any protect/protectUnified middleware.
// Sets req.companyId so all downstream controllers use the same field
// regardless of whether the caller is an admin, super_admin, or employee.

const companyIsolation = (req, res, next) => {
  const user = req.user;

  // Developer: NO CRM data access — block at route level
  if (user?.role === "developer") {
    req.companyId = null;
    return next();
  }

  // Admin / super_admin: company is a populated object
  if (["admin", "super_admin"].includes(user?.role)) {
    const companyId = user.company?._id || user.company;
    if (!companyId)
      return res.status(403).json({ message: "No company assigned to this account" });
    req.companyId = companyId;
    return next();
  }

  // Employee (also handles legacy "user" role for backward compat)
  if (user?.company) {
    req.companyId = user.company;
    return next();
  }

  // Also handle req.admin (set by protectAdmin middleware)
  if (req.admin) {
    const companyId = req.admin.company?._id || req.admin.company;
    if (!companyId)
      return res.status(403).json({ message: "No company assigned to this admin" });
    req.companyId = companyId;
    return next();
  }

  return res.status(403).json({ message: "Company isolation: no company context" });
};

module.exports = companyIsolation;