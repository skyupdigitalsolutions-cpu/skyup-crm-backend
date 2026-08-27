const axios   = require("axios");
const crypto  = require("crypto");
const Admin   = require("../models/Admin");
const User    = require("../models/Users");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");
const { getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");
const { looksLikeAutoResolvedName } = require("../utils/templateNameResolver");
const { logAuditEvent } = require("../utils/auditLogger");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const cloudinary             = require("cloudinary").v2;
const { CloudinaryStorage }  = require("multer-storage-cloudinary");

// ── Cloudinary config (uses same env vars as the rest of the app) ─────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Plan limits — single source of truth on the backend
const PLAN_LIMITS = {
  basic:      { maxAdmins: 1,  maxUsers: 10  },
  pro:        { maxAdmins: 3,  maxUsers: 30  },
  enterprise: { maxAdmins: 5,  maxUsers: 50  },
};

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.basic;
}

const getMyCompany = async (req, res) => {
  try {
    res.status(200).json({
      _id:      req.admin.company._id,
      name:     req.admin.company.name,
      email:    req.admin.company.email,
      plan:     req.admin.company.plan,
      isActive: req.admin.company.isActive,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAdmins = async (req, res) => {
  try {
    const filter = { company: req.admin.company._id };
    if (req.admin.role !== "super_admin") filter.role = { $ne: "super_admin" };
    // Never show marketing-panel-only users in the admin list — they are
    // managed in the Marketing Panel Access section of User Management.
    filter.role = filter.role
      ? { $nin: ["super_admin", "marketing_user"] }
      : { $nin: ["marketing_user"] };
    filter.marketingAccess = { $ne: true };
    // SECURITY FIX: plainPassword is deprecated (see models/Admin.js) — always
    // excluded now, not just for non-super_admin. It's never written to
    // anymore, so returning it would only ever leak stale/legacy values.
    const selectFields = "-password -plainPassword";
    const admins = await Admin.find(filter).select(selectFields);
    res.status(200).json(admins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id }).select("-password");
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    res.status(200).json(admin);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const companyId = req.admin.company._id;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const limits = getPlanLimits(company.plan);
    const existingAdminCount = await Admin.countDocuments({ company: companyId, role: { $ne: "super_admin" } });

    if (existingAdminCount >= limits.maxAdmins) {
      return res.status(403).json({
        message: `Your ${company.plan} plan allows a maximum of ${limits.maxAdmins} admin${limits.maxAdmins > 1 ? "s" : ""}. Please upgrade your plan to add more.`,
        limitReached: true,
        plan: company.plan,
        maxAdmins: limits.maxAdmins,
      });
    }

    const adminExists = await Admin.findOne({ email });
    if (adminExists) return res.status(400).json({ message: "Admin already exists" });

    // SECURITY FIX: no longer stored — plainPassword is deprecated (see
    // models/Admin.js). `password` here is only ever the plaintext value the
    // caller just typed into the create-admin form; echoing it back once in
    // this response (for the "copy this now" modal) is not a new disclosure
    // since the caller already has it. It is never persisted anywhere.
    const admin = await Admin.create({ name, email, password, company: companyId });

    logAuditEvent({
      action: "create", resourceType: "Admin", req,
      actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
      actorRole: req.admin?.role, company: companyId,
      resourceId: admin._id, statusCode: 201,
      metadata: { createdEmail: admin.email, createdRole: "admin" },
    });

    // ── SECURITY FIX: plainPassword removed from response ────────────────────
    // The frontend now uses the password from its own form state (which the
    // admin already typed) to display in the CredentialsModal — no need to
    // echo it back over the network. Transmitting credentials in API responses
    // risks exposure in proxy logs, browser network history, and MITM attacks.
    res.status(201).json({
      _id:     admin._id,
      name:    admin.name,
      email:   admin.email,
      company: admin.company,
      role:    "admin",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!admin) return res.status(404).json({ message: "Admin Not Found" });

    if (admin.role === "super_admin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "super_admin",
      });
      if (superCount <= 1) {
        return res.status(400).json({
          message: "Cannot delete the only superadmin. Promote another admin to superadmin first.",
        });
      }
    }

    await Admin.findByIdAndDelete(req.params.id);

    logAuditEvent({
      action: "delete", resourceType: "Admin", req,
      actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
      actorRole: req.admin?.role, company: req.admin?.company?._id,
      resourceId: admin._id, statusCode: 200,
      metadata: { deletedEmail: admin.email, deletedRole: admin.role },
    });

    res.status(200).json({ message: "Admin deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateAdmin = async (req, res) => {
  try {
    const admin = await Admin.findOne({ _id: req.params.id, company: req.admin.company._id });
    if (!admin) return res.status(404).json({ message: "Admin Not Found" });

    if (req.body.role && !["super_admin", "admin"].includes(req.body.role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (admin.role === "super_admin" && req.body.role && req.body.role !== "super_admin") {
      const superCount = await Admin.countDocuments({
        company: req.admin.company._id,
        role: "super_admin",
      });
      if (superCount <= 1) {
        return res.status(400).json({
          message: "Cannot demote the only superadmin. Promote another admin first.",
        });
      }
    }

    // Captured BEFORE the update, from the same document already fetched
    // above — needed to detect a GENUINE change, not just a field being
    // present in the request body.
    const previousRole = admin.role;
    const previousMarketingAccess = admin.marketingAccess;

    const updated = await Admin.findByIdAndUpdate(req.params.id, req.body, { new: true }).select("-password");

    // Only a genuine ROLE change is logged — a request that includes `role`
    // but sets it to the SAME value, or omits it entirely to only edit
    // unrelated fields (name, department, etc.), is not a privilege event.
    if (req.body.role !== undefined && req.body.role !== previousRole) {
      logAuditEvent({
        action: "role_changed", resourceType: "Admin", req,
        actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
        actorRole: req.admin?.role, company: req.admin?.company?._id,
        resourceId: updated._id, statusCode: 200,
        metadata: {
          targetEmail: updated.email, changeType: "role",
          previousRole, newRole: req.body.role,
        },
      });
    }

    // marketingAccess is a distinct privilege flag that this same generic
    // patch can also touch — logged as its own role_changed event (with
    // changeType distinguishing it in metadata) only when it genuinely flips.
    if (req.body.marketingAccess !== undefined && req.body.marketingAccess !== previousMarketingAccess) {
      logAuditEvent({
        action: "role_changed", resourceType: "Admin", req,
        actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
        actorRole: req.admin?.role, company: req.admin?.company?._id,
        resourceId: updated._id, statusCode: 200,
        metadata: {
          targetEmail: updated.email, changeType: "marketingAccess",
          previousValue: previousMarketingAccess, newValue: req.body.marketingAccess,
        },
      });
    }

    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createCompanyUser = async (req, res) => {
  try {
    const { name, email, password, contactAccountEmail, languages } = req.body;
    const companyId = req.admin.company._id;

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: "Company not found" });

    const PLAN_USER_LIMITS = { basic: 10, pro: 30, enterprise: 50 };
    const userLimit = PLAN_USER_LIMITS[company.plan] || 10;
    const existingUserCount = await User.countDocuments({ company: companyId });
    if (existingUserCount >= userLimit) {
      return res.status(403).json({
        message: `Your ${company.plan} plan allows a maximum of ${userLimit} users. Please upgrade your plan to add more.`,
        limitReached: true, plan: company.plan, maxUsers: userLimit,
      });
    }

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: "User already exists" });

    const user = await User.create({
      name, email, password,
      company: companyId,
      role: "user",
      createdBy: req.admin._id,
      // Optional: Google account email leads are auto-saved into on the
      // employee's phone. Stored normalized (trim/lowercase via the schema).
      contactAccountEmail: contactAccountEmail
        ? String(contactAccountEmail).trim()
        : null,
      languages: Array.isArray(languages)
        ? languages.map(function (l) { return String(l).trim(); }).filter(Boolean)
        : [],
    });

    // SECURITY FIX: plainPassword is deprecated (see models/Users.js) — not
    // stored. `password` is the plaintext value the caller just typed into
    // the create-user form; echoing it back once here is not a new
    // disclosure and is never persisted.

    logAuditEvent({
      action: "create", resourceType: "User", req,
      actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
      actorRole: req.admin?.role, company: companyId,
      resourceId: user._id, statusCode: 201,
      metadata: { createdEmail: user.email, createdRole: user.role },
    });

    // ── SECURITY FIX: plainPassword removed from response ────────────────────
    // Same reasoning as createAdmin above — frontend uses its own form state.
    res.status(201).json({
      _id:                user._id,
      name:               user.name,
      email:              user.email,
      company:            user.company,
      role:               user.role,
      contactAccountEmail: user.contactAccountEmail,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanyUsers = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const filter = { company: companyId };
    const ownFilter = { company: companyId };
    if (req.admin.role !== "super_admin") ownFilter.createdBy = req.admin._id;

    // SECURITY FIX: plainPassword is deprecated — always excluded now.
    const userSelectFields = "-password -plainPassword";
    const [users, totalCompanyUsers] = await Promise.all([
      User.find(ownFilter).select(userSelectFields),
      User.countDocuments(filter),
    ]);

    res.status(200).json({ users, totalCompanyUsers });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCompanyLeads = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
    const skip  = (page - 1) * limit;

    const companyId = req.admin.company._id;

    const isAdminRole = ["admin", "super_admin"].includes(req.admin.role);
    let filter = { company: companyId, mergedInto: null };
    if (!isAdminRole) {
      filter.isClosed = { $ne: true };
    }
    // Optional language filter. "none" matches leads with no language set.
    const langQ = req.query.language;
    if (typeof langQ === "string" && langQ.trim()) {
      const l = langQ.trim();
      if (l.toLowerCase() === "none") filter.$or = [{ language: "" }, { language: null }, { language: { $exists: false } }];
      else filter.language = l;
    }

    // Per-admin isolation: a plain admin sees only their own leads.
    const scope = await getAdminLeadScope(req, companyId);
    filter = mergeLeadScope(filter, scope);

    const [leads, total] = await Promise.all([
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      Lead.countDocuments(filter),
    ]);

    res.status(200).json({ leads, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/leads/languages ───────────────────────────────────────────
// Distinct languages present on this company's leads (for the filter dropdown).
const getDistinctLeadLanguages = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const scope = await getAdminLeadScope(req, companyId);
    const langs = await Lead.distinct(
      "language",
      mergeLeadScope({ company: companyId, language: { $nin: [null, ""] } }, scope)
    );
    res.status(200).json({ languages: (langs || []).filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── PATCH /api/admin/leads/:id/language  { language } ─────────────────────────
// Manual override of a lead's language ("" clears it).
const updateLeadLanguage = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const language = typeof req.body.language === "string" ? req.body.language.trim() : "";
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOneAndUpdate(
      mergeLeadScope({ _id: req.params.id, company: companyId }, scope),
      { language: language },
      { new: true }
    ).populate("user", "name email").lean();
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.status(200).json({ _id: lead._id, language: lead.language });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── PUT /api/admin/users/:id/languages  { languages: [..] } ───────────────────
// Set the languages an employee can handle.
const updateUserLanguages = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    let langs = req.body.languages;
    if (!Array.isArray(langs)) langs = [];
    // clean: strings, trimmed, non-empty, de-duped
    const seen = {};
    const clean = [];
    for (let i = 0; i < langs.length; i++) {
      const v = typeof langs[i] === "string" ? langs[i].trim() : "";
      if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = true; clean.push(v); }
    }
    const query = { _id: req.params.id, company: companyId };
    if (req.admin.role !== "super_admin") query.createdBy = req.admin._id;
    const user = await User.findOneAndUpdate(query, { languages: clean }, { new: true }).select("-password -plainPassword");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ _id: user._id, name: user.name, languages: user.languages });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCompanyUser = async (req, res) => {
  try {
    const query = { _id: req.params.id, company: req.admin.company._id };
    if (req.admin.role !== "super_admin") query.createdBy = req.admin._id;
    const user = await User.findOne(query);
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.findByIdAndDelete(req.params.id);

    logAuditEvent({
      action: "delete", resourceType: "User", req,
      actorId: req.admin?._id, actorModel: "Admin", actorEmail: req.admin?.email,
      actorRole: req.admin?.role, company: req.admin?.company?._id,
      resourceId: user._id, statusCode: 200,
      metadata: { deletedEmail: user.email, deletedRole: user.role },
    });

    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/dashboard-stats ───────────────────────────────────────────
const getDashboardStats = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;

    // Per-admin isolation: a normal admin's dashboard reflects ONLY their own
    // leads; super_admin sees company-wide numbers.
    const scope = await getAdminLeadScope(req, companyId);
    const statsMatch = mergeLeadScope({ company: companyId }, scope);
    const phoneFind  = mergeLeadScope({ company: companyId, phoneRevealCount: { $gt: 0 } }, scope);
    const emailFind  = mergeLeadScope({ company: companyId, emailRevealCount: { $gt: 0 } }, scope);

    // FIX PERFORMANCE: Collapse 6 separate DB round trips into 1 aggregate
    // Previously: 4 countDocuments + 2 aggregates = 6 round trips to MongoDB
    // Now: 1 aggregate covers all counts + reveal stats = 1 round trip
    const [statsAgg, topRevealed, topEmailRevealed] = await Promise.all([
      Lead.aggregate([
        { $match: statsMatch },
        { $group: {
            _id: null,
            totalLeads:         { $sum: 1 },
            hotLeads:           { $sum: { $cond: [{ $eq: ["$temperature", "Hot"]  }, 1, 0] } },
            warmLeads:          { $sum: { $cond: [{ $eq: ["$temperature", "Warm"] }, 1, 0] } },
            coldLeads:          { $sum: { $cond: [{ $eq: ["$temperature", "Cold"] }, 1, 0] } },
            totalPhoneReveals:  { $sum: "$phoneRevealCount" },
            phoneLeadsRevealed: { $sum: { $cond: [{ $gt: ["$phoneRevealCount", 0] }, 1, 0] } },
            totalEmailReveals:  { $sum: "$emailRevealCount" },
            emailLeadsRevealed: { $sum: { $cond: [{ $gt: ["$emailRevealCount", 0] }, 1, 0] } },
        }},
      ]),
      Lead.find(phoneFind)
        .sort({ phoneRevealCount: -1 }).limit(5)
        .select("name mobile phoneRevealCount").lean(),
      Lead.find(emailFind)
        .sort({ emailRevealCount: -1 }).limit(5)
        .select("name email emailRevealCount").lean(),
    ]);

    const s = statsAgg[0] || {
      totalLeads: 0, hotLeads: 0, warmLeads: 0, coldLeads: 0,
      totalPhoneReveals: 0, phoneLeadsRevealed: 0,
      totalEmailReveals: 0, emailLeadsRevealed: 0,
    };

    let byAdmin = [], byAdminEmail = [];

    if (req.admin?.role === "super_admin") {
      // FIX PERFORMANCE: Replace JS-side grouping with MongoDB $unwind aggregate
      // Previously: fetched ALL leads with revealLogs into Node memory, grouped in JS
      // Now: MongoDB does grouping server-side — only results travel over the wire
      const [phoneAgg, emailAgg] = await Promise.all([
        Lead.aggregate([
          { $match: { company: companyId, "phoneRevealLog.0": { $exists: true } } },
          { $unwind: "$phoneRevealLog" },
          // First group by (admin, lead) so we get a per-lead reveal count…
          { $group: {
              _id:          { userId: "$phoneRevealLog.userId", leadId: "$_id" },
              adminName:    { $first: "$phoneRevealLog.userName" },
              leadName:     { $first: "$name" },
              leadMobile:   { $first: "$mobile" },
              count:        { $sum: 1 },
          }},
          // …then roll those up per admin, carrying the lead breakdown along.
          { $group: {
              _id:          "$_id.userId",
              adminName:    { $first: "$adminName" },
              totalReveals: { $sum: "$count" },
              leadsRevealed:{ $sum: 1 },
              leads:        { $push: { name: "$leadName", mobile: "$leadMobile", count: "$count" } },
          }},
          { $project: { adminName: 1, totalReveals: 1, leadsRevealed: 1, leads: 1 } },
          { $sort: { totalReveals: -1 } },
          { $limit: 20 },
        ]),
        Lead.aggregate([
          { $match: { company: companyId, "emailRevealLog.0": { $exists: true } } },
          { $unwind: "$emailRevealLog" },
          { $group: {
              _id:          { userId: "$emailRevealLog.userId", leadId: "$_id" },
              adminName:    { $first: "$emailRevealLog.userName" },
              adminEmail:   { $first: "$emailRevealLog.userEmail" },
              leadName:     { $first: "$name" },
              leadEmail:    { $first: "$email" },
              count:        { $sum: 1 },
          }},
          { $group: {
              _id:          "$_id.userId",
              adminName:    { $first: "$adminName" },
              adminEmail:   { $first: "$adminEmail" },
              totalReveals: { $sum: "$count" },
              leadsRevealed:{ $sum: 1 },
              leads:        { $push: { name: "$leadName", email: "$leadEmail", count: "$count" } },
          }},
          { $project: { adminName: 1, adminEmail: 1, totalReveals: 1, leadsRevealed: 1, leads: 1 } },
          { $sort: { totalReveals: -1 } },
          { $limit: 20 },
        ]),
      ]);

      // Sort each admin's lead breakdown by reveal count (highest first) so the
      // drill-down list is ranked, matching the frontend's expectation.
      byAdmin = phoneAgg.map(a => ({
        adminName:     a.adminName,
        totalReveals:  a.totalReveals,
        leadsRevealed: a.leadsRevealed,
        leads:         (a.leads || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0)),
      }));
      byAdminEmail = emailAgg.map(a => ({
        adminName:     a.adminName,
        adminEmail:    a.adminEmail,
        totalReveals:  a.totalReveals,
        leadsRevealed: a.leadsRevealed,
        leads:         (a.leads || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0)),
      }));
    }

    res.status(200).json({
      totalLeads: s.totalLeads,
      quality: { hot: s.hotLeads, warm: s.warmLeads, cold: s.coldLeads },
      phoneReveal: {
        totalReveals:  s.totalPhoneReveals,
        leadsRevealed: s.phoneLeadsRevealed,
        topRevealed:   topRevealed.map(l => ({ name: l.name, mobile: l.mobile, count: l.phoneRevealCount })),
        byAdmin,
      },
      emailReveal: {
        totalReveals:  s.totalEmailReveals,
        leadsRevealed: s.emailLeadsRevealed,
        topRevealed:   topEmailRevealed.map(l => ({ name: l.name, email: l.email, count: l.emailRevealCount })),
        byAdmin: byAdminEmail,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/admin/company/auto-template ─────────────────────────────────────
const getAutoTemplateSettings = async (req, res) => {
  try {
    const company = await Company.findById(req.admin.company._id).select("autoTemplate");
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json({ autoTemplate: company.autoTemplate || {} });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/admin/company/auto-template ─────────────────────────────────────
const updateAutoTemplateSettings = async (req, res) => {
  try {
    const { whatsapp, email, sms } = req.body;
    const update = {};
    if (whatsapp !== undefined) {
      if (typeof whatsapp.enabled      === "boolean") update["autoTemplate.whatsapp.enabled"]      = whatsapp.enabled;
      if (whatsapp.templateName !== undefined) {
        // Reject an industry-specific auto-resolve-library name here — this
        // field is a SINGLE fixed template sent to every new lead regardless
        // of industry/service, so a name like "digital_marketing_crm_
        // awareness_v2" would blast that one vertical's message to everyone.
        // (services/autoTemplateService.js also blocks this at send time as
        // a safety net, but rejecting the save here stops it from ever being
        // configured in the first place.)
        if (looksLikeAutoResolvedName(whatsapp.templateName)) {
          return res.status(400).json({
            message: `"${whatsapp.templateName}" looks like an industry+service specific template from the auto-resolve library, not a generic one. This setting sends the SAME message to every new lead regardless of their industry — use a generic template (e.g. "crm_followup_leads") here instead. Industry-specific messaging belongs in Lead Nurture rules.`,
          });
        }
        update["autoTemplate.whatsapp.templateName"] = whatsapp.templateName;
      }
      if (whatsapp.languageCode !== undefined)         update["autoTemplate.whatsapp.languageCode"] = whatsapp.languageCode;
    }
    if (email !== undefined) {
      if (typeof email.enabled      === "boolean")  update["autoTemplate.email.enabled"]      = email.enabled;
      if (email.subject     !== undefined)           update["autoTemplate.email.subject"]      = email.subject;
      if (email.fromName    !== undefined)           update["autoTemplate.email.fromName"]     = email.fromName;
      if (email.bodyTemplate !== undefined)          update["autoTemplate.email.bodyTemplate"] = email.bodyTemplate;
    }
    if (sms !== undefined) {
      if (typeof sms.enabled  === "boolean")  update["autoTemplate.sms.enabled"]    = sms.enabled;
      if (sms.message    !== undefined)        update["autoTemplate.sms.message"]    = sms.message;
      if (sms.templateId !== undefined)        update["autoTemplate.sms.templateId"] = sms.templateId;
      if (sms.senderId   !== undefined)        update["autoTemplate.sms.senderId"]   = sms.senderId;
    }
    const company = await Company.findByIdAndUpdate(
      req.admin.company._id,
      { $set: update },
      { new: true, select: "autoTemplate" }
    );
    res.json({ success: true, autoTemplate: company.autoTemplate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/admin/company/interested-blast ───────────────────────────────────
const getInterestedBlastSettings = async (req, res) => {
  try {
    const company = await Company.findById(req.admin.company._id).select("interestedBlast");
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json({ interestedBlast: company.interestedBlast || {} });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/admin/company/interested-blast ───────────────────────────────────
const updateInterestedBlastSettings = async (req, res) => {
  try {
    const { whatsapp, email, sms } = req.body;
    const update = {};
    if (whatsapp !== undefined) {
      if (typeof whatsapp.enabled      === "boolean") update["interestedBlast.whatsapp.enabled"]      = whatsapp.enabled;
      if (whatsapp.templateName !== undefined) {
        // Same reasoning as updateAutoTemplateSettings above — this is one
        // fixed message for every "Interested" lead regardless of vertical.
        if (looksLikeAutoResolvedName(whatsapp.templateName)) {
          return res.status(400).json({
            message: `"${whatsapp.templateName}" looks like an industry+service specific template from the auto-resolve library, not a generic one. This setting sends the SAME message to every "Interested" lead regardless of their industry — use a generic template here instead. Industry-specific messaging belongs in Lead Nurture rules.`,
          });
        }
        update["interestedBlast.whatsapp.templateName"] = whatsapp.templateName;
      }
      if (whatsapp.languageCode !== undefined)         update["interestedBlast.whatsapp.languageCode"] = whatsapp.languageCode;
    }
    if (email !== undefined) {
      if (typeof email.enabled       === "boolean") update["interestedBlast.email.enabled"]      = email.enabled;
      if (email.subject     !== undefined)           update["interestedBlast.email.subject"]      = email.subject;
      if (email.fromName    !== undefined)           update["interestedBlast.email.fromName"]     = email.fromName;
      if (email.bodyTemplate !== undefined)          update["interestedBlast.email.bodyTemplate"] = email.bodyTemplate;
    }
    if (sms !== undefined) {
      if (typeof sms.enabled  === "boolean") update["interestedBlast.sms.enabled"]    = sms.enabled;
      if (sms.message    !== undefined)       update["interestedBlast.sms.message"]    = sms.message;
      if (sms.templateId !== undefined)       update["interestedBlast.sms.templateId"] = sms.templateId;
      if (sms.senderId   !== undefined)       update["interestedBlast.sms.senderId"]   = sms.senderId;
    }
    const company = await Company.findByIdAndUpdate(
      req.admin.company._id,
      { $set: update },
      { new: true, select: "interestedBlast" }
    );
    res.json({ success: true, interestedBlast: company.interestedBlast });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/admin/company/auto-template/test ────────────────────────────────
// Runs the new-lead auto-template blast SYNCHRONOUSLY against a real lead and
// returns per-channel results, so the admin can see exactly why a channel
// sent / skipped / failed. Body: { leadId } (optional — defaults to the most
// recently created lead in the company).
const { autoSendTemplates, sendInterestedBlast } = require("../services/autoTemplateService");

const testAutoTemplate = async (req, res) => {
  try {
    const companyId = req.admin.company?._id || req.admin.company;
    const { leadId } = req.body || {};
    const lead = leadId
      ? await Lead.findOne({ _id: leadId, company: companyId }).lean()
      : await Lead.findOne({ company: companyId }).sort({ createdAt: -1 }).lean();
    if (!lead)
      return res.status(404).json({ message: "No lead found to test with. Create a lead first." });

    const results = await autoSendTemplates(lead, companyId);
    res.json({
      success: true,
      lead: { _id: lead._id, name: lead.name, mobile: lead.mobile, email: lead.email },
      results,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/admin/company/interested-blast/test ─────────────────────────────
// Same as above but for the Interested blast. Bypasses the once-per-lead guard
// (it's a test) and does NOT mark the lead as blasted.
const testInterestedBlast = async (req, res) => {
  try {
    const companyId = req.admin.company?._id || req.admin.company;
    const { leadId } = req.body || {};
    const lead = leadId
      ? await Lead.findOne({ _id: leadId, company: companyId }).lean()
      : await Lead.findOne({ company: companyId }).sort({ createdAt: -1 }).lean();
    if (!lead)
      return res.status(404).json({ message: "No lead found to test with. Create a lead first." });

    const results = await sendInterestedBlast(lead, companyId);
    res.json({
      success: true,
      lead: { _id: lead._id, name: lead.name, mobile: lead.mobile, email: lead.email },
      results,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Company Branding ──────────────────────────────────────────────────────────
const getCompanyBrand = async (req, res) => {
  try {
    const raw =
      req.companyId ||
      (req.admin?.company?._id ?? req.admin?.company) ||
      req.user?.company ||
      req.user?.companyId;
    const companyId = raw ? raw.toString() : null;
    const company   = await Company.findById(companyId)
      .select("brandName brandLogoUrl headerName headerLogoUrl")
      .lean();
    res.json({
      name:          company?.brandName     || "",
      logoUrl:       company?.brandLogoUrl  || "",
      headerName:    company?.headerName    || "",
      headerLogoUrl: company?.headerLogoUrl || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const brandStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const raw = req.admin?.company?._id ?? req.admin?.company;
    const cid = raw ? raw.toString() : "unknown";
    return {
      folder:          "skyup-crm/logos",
      resource_type:   "image",
      public_id:       `logo_${cid}_${Date.now()}`,
      allowed_formats: ["jpg", "jpeg", "png", "svg", "webp"],
      transformation:  [{ width: 400, height: 400, crop: "limit" }],
    };
  },
});

const brandUpload = multer({
  storage: brandStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
}).single("logo");

const updateCompanyBrand = (req, res) => {
  brandUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      const raw       = req.admin?.company?._id ?? req.admin?.company;
      const companyId = raw ? raw.toString() : null;
      if (!companyId) return res.status(400).json({ message: "Company not found on request" });

      const updates = {};
      if (req.body.name !== undefined) {
        updates.brandName = req.body.name.trim().slice(0, 40);
      }
      if (req.file) {
        updates.brandLogoUrl = req.file.path;
      }
      const company = await Company.findByIdAndUpdate(companyId, updates, { new: true })
        .select("brandName brandLogoUrl");
      res.json({ name: company.brandName, logoUrl: company.brandLogoUrl });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
};

const deleteCompanyLogo = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, { brandLogoUrl: "" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Brevo config ──────────────────────────────────────────────────────────────
const getBrevoConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId).select("+brevoApiKey brevoSenderEmail brevoSenderName").lean();
    res.json({
      connected:   !!(company?.brevoApiKey),
      senderEmail: company?.brevoSenderEmail || "",
      senderName:  company?.brevoSenderName  || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveBrevoFullConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { apiKey, senderEmail, senderName } = req.body;
    if (!apiKey || !apiKey.trim()) return res.status(400).json({ message: "Brevo API key is required" });
    if (!senderEmail || !senderEmail.trim()) return res.status(400).json({ message: "Sender email is required" });
    await Company.findByIdAndUpdate(companyId, {
      brevoApiKey:      apiKey.trim(),
      brevoSenderEmail: senderEmail.trim(),
      brevoSenderName:  (senderName || "CRM").trim(),
    });
    res.json({ success: true, connected: true, senderEmail: senderEmail.trim(), senderName: (senderName || "CRM").trim() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteBrevoConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, { brevoApiKey: "", brevoSenderEmail: "", brevoSenderName: "" });
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── MSG91 config ──────────────────────────────────────────────────────────────
const getMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");
    const waConfig  = await WhatsAppConfig.findOne({ company: companyId }).lean();
    const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();
    const hasAuthKey  = !!(waConfig?.msg91AuthKey || smsConfig?.msg91AuthKey);
    const hasWaNumber = !!(waConfig?.msg91IntegratedNumber);
    res.json({
      connected:        hasAuthKey && hasWaNumber,
      integratedNumber: waConfig?.msg91IntegratedNumber || "",
      namespace:        waConfig?.msg91Namespace        || "",
      brochureUrl:      waConfig?.msg91BrochureUrl      || "",
      authKeySet:       hasAuthKey,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const { authKey, integratedNumber, namespace, brochureUrl } = req.body;
    if (!authKey || !authKey.trim()) return res.status(400).json({ message: "MSG91 Auth Key is required" });
    if (!integratedNumber || !integratedNumber.trim()) return res.status(400).json({ message: "Integrated WhatsApp number is required" });
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");
    await WhatsAppConfig.findOneAndUpdate(
      { company: companyId },
      { company: companyId, provider: "msg91", msg91AuthKey: authKey.trim(),
        msg91IntegratedNumber: integratedNumber.trim(), msg91Namespace: (namespace || "").trim(),
        msg91BrochureUrl: (brochureUrl || "").trim(), isActive: true },
      { upsert: true, new: true }
    );
    await SmsConfig.findOneAndUpdate(
      { company: companyId },
      { company: companyId, msg91AuthKey: authKey.trim(), isActive: true },
      { upsert: true, new: true }
    );
    res.json({ success: true, connected: true, integratedNumber: integratedNumber.trim(), brochureUrl: (brochureUrl || "").trim(), authKeySet: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteMsg91Config = async (req, res) => {
  try {
    const companyId      = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const SmsConfig      = require("../models/SmsConfig");
    await WhatsAppConfig.findOneAndUpdate({ company: companyId }, { msg91AuthKey: "", msg91IntegratedNumber: "", isActive: false });
    await SmsConfig.findOneAndUpdate({ company: companyId }, { msg91AuthKey: "", isActive: false });
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const registerMsg91Webhook = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const WhatsAppConfig = require("../models/WhatsAppConfig");
    const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true }).lean();
    if (!config?.msg91AuthKey) return res.status(400).json({ message: "MSG91 not configured for this company" });

    const authKey          = config.msg91AuthKey;
    const integratedNumber = config.msg91IntegratedNumber;
    const protocol  = req.headers["x-forwarded-proto"] || "https";
    const host      = req.headers["x-forwarded-host"] || req.headers.host;
    const backendUrl = process.env.BACKEND_URL || `${protocol}://${host}`;
    const webhookUrl = `${backendUrl}/msg91-webhook`;
    const headers    = { authkey: authKey, "Content-Type": "application/json" };

    console.log(`🔧 Registering MSG91 webhook: ${webhookUrl} for number ${integratedNumber}`);

    const results = [];
    let linkedToNumber = false;
    let webhookCreated = false;

    const methodAEndpoints = [
      { method: "PUT",   url: "https://control.msg91.com/api/v5/whatsapp/integrated-number",
        body: { integrated_number: integratedNumber, webhook_url: webhookUrl } },
      { method: "PATCH", url: "https://control.msg91.com/api/v5/whatsapp/integrated-number",
        body: { integrated_number: integratedNumber, webhookUrl } },
      { method: "PUT",   url: "https://control.msg91.com/api/v5/whatsapp/integrated-number/settings",
        body: { integrated_number: integratedNumber, response_url: webhookUrl, inbound_url: webhookUrl } },
      { method: "POST",  url: `https://control.msg91.com/api/v5/whatsapp/integrated-number/${integratedNumber}/webhook`,
        body: { webhook_url: webhookUrl, event: "inbound" } },
    ];

    for (const ep of methodAEndpoints) {
      try {
        const r = ep.method === "PUT"   ? await axios.put(ep.url, ep.body, { headers, timeout: 8000 })
                : ep.method === "PATCH" ? await axios.patch(ep.url, ep.body, { headers, timeout: 8000 })
                :                         await axios.post(ep.url, ep.body, { headers, timeout: 8000 });
        results.push({ method: ep.method, url: ep.url, status: r.status, data: r.data });
        console.log(`✅ Method A (${ep.method} ${ep.url}):`, r.data);
        linkedToNumber = true;
        break;
      } catch (e) {
        results.push({ method: ep.method, url: ep.url, status: e.response?.status, error: e.response?.data || e.message });
        console.warn(`⚠️  Method A (${ep.method} ${ep.url}):`, e.response?.data || e.message);
      }
    }

    if (!linkedToNumber) {
      const methodBEndpoints = [
        { url: "https://control.msg91.com/api/v5/webhook",
          body: { name: "CRM Inbound", url: webhookUrl, service: "whatsapp", event: "inbound", integrated_number: integratedNumber } },
        { url: "https://control.msg91.com/api/v5/whatsapp/webhook",
          body: { integrated_number: integratedNumber, webhook_url: webhookUrl, event: "inbound" } },
      ];
      for (const ep of methodBEndpoints) {
        try {
          const r = await axios.post(ep.url, ep.body, { headers, timeout: 8000 });
          results.push({ url: ep.url, status: r.status, data: r.data });
          console.log(`✅ Method B (${ep.url}):`, r.data);
          webhookCreated = true;
          break;
        } catch (e) {
          results.push({ url: ep.url, status: e.response?.status, error: e.response?.data || e.message });
          console.warn(`⚠️  Method B (${ep.url}):`, e.response?.data || e.message);
        }
      }
    }

    const autoRegistered = linkedToNumber || webhookCreated;
    res.json({
      success: true, webhookUrl, autoRegistered, linkedToNumber, webhookCreated, results,
      message: autoRegistered
        ? "Webhook registered with MSG91! Lead replies will now arrive instantly (<2s)."
        : `Auto-registration failed. Set manually: MSG91 → WhatsApp → Integrated Numbers → ${integratedNumber} → Settings → Response Webhook → ${webhookUrl}`,
    });
  } catch (err) {
    console.error("❌ MSG91 webhook registration error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Telegram config ───────────────────────────────────────────────────────────
const getTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company = await Company.findById(companyId)
      .select('telegramEnabled telegramChatId telegramBotToken').lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.json({
      telegramEnabled: company.telegramEnabled  || false,
      telegramChatId:  company.telegramChatId   || '',
      hasToken:        !!(company.telegramBotToken),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { telegramBotToken, telegramChatId, telegramEnabled } = req.body;
    const update = {};
    if (telegramChatId  !== undefined) update.telegramChatId  = (telegramChatId || '').trim();
    if (telegramEnabled !== undefined) update.telegramEnabled  = Boolean(telegramEnabled);
    if (telegramBotToken && String(telegramBotToken).trim()) {
      update.telegramBotToken = String(telegramBotToken).trim();
    }
    await Company.findByIdAndUpdate(companyId, { $set: update });
    res.json({ message: 'Telegram settings saved.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const testTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select('name telegramBotToken telegramChatId').lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    if (!company.telegramBotToken) return res.status(400).json({ message: 'Bot token not configured.' });
    if (!company.telegramChatId)   return res.status(400).json({ message: 'Chat ID not configured.' });
    const { sendTestNotification } = require('../services/telegramService');
    await sendTestNotification(company.telegramBotToken, company.telegramChatId, company.name);
    res.json({ message: 'Test message sent! Check your Telegram group.' });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to send test — check token and chat ID.' });
  }
};

// ── MSG91 Email config ────────────────────────────────────────────────────────
const getMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select("+msg91EmailApiKey msg91EmailDomain msg91EmailSenderEmail msg91EmailSenderName msg91EmailDailyCount msg91EmailCountDate")
      .lean();
    const MSG91_EMAIL_DAILY_LIMIT = 5000;
    const today = new Date().toISOString().slice(0, 10);
    const count = company?.msg91EmailCountDate === today ? (company?.msg91EmailDailyCount || 0) : 0;
    res.json({
      connected:   !!(company?.msg91EmailApiKey && company?.msg91EmailSenderEmail && company?.msg91EmailDomain),
      domain:      company?.msg91EmailDomain      || "",
      senderEmail: company?.msg91EmailSenderEmail || "",
      senderName:  company?.msg91EmailSenderName  || "",
      dailyLimit:  MSG91_EMAIL_DAILY_LIMIT,
      usedToday:   count,
      remaining:   Math.max(0, MSG91_EMAIL_DAILY_LIMIT - count),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { apiKey, domain, senderEmail, senderName } = req.body;
    if (!apiKey      || !apiKey.trim())      return res.status(400).json({ message: "MSG91 Auth Key is required" });
    if (!domain      || !domain.trim())      return res.status(400).json({ message: "Sending domain is required" });
    if (!senderEmail || !senderEmail.trim()) return res.status(400).json({ message: "Sender email is required" });
    await Company.findByIdAndUpdate(companyId, {
      msg91EmailApiKey:      apiKey.trim(),
      msg91EmailDomain:      domain.trim(),
      msg91EmailSenderEmail: senderEmail.trim(),
      msg91EmailSenderName:  (senderName || "CRM").trim(),
    });
    res.json({ success: true, connected: true, domain: domain.trim(), senderEmail: senderEmail.trim(), senderName: (senderName || "CRM").trim() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteMsg91EmailConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    await Company.findByIdAndUpdate(companyId, {
      msg91EmailApiKey: "", msg91EmailDomain: "", msg91EmailSenderEmail: "", msg91EmailSenderName: "",
    });
    res.json({ success: true, connected: false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin Telegram config ─────────────────────────────────────────────────────
const getAdminsTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const admins = await Admin.find({ company: companyId })
      .select("name email role telegramChatId telegramNotificationsEnabled").lean();
    res.json(admins.map(a => ({
      _id:                          a._id,
      name:                         a.name,
      email:                        a.email,
      role:                         a.role,
      telegramChatId:               a.telegramChatId || "",
      telegramNotificationsEnabled: a.telegramNotificationsEnabled !== false,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveAdminTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { adminId } = req.params;
    const { telegramChatId, telegramNotificationsEnabled } = req.body;
    const target = await Admin.findOne({ _id: adminId, company: companyId });
    if (!target) return res.status(404).json({ message: "Admin not found." });
    if (telegramChatId !== undefined) target.telegramChatId = telegramChatId ? String(telegramChatId).trim() : null;
    if (telegramNotificationsEnabled !== undefined) target.telegramNotificationsEnabled = Boolean(telegramNotificationsEnabled);
    await target.save();
    res.json({
      message:                      "Admin Telegram config saved.",
      telegramChatId:               target.telegramChatId || "",
      telegramNotificationsEnabled: target.telegramNotificationsEnabled,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const testAdminTelegramConfig = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { adminId } = req.params;
    const [company, target] = await Promise.all([
      Company.findById(companyId).select("name telegramBotToken").lean(),
      Admin.findOne({ _id: adminId, company: companyId }).select("name telegramChatId").lean(),
    ]);
    if (!company?.telegramBotToken) return res.status(400).json({ message: "Company bot token not configured." });
    if (!target?.telegramChatId)    return res.status(400).json({ message: "Admin chat ID not configured." });
    const text =
      `✅ <b>Telegram Connected!</b>\n\n` +
      `Hello <b>${target.name}</b>, your personal Telegram notifications are now active.\n\n` +
      `You will receive campaign lead alerts for <b>${company.name}</b> in this chat.`;
    const https = require("https");
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: target.telegramChatId, text, parse_mode: "HTML" });
      const req2 = https.request(
        { hostname: "api.telegram.org", path: `/bot${company.telegramBotToken}/sendMessage`,
          method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (r) => {
          let d = "";
          r.on("data", c => { d += c; });
          r.on("end", () => {
            try { const p = JSON.parse(d); p.ok ? resolve(p) : reject(new Error(p.description || "Telegram error")); }
            catch { reject(new Error("Invalid Telegram response")); }
          });
        }
      );
      req2.on("error", reject);
      req2.setTimeout(10000, () => req2.destroy(new Error("Timeout")));
      req2.write(body);
      req2.end();
    });
    res.json({ message: `Test sent to ${target.name}! Check their Telegram.` });
  } catch (err) {
    res.status(500).json({ message: err.message || "Test failed — check token & chat ID." });
  }
};

const updateUserTelegram = async (req, res) => {
  try {
    const { id }             = req.params;
    const { telegramChatId } = req.body;
    const companyId          = req.admin?.company?._id || req.admin?.company;
    const user = await User.findOne({ _id: id, company: companyId });
    if (!user) return res.status(404).json({ message: 'Employee not found' });
    user.telegramChatId = telegramChatId ? String(telegramChatId).trim() : null;
    await user.save();
    res.json({ message: 'Telegram chat ID updated.', telegramChatId: user.telegramChatId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Clock-in location ─────────────────────────────────────────────────────────
const getClockInLocation = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId)
      .select('clockInLocationEnabled clockInLatitude clockInLongitude clockInRadiusMeters').lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    res.json({
      enabled:   company.clockInLocationEnabled || false,
      latitude:  company.clockInLatitude  || null,
      longitude: company.clockInLongitude || null,
      radius:    100, // office geofence radius is fixed at 100m
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const saveClockInLocation = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { enabled, latitude, longitude, radius } = req.body;
    const update = {};
    if (enabled   !== undefined) update.clockInLocationEnabled = Boolean(enabled);
    if (latitude  != null)       update.clockInLatitude        = Number(latitude);
    if (longitude != null)       update.clockInLongitude       = Number(longitude);
    update.clockInRadiusMeters = 100; // office geofence radius is fixed at 100m
    await Company.findByIdAndUpdate(companyId, { $set: update });
    res.json({ message: 'Clock-in location settings saved.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const updateMeetingPermission = async (req, res) => {
  try {
    const { id }    = req.params;
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { grant } = req.body;
    const user = await User.findOne({ _id: id, company: companyId });
    if (!user) return res.status(404).json({ message: 'Employee not found' });
    user.clientMeetingPermission          = Boolean(grant);
    user.clientMeetingPermissionGrantedBy = grant ? (req.admin?._id || null) : null;
    user.clientMeetingPermissionGrantedAt = grant ? new Date() : null;
    user.meetingPermissionRequested       = false;
    user.meetingPermissionStatus          = grant ? 'approved' : 'denied';
    await user.save();
    const _io = global._io;
    if (_io) {
      _io.to(`agent:${String(id)}`).emit('meeting_permission_response', {
        approved:  Boolean(grant),
        grantedAt: user.clientMeetingPermissionGrantedAt?.toISOString() || null,
        adminName: req.admin?.name || 'Admin',
      });
    }
    res.json({
      message:   grant ? 'Remote clock-in permission granted (24h).' : 'Permission revoked.',
      userId:    user._id,
      granted:   user.clientMeetingPermission,
      grantedAt: user.clientMeetingPermissionGrantedAt,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── Attendance config ─────────────────────────────────────────────────────────
const getAttendanceConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const company   = await Company.findById(companyId).select('attendanceConfig').lean();
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const cfg = company.attendanceConfig || {};
    res.json({
      shiftStartHour:    cfg.shiftStartHour    ?? 9,
      shiftStartMinute:  cfg.shiftStartMinute  ?? 0,
      shiftEndHour:      cfg.shiftEndHour       ?? 18,
      shiftEndMinute:    cfg.shiftEndMinute     ?? 0,
      lateLoginHour:     cfg.lateLoginHour      ?? 10,
      lateLoginMinute:   cfg.lateLoginMinute    ?? 30,
      halfDayMinMinutes: cfg.halfDayMinMinutes  ?? 240,
      fullDayMinMinutes: cfg.fullDayMinMinutes  ?? 480,
      weeklyOffDays:     cfg.weeklyOffDays       ?? [0],
      holidays:          cfg.holidays            ?? [],
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const saveAttendanceConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const b = req.body || {};
    const clamp = (v, lo, hi, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); };
    const attendanceConfig = {
      shiftStartHour:    clamp(b.shiftStartHour,   0, 23, 9),
      shiftStartMinute:  clamp(b.shiftStartMinute, 0, 59, 0),
      shiftEndHour:      clamp(b.shiftEndHour,     0, 23, 18),
      shiftEndMinute:    clamp(b.shiftEndMinute,   0, 59, 0),
      lateLoginHour:     clamp(b.lateLoginHour,    0, 23, 10),
      lateLoginMinute:   clamp(b.lateLoginMinute,  0, 59, 30),
      halfDayMinMinutes: clamp(b.halfDayMinMinutes, 0, 1440, 240),
      fullDayMinMinutes: clamp(b.fullDayMinMinutes, 0, 1440, 480),
      weeklyOffDays: Array.isArray(b.weeklyOffDays)
        ? b.weeklyOffDays.map(d => parseInt(d, 10)).filter(d => d >= 0 && d <= 6) : [0],
      holidays: Array.isArray(b.holidays)
        ? b.holidays.filter(h => h && h.date).map(h => ({ date: String(h.date).trim(), name: String(h.name || 'Holiday').trim() })) : [],
    };
    await Company.findByIdAndUpdate(companyId, { $set: { attendanceConfig } });
    res.json({ message: 'Attendance settings saved.', attendanceConfig });
  } catch (err) { res.status(500).json({ message: err.message }); }
};


const getMarketingDashboard = async (req, res) => {
  try {
    const companyId = req.admin.company._id || req.admin.company;
    const { getMarketingDashboard: svc } = require("../services/marketingDashboardService");
    const leadScope = await getAdminLeadScope(req, companyId);
    const data = await svc({ company: companyId, query: req.query, leadScope });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── SECURITY FIX replacement feature ──────────────────────────────────────────
// Previously, a super_admin could VIEW any existing admin/user's actual
// password at any time (via the deprecated plainPassword field). That's the
// vulnerability fixed in models/Admin.js / models/Users.js. The replacement:
// admins can RESET a password to a brand-new random one, shown ONCE in the
// response for the "copy this now" modal, and never stored anywhere
// retrievable afterward. This is strictly less powerful than the old feature
// (can't recover a still-active password) but is the correct trade-off —
// authentication information should never be recoverable, only resettable.

// Generates a random, readable-but-strong password: 12 chars, mixed case +
// digits + one symbol, avoiding visually-ambiguous characters (0/O, 1/l/I).
function generateSecurePassword() {
  const upper  = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower  = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbol = "!@#$%&*";
  const all    = upper + lower + digits + symbol;

  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(symbol)];
  const rest = Array.from({ length: 8 }, () => pick(all));

  // Shuffle so the required-character positions aren't predictable.
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// PATCH /api/admin/:id/reset-password — reset another ADMIN's password
// (super_admin only — an admin resetting another admin's password is a
// privileged action).
const resetAdminPassword = async (req, res) => {
  try {
    if (req.admin.role !== "super_admin") {
      return res.status(403).json({ message: "Only a super admin can reset another admin's password" });
    }
    const target = await Admin.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "Admin not found" });
    if (String(target.company) !== String(req.admin.company?._id || req.admin.company)) {
      return res.status(403).json({ message: "Admin not in your company" });
    }

    const newPassword = generateSecurePassword();
    target.password = newPassword; // pre-save hook hashes it — never stored plain
    await target.save();

    res.json({
      success: true,
      message: "Password reset. Share this with the admin now — it will not be shown again.",
      newPassword, // one-time reveal only, never persisted
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/admin/user/:id/reset-password — reset an EMPLOYEE's password
// (admin or super_admin, scoped to their own company).
const resetUserPassword = async (req, res) => {
  try {
    const companyId = req.admin.company?._id || req.admin.company;
    const target = await User.findOne({ _id: req.params.id, company: companyId });
    if (!target) return res.status(404).json({ message: "User not found" });

    const newPassword = generateSecurePassword();
    target.password = newPassword; // pre-save hook hashes it — never stored plain
    await target.save();

    res.json({
      success: true,
      message: "Password reset. Share this with the employee now — it will not be shown again.",
      newPassword, // one-time reveal only, never persisted
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getMyCompany,
  getAdmin,
  getAdmins,
  createAdmin,
  deleteAdmin,
  updateAdmin,
  getCompanyUsers,
  getCompanyLeads,
  getMarketingDashboard,
  getDistinctLeadLanguages,
  updateLeadLanguage,
  updateUserLanguages,
  createCompanyUser,
  deleteCompanyUser,
  resetAdminPassword,
  resetUserPassword,
  getDashboardStats,
  getAutoTemplateSettings,
  updateAutoTemplateSettings,
  getInterestedBlastSettings,
  updateInterestedBlastSettings,
  testAutoTemplate,
  testInterestedBlast,
  getCompanyBrand,
  updateCompanyBrand,
  deleteCompanyLogo,
  getBrevoConfig,
  saveBrevoFullConfig,
  deleteBrevoConfig,
  getMsg91Config,
  saveMsg91Config,
  deleteMsg91Config,
  getMsg91EmailConfig,
  saveMsg91EmailConfig,
  deleteMsg91EmailConfig,
  getTelegramConfig,
  saveTelegramConfig,
  testTelegramConfig,
  getAdminsTelegramConfig,
  saveAdminTelegramConfig,
  testAdminTelegramConfig,
  updateUserTelegram,
  getClockInLocation,
  saveClockInLocation,
  updateMeetingPermission,
  registerMsg91Webhook,
  getLateLoginConfig:  getAttendanceConfig,
  saveLateLoginConfig: saveAttendanceConfig,
  getAttendanceConfig,
  saveAttendanceConfig,
};
