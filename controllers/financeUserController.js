// controllers/financeUserController.js — NEW FILE
// Finance Panel logins, managed by the company's super admin (User Management).
// Same shape as the Marketing Panel user management, but access is a real switch.
"use strict";

const Admin = require("../models/Admin");
const { logAuditEvent } = require("../utils/auditLogger");

const actor = (req) => ({
  actorId: req.user && req.user._id, actorModel: "Admin",
  actorEmail: req.user && req.user.email, actorRole: req.user && req.user.role,
});

const publicUser = (a) => ({
  _id: a._id, name: a.name, email: a.email, financeAccess: !!a.financeAccess,
  isActive: a.isActive !== false, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || null,
});

exports.createFinanceUser = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    if (!companyId) return res.status(400).json({ message: "Company context missing" });
    const name = String((req.body && req.body.name) || "").trim();
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    const password = (req.body && req.body.password) || "";
    if (!name || !email || !password || typeof password !== "string") {
      return res.status(400).json({ message: "Name, email and password are required." });
    }
    if (await Admin.findOne({ email })) return res.status(400).json({ message: "An account with this email already exists." });

    let admin;
    try {
      admin = await Admin.create({ name, email, password, role: "finance_user", company: companyId, financeAccess: true, isActive: true });
    } catch (e) {
      // Password-policy / validation errors → a clear 400 instead of a 500
      if (e && (e.name === "ValidationError" || /password/i.test(e.message || ""))) {
        return res.status(400).json({ message: e.message.replace(/^.*?:\s*/, "") });
      }
      throw e;
    }
    logAuditEvent(Object.assign({
      action: "create", resourceType: "Admin", req, company: companyId, resourceId: admin._id, statusCode: 201,
      metadata: { createdEmail: admin.email, createdRole: "finance_user" },
    }, actor(req)));
    res.status(201).json(publicUser(admin));
  } catch (err) { next(err); }
};

exports.listFinanceUsers = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    if (!companyId) return res.status(400).json({ message: "Company context missing" });
    const users = await Admin.find({ company: companyId, role: "finance_user" }).select("-password -resetOtp").sort({ createdAt: 1 }).lean();
    res.json(users.map(publicUser));
  } catch (err) { next(err); }
};

exports.toggleFinanceAccess = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const admin = await Admin.findOne({ _id: req.params.id, company: companyId, role: "finance_user" });
    if (!admin) return res.status(404).json({ message: "Finance user not found" });
    const previousValue = !!admin.financeAccess;
    admin.financeAccess = !previousValue;
    await admin.save();
    logAuditEvent(Object.assign({
      action: "role_changed", resourceType: "Admin", req, company: companyId, resourceId: admin._id, statusCode: 200,
      metadata: { targetEmail: admin.email, changeType: "financeAccess", previousValue, newValue: admin.financeAccess },
    }, actor(req)));
    res.json({ _id: admin._id, financeAccess: admin.financeAccess });
  } catch (err) { next(err); }
};

exports.deleteFinanceUser = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const admin = await Admin.findOne({ _id: req.params.id, company: companyId, role: "finance_user" });
    if (!admin) return res.status(404).json({ message: "Finance user not found" });
    await Admin.deleteOne({ _id: admin._id });
    logAuditEvent(Object.assign({
      action: "delete", resourceType: "Admin", req, company: companyId, resourceId: admin._id, statusCode: 200,
      metadata: { deletedEmail: admin.email, deletedRole: "finance_user" },
    }, actor(req)));
    res.json({ deleted: true });
  } catch (err) { next(err); }
};
