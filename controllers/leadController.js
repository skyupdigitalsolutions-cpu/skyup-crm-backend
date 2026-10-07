// controllers/leadController.js
// Merge Number feature removed; Single Additional Phone Number system
const { maskPhone, maskEmail, maskLeadPII } = require('../utils/maskPhone');

// ── Get caller role from request (works for all middleware types) ─────────────
function getCallerRole(req) {
  return (
    req.superAdmin?.role ||
    req.admin?.role ||
    req.user?.role ||
    "user"
  );
}

// ── Get caller _id — used to check ownership for masking ─────────────────────
function getCallerId(req) {
  return req.user?._id || req.admin?._id || req.superAdmin?._id || null;
}

const Lead = require("../models/Leads");
const User = require("../models/Users");
const mongoose = require("mongoose");
const { readPagination, sendList, applyPage } = require("../utils/paginate");
const Company = require("../models/Company");
const { normalizePhone } = require("../utils/normalizePhone");
const { computeQuality } = require("../utils/qualityHelper");
const { getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");
const {
  sendNewLeadNotification,
  sendReassignedLeadNotification,
  notifySuperAdminReassignment,
} = require("../services/fcmService");

// ── Resolve companyId from req ────────────────────────────────────────────────
const getCompanyId = (req) =>
  req.companyId ||
  (req.admin ? req.admin.company?._id || req.admin.company : null) ||
  (req.superAdmin
    ? req.superAdmin.company?._id || req.superAdmin.company
    : null) ||
  req.user?.company ||
  null;

// Auto-template service — direct in-process calls, no HTTP, no auth tokens
const { autoSendTemplates, sendInterestedBlast } = require("../services/autoTemplateService");
const { sendOutcomeAutomation } = require("../services/outcomeAutomationService");
const { triggerNurtureForLead, NURTURE_COMPANY_ID } = require("../jobs/nurtureSequenceJob");
const { sendMetaConversionEvent } = require("../services/metaConversionService");
const { getCompanyEntitlements } = require("../services/entitlementService");
const { notifyCampaignLead, notifyEmployeeLead, notifyEmployeeFollowUp, notifyAllAdminsCampaignLead } = require("../services/telegramService");
const { INDUSTRIES, SERVICES } = require("../utils/templateNameResolver");

// ── Per-company customization (statuses, outcomes, workflows, permissions …) ──
// Every status / outcome / temperature / flow rule below is read from the
// company's customization instead of being hardcoded. With no customization
// saved, the defaults reproduce the previous hardcoded behaviour exactly.
const custSvc = require("../services/customizationService");
const teamScope = require("../utils/teamScope");
const getCust = (companyId) => custSvc.getCustomization(companyId);

// Industry/service validation: the company's own lists PLUS the canonical
// nurture lists (templateNameResolver) so existing nurture templates keep
// resolving. An unrecognised value is silently dropped (same as before).
function validNurtureSet(cust, listName, canonical) {
  return new Set([...(canonical || []), ...((cust?.lists?.[listName]) || [])].map((v) => String(v).trim()));
}

// Industry + services from a request body → normalised update fields.
//   industry: one of the company's industries, or (leadFields.industry.allowOther)
//             any typed value ("Other: X" is accepted and stored as "X"). "" clears.
//   services: body.services (array or comma string) or body.service (string).
//             Unknown values dropped unless leadFields.service.allowOther.
//             Single-select companies keep only the first. [] / "" clears.
//   Lead.service always mirrors services[0] (nurture templates, old clients).
function readIndustryServices(cust, body = {}) {
  const out = {};
  const lf = cust?.leadFields || {};
  const clean = (v, max = 80) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  if (body.industry !== undefined && body.industry !== null) {
    let v = clean(body.industry).replace(/^other\s*[:-]\s*/i, "");
    if (/^other$/i.test(v)) v = "";
    const valid = [...validNurtureSet(cust, "industries", INDUSTRIES)];
    const hit = valid.find((x) => x.toLowerCase() === v.toLowerCase());
    if (!v) out.industry = "";
    else if (hit) out.industry = hit;
    else if (lf.industry?.allowOther !== false) out.industry = v;
  }
  let raw;
  if (body.services !== undefined && body.services !== null) raw = body.services;
  else if (body.service !== undefined && body.service !== null) raw = body.service;
  if (raw !== undefined) {
    let arr = Array.isArray(raw) ? raw : String(raw).split(/\s*[,|]\s*/);
    const valid = [...validNurtureSet(cust, "services", SERVICES)];
    const seen = new Set();
    arr = arr.map((x) => clean(x)).filter(Boolean)
      .map((v) => valid.find((x) => x.toLowerCase() === v.toLowerCase()) || (lf.service?.allowOther ? v : null))
      .filter((v) => {
        if (!v || seen.has(v.toLowerCase())) return false;
        seen.add(v.toLowerCase());
        return true;
      })
      .slice(0, 25);
    if (lf.service?.multiple === false) arr = arr.slice(0, 1);
    out.services = arr;
    out.service = arr[0] || "";
  }
  return out;
}

// True when the request comes from an employee session (not admin/super_admin).
function isEmployeeReq(req) {
  if (req.admin || req.superAdmin) return false;
  const role = String(req.user?.role || "user");
  return role === "user" || role === "employee";
}

// Enforce a company permission for employees. Admin callers are not affected
// (admin-side permissions are checked separately with adminDenied()).
// Returns true when the request was rejected (caller should `return`).
function employeeDenied(req, res, cust, permissionName, what) {
  if (!isEmployeeReq(req)) return false;
  if (custSvc.permission(cust, "employee", permissionName)) return false;
  res.status(403).json({
    message: `Your company has disabled ${what} for employees.`,
    code: "PERMISSION_DISABLED",
    permission: permissionName,
  });
  return true;
}

function adminDenied(req, res, cust, permissionName, what) {
  const role = req.superAdmin ? "super_admin" : (req.admin?.role || "");
  if (!req.admin && !req.superAdmin) return false;
  if (role === "super_admin" || role === "superadmin") return false; // owner can always
  if (custSvc.permission(cust, "admin", permissionName)) return false;
  res.status(403).json({
    message: `Your company has disabled ${what} for admins.`,
    code: "PERMISSION_DISABLED",
    permission: permissionName,
  });
  return true;
}

// Map any status input (key / renamed label / alias) to the stored key.
// Unknown → `fallback` (default: the company's default status).
function resolveStatusKey(cust, value, fallback) {
  const s = custSvc.findStatus(cust, value);
  if (s) return s.key;
  return fallback !== undefined ? fallback : custSvc.defaultStatusKey(cust);
}

// Map a temperature input to the stored key, or null when not a known quality.
function resolveTemperatureKey(cust, value) {
  const t = custSvc.findTemperature(cust, value);
  return t ? t.key : null;
}

// Validate custom field values from a request body. Accepts either
// body.customFields = { key: value } or flat body keys matching field keys.
function readCustomFields(cust, body, role, partial) {
  const fields = cust?.customFields || [];
  if (!fields.length || !body) return { values: {}, errors: [] };
  const src = { ...(body.customFields && typeof body.customFields === "object" ? body.customFields : {}) };
  for (const f of fields) {
    if (src[f.key] === undefined && body[f.key] !== undefined) src[f.key] = body[f.key];
    if (src[f.key] === undefined && body[f.label] !== undefined) src[f.key] = body[f.label]; // CSV header by label
  }
  return custSvc.sanitizeCustomFieldValues(cust, src, { role, partial });
}

// Required built-in fields (Customize CRM → Lead Fields).
function missingRequiredLeadFields(cust, data) {
  const lf = cust?.leadFields || {};
  const missing = [];
  for (const k of ["email", "source", "campaign", "industry", "service", "businessName", "language", "secondaryPhone"]) {
    if (lf[k]?.visible !== false && lf[k]?.required && !String(data?.[k] ?? "").trim()) missing.push(lf[k].label || k);
  }
  return missing;
}

// ── Helper: pick next user for a lead ─────────────────────────────────────────
//   purpose "assign" → company's assignment strategy (least_loaded | round_robin | manual)
//   purpose "verify" → always least-loaded (picking a verifier, never manual)
// previousAgents / excludeIds are skipped when anyone else is available.
async function getNextUser(companyId, excludeIds = [], { purpose = "verify", cust: custIn } = {}) {
  const cust = custIn || await getCust(companyId);
  const strategy = purpose === "assign" ? (cust.workflows?.assignment?.strategy || "least_loaded") : "least_loaded";
  if (strategy === "manual") return null;

  const users = await User.find({ company: companyId }).select("_id").sort({ _id: 1 }).lean();
  if (!users.length) return null;
  const pool = users.filter(
    (u) => !excludeIds.some((e) => e && e.toString() === u._id.toString()),
  );
  const candidates = pool.length > 0 ? pool : users;

  if (strategy === "round_robin") {
    // Atomic counter on the company so concurrent creates don't collide.
    const updated = await Company.findByIdAndUpdate(
      companyId,
      { $inc: { roundRobinIndex: 1 } },
      { new: true, projection: { roundRobinIndex: 1 } },
    ).lean();
    const idx = Math.max(0, ((updated?.roundRobinIndex || 1) - 1)) % candidates.length;
    return candidates[idx]._id;
  }

  const closed = custSvc.closedStatusKeys(cust);
  const counts = await Promise.all(
    candidates.map((u) =>
      Lead.countDocuments({
        company: companyId,
        user: u._id,
        status: { $nin: closed },
      }).then((c) => ({ userId: u._id, count: c })),
    ),
  );
  counts.sort((a, b) => a.count - b.count);
  return counts[0].userId;
}

// ── Helper: build the scheduled calls a workflow adds (company-configurable;
// default = +3d follow-up, +7d & +30d verification) ───────────────────────────
function buildScheduledCalls(cust, flow = "notInterested") {
  const cfg = cust?.workflows?.[flow]?.followUps;
  return custSvc.buildScheduledFollowUps(cfg || custSvc.buildDefaults().workflows[flow].followUps);
}

// ── Phone uniqueness check: returns existing lead if number already taken ──────
// Checks both primaryPhone and secondaryPhone across the entire company.
async function findLeadByPhone(
  companyId,
  normalizedNumber,
  excludeLeadId = null,
) {
  const query = {
    company: companyId,
    $or: [
      { normalizedPhone: normalizedNumber },
      { normalizedSecondaryPhone: normalizedNumber },
    ],
  };
  if (excludeLeadId) query._id = { $ne: excludeLeadId };
  return Lead.findOne(query)
    .select("name mobile primaryPhone secondaryPhone status user")
    .lean();
}

// ── GET all leads (user sees own + unassigned) ────────────────────────────────
const getLeads = async (req, res) => {
  try {
    const filter = {
      company: getCompanyId(req),
      $or: [{ user: req.user._id }, { user: null }],
      mergedInto: null,
    };
    // Opt-in pagination (?page=&limit=) — see utils/paginate.js
    const pg = readPagination(req, { defaultLimit: 100, maxLimit: 500 });
    const [leads, total] = await Promise.all([
      applyPage(Lead.find(filter).sort({ createdAt: -1 }), pg)
        .select(MOBILE_LIST_PROJECTION)
        .populate("user", "name email")
        .lean(),
      pg.enabled ? Lead.countDocuments(filter) : null,
    ]);
    // SECURITY: mask PII — employees see full numbers for their own leads
    const callerRole = req.user?.role || "user";
    const callerId = getCallerId(req);
    const masked = leads.map(l => maskLeadPII(l.toObject ? l.toObject() : l, callerRole, callerId));
    return sendList(res, masked, pg, total);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    // SECURITY: mask PII for non-superadmin roles — employees see own leads unmasked
    const callerRole = getCallerRole(req);
    const callerId = getCallerId(req);
    res.status(200).json(maskLeadPII(lead.toObject ? lead.toObject() : lead, callerRole, callerId));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLeadsByCampaign = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { campaign, adSetName, metaConfigId } = req.query;

    // Exact path: when the card passes its metaConfigId, scope strictly to that
    // config (plus any LEGACY leads — metaConfigId:null — that predate the
    // metaConfigId field). Legacy leads are matched carefully so an ad-set
    // sibling's leads never bleed onto the bare-campaign card and vice-versa:
    //   • Ad-set config  (adSetName present) → legacy must match campaign + that
    //     exact adSetName.
    //   • Bare campaign   (no adSetName)      → legacy must match campaign AND
    //     have NO adSetName of its own, so leads that belong to a named ad set
    //     are not absorbed here.
    if (metaConfigId) {
      const or = [{ metaConfigId }];
      if (campaign) {
        const legacy = { metaConfigId: null, campaign };
        if (adSetName && adSetName.trim() !== "") {
          legacy.adSetName = adSetName.trim();
        } else {
          // Bare campaign: exclude any legacy lead that carries an ad-set name.
          legacy.$or = [
            { adSetName: { $in: [null, ""] } },
            { adSetName: { $exists: false } },
          ];
        }
        or.push(legacy);
      }
      const scope = await getAdminLeadScope(req, companyId);
      const q = mergeLeadScope({ company: companyId, $or: or }, scope);
      const pgA = readPagination(req, { defaultLimit: 100, maxLimit: 500 });
      const [rawLeads, totalA] = await Promise.all([
        applyPage(Lead.find(q).sort({ createdAt: -1 }), pgA)
          .select(ADMIN_LIST_PROJECTION)
          .populate("user", "name email")
          .lean(),
        pgA.enabled ? Lead.countDocuments(q) : null,
      ]);
      // SECURITY: mask PII based on caller role
      const callerRole = getCallerRole(req);
      const callerId = getCallerId(req);
      const leads = rawLeads.map(l => maskLeadPII(l.toObject ? l.toObject() : l, callerRole, callerId));
      return sendList(res, leads, pgA, totalA);
    }

    if (!campaign)
      return res
        .status(400)
        .json({ message: "campaign query param is required" });

    // Build filter — when adSetName is provided, scope leads to that specific
    // ad set so the Campaigns page drill-down shows only the correct subset.
    const filter = { company: companyId, campaign };
    if (adSetName && adSetName.trim() !== "") {
      filter.adSetName = adSetName.trim();
    }

    const scope = await getAdminLeadScope(req, companyId);
    const fq = mergeLeadScope(filter, scope);
    const pgB = readPagination(req, { defaultLimit: 100, maxLimit: 500 });
    const [leads, totalB] = await Promise.all([
      applyPage(Lead.find(fq).sort({ createdAt: -1 }), pgB)
        .populate("user", "name email")
        .populate("previousAgents", "name email")
        .lean(),
      pgB.enabled ? Lead.countDocuments(fq) : null,
    ]);
    // SECURITY: mask PII based on caller role
    const adminRole = req.admin?.role || req.superAdmin?.role || "admin";
    const callerId = getCallerId(req);
    const masked = leads.map(l => maskLeadPII(l.toObject ? l.toObject() : l, adminRole, callerId));
    return sendList(res, masked, pgB, totalB);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDistinctCampaigns = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const scope = await getAdminLeadScope(req, companyId);
    const campaigns = await Lead.distinct(
      "campaign",
      mergeLeadScope({ company: companyId, campaign: { $nin: [null, ""] } }, scope)
    );
    res.status(200).json({
      success: true,
      data: campaigns.filter(Boolean).sort(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User creates a lead manually ──────────────────────────────────────────────
const createLead = async (req, res) => {
  try {
    const companyId    = getCompanyId(req);
    const primaryMobile  = req.body.mobile || req.body.primaryPhone || "";
    const secondaryMobile = req.body.secondaryPhone || null;
    const normPrimary    = normalizePhone(primaryMobile);
    const normSecondary  = secondaryMobile ? normalizePhone(secondaryMobile) : null;

    if (!normPrimary) {
      return res.status(400).json({ message: "A valid primary phone number is required." });
    }
    if (normSecondary && normSecondary === normPrimary) {
      return res.status(400).json({ message: "Secondary phone cannot be the same as primary." });
    }
    // PERF: both duplicate checks + customization in ONE parallel round trip.
    const [secConflict, conflict, cust] = await Promise.all([
      normSecondary ? findLeadByPhone(companyId, normSecondary) : null,
      findLeadByPhone(companyId, normPrimary),
      getCust(companyId),
    ]);
    if (secConflict) {
      return res.status(409).json({
        message: `Secondary number already belongs to lead "${secConflict.name}"`,
        duplicate: true, lead: secConflict,
      });
    }
    if (conflict) {
      return res.status(409).json({
        message: `Primary number already belongs to lead "${conflict.name}"`,
        duplicate: true, lead: conflict,
      });
    }

    if (employeeDenied(req, res, cust, "canAddLeads", "adding leads")) return;
    const missing = missingRequiredLeadFields(cust, req.body);
    if (missing.length) return res.status(400).json({ message: `Required: ${missing.join(", ")}` });
    const cf = readCustomFields(cust, req.body, isEmployeeReq(req) ? "employee" : "admin", false);
    if (cf.errors.length) return res.status(400).json({ message: cf.errors.join(" "), errors: cf.errors });

    const lc = cust.workflows.leadCreation;

    // ── Who owns the new lead ────────────────────────────────────────────────
    // Employee → always themselves. Team Lead → themselves, or (if "Can
    // reassign leads" is on for Team Leads) any member of their own team.
    // Previously `req.body.user` was trusted blindly, so any id was accepted.
    const selfId = String(req.user._id);
    let ownerId = selfId;
    const wanted = req.body && req.body.user ? String(req.body.user) : "";
    if (wanted && wanted !== selfId) {
      const allowed = req.user.isTeamLead
        && custSvc.permission(cust, "teamLead", "canReassignLeads")
        && (await teamScope.isInTeam(companyId, selfId, wanted));
      if (!allowed) {
        return res.status(403).json({ message: "You can only assign a new lead to yourself or a member of your own team." });
      }
      ownerId = wanted;
    }

    // Strip anything the client must not set directly on create.
    const {
      company: _c, customFields: _cf, isClosed: _ic, mergedInto: _mi, callHistory: _ch,
      scheduledCalls: _sc, activityTimeline: _at, previousAgents: _pa, user: _u, ...body
    } = req.body || {};
    const lead = await Lead.create({
      ...body,
      status:  resolveStatusKey(cust, body.status),
      source:  body.source || lc.defaultSource || "Manual",
      remark:  body.remark || lc.defaultRemark || "Manually added",
      date:    body.date || new Date(),
      temperature: body.temperature !== undefined ? resolveTemperatureKey(cust, body.temperature) : null,
      customFields: cf.values,
      mobile:        primaryMobile,
      primaryPhone:  primaryMobile,
      secondaryPhone: normSecondary ? secondaryMobile : null,
      user:    ownerId,
      company: companyId,
      addedManually: true,
      ...(ownerId !== selfId ? {
        activityTimeline: [{
          action: "assigned", performedBy: req.user._id, role: "team_lead", timestamp: new Date(),
          note: `Added and assigned by Team Lead ${req.user.name || ""}`.trim(),
        }],
      } : {}),
    });

    if (ownerId !== selfId) {
      try { global._io && global._io.to(`agent:${ownerId}`).emit("new_lead_assigned", { leadId: String(lead._id), leadName: lead.name, count: 1, eventType: "assigned" }); } catch { /* ignore */ }
      try {
        const { sendReassignedLeadNotification } = require("../services/fcmService");
        if (typeof sendReassignedLeadNotification === "function") sendReassignedLeadNotification(ownerId, lead).catch(() => {});
      } catch { /* push is best-effort */ }
    }

    autoSendTemplates(lead, companyId);
    // SECURITY: mask PII in create response
    res.status(201).json(maskLeadPII(lead.toObject ? lead.toObject() : lead, getCallerRole(req), getCallerId(req)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin creates a single lead ───────────────────────────────────────────────
const adminCreateLead = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const cust = await getCust(companyId);
    const missing = missingRequiredLeadFields(cust, req.body);
    if (missing.length) return res.status(400).json({ message: `Required: ${missing.join(", ")}` });
    const cf = readCustomFields(cust, req.body, "admin", false);
    if (cf.errors.length) return res.status(400).json({ message: cf.errors.join(" "), errors: cf.errors });
    const lc = cust.workflows.leadCreation;
    const manualAssignment = cust.workflows.assignment.strategy === "manual";

    let assignedUser = req.body.user || null;
    if (!assignedUser && !manualAssignment) {
      assignedUser = await getNextUser(companyId, [], { purpose: "assign", cust });
      if (!assignedUser)
        return res.status(400).json({
          message: "No users found in this company to assign the lead.",
        });
    }

    // ── Phone uniqueness check before creating ────────────────────────────────
    const primaryMobile = req.body.mobile || req.body.primaryPhone || "";
    const secondaryMobile = req.body.secondaryPhone || null;
    const normPrimary = normalizePhone(primaryMobile);
    const normSecondary = secondaryMobile
      ? normalizePhone(secondaryMobile)
      : null;

    if (normPrimary) {
      const conflict = await findLeadByPhone(companyId, normPrimary);
      if (conflict) {
        return res.status(409).json({
          message: `Primary number already belongs to lead "${conflict.name}"`,
          duplicate: true,
          lead: conflict,
        });
      }
    }
    if (normSecondary) {
      if (normSecondary === normPrimary) {
        return res
          .status(400)
          .json({
            message: "Additional number cannot be the same as primary.",
          });
      }
      const conflict = await findLeadByPhone(companyId, normSecondary);
      if (conflict) {
        return res.status(409).json({
          message: `Additional number already belongs to lead "${conflict.name}"`,
          duplicate: true,
          lead: conflict,
        });
      }
    }

    const lead = await Lead.create({
      name: req.body.name,
      mobile: primaryMobile,
      primaryPhone: primaryMobile,
      secondaryPhone: normSecondary ? secondaryMobile : null,
      email: req.body.email || "",
      source: req.body.source || lc.defaultSource || "Web Form",
      campaign: req.body.campaign || null,
      status: resolveStatusKey(cust, req.body.status),
      date: req.body.date || new Date(),
      remark: req.body.remark || lc.defaultRemark || "Manually added",
      temperature:
        resolveTemperatureKey(cust, req.body.temperature) ||
        (lc.autoTemperature
          ? computeQuality(
              {
                name: req.body.name || "",
                mobile: primaryMobile,
                email: req.body.email || "",
                _extraAnswers: [],
              },
              0,
            )
          : null),
      ...readIndustryServices(cust, req.body),
      ...(req.body.businessName ? { businessName: String(req.body.businessName).trim() } : {}),
      ...(req.body.language ? { language: String(req.body.language).trim() } : {}),
      customFields: cf.values,
      user: assignedUser,
      company: companyId,
      assignedAdmin: req.admin?._id || req.superAdmin?._id || null,
      addedManually: true,
    });

    const populated = await Lead.findById(lead._id)
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    const io = global._io;
    if (io) {
      io.to(`wa_admin_${String(companyId)}`).emit("wa_new_lead", {
        lead: {
          _id: lead._id,
          name: lead.name,
          mobile: lead.mobile,
          cleanPhone: (lead.mobile || "").replace(/\D/g, ""),
          status: lead.status,
          source: lead.source,
          campaign: lead.campaign,
          date: lead.date,
          createdAt: lead.createdAt,
          user: populated?.user || null,
          existingConversationId: null,
          existingConversationStatus: null,
        },
      });

      if (assignedUser) {
        io.to(`agent:${assignedUser}`).emit("new_lead_assigned", {
          leadId: String(lead._id),
          leadName: lead.name,
          source: lead.source || "Web Form",
          eventType: "new",
        });
      }
    }


    autoSendTemplates(populated, companyId);
    // Telegram — campaign filter inside notifyCampaignLead; manual leads are silently skipped
    notifyCampaignLead(lead, companyId).catch(e =>
      console.error("[Telegram] adminCreateLead notify error:", e.message)
    );
    // FIX (telegram notifications): notifyAllAdminsCampaignLead existed in
    // telegramService.js — with its own message builder, entitlement gate,
    // and a full settings UI (TelegramSettings.jsx) letting a super-admin
    // configure each admin's personal chat ID + opt-in toggle — but was
    // never actually called anywhere. Admins who set this up never received
    // a single notification. Wired in here, next to the company-level call.
    notifyAllAdminsCampaignLead(lead, companyId).catch(e =>
      console.error("[Telegram] adminCreateLead admin-notify error:", e.message)
    );
    // Telegram — notify assigned employee personally for ANY lead source
    if (assignedUser) {
      notifyEmployeeLead(assignedUser, lead, companyId).catch(e =>
        console.error("[Telegram] employee notify error:", e.message)
      );
    }

    if (assignedUser) {
      sendNewLeadNotification(assignedUser, lead).catch((e) =>
        console.error("[FCM] adminCreateLead push error:", e.message),
      );
    }

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin bulk create leads ───────────────────────────────────────────────────
const adminCreateLeadsBulk = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const items = req.body.leads;
    if (!Array.isArray(items) || items.length === 0)
      return res
        .status(400)
        .json({ message: "leads array is required and must not be empty." });
    if (items.length > 50)
      return res
        .status(400)
        .json({ message: "Maximum 50 leads per bulk request." });
    const fallbackUser = await User.findOne({ company: companyId })
      .select("_id")
      .lean();
    const cust = await getCust(companyId);
    const lc = cust.workflows.leadCreation;
    const manualAssignment = cust.workflows.assignment.strategy === "manual";
    const results = [],
      errors = [];
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
     try {
        const assignedUser = row.user || (manualAssignment ? null : (fallbackUser ? fallbackUser._id : null));
        if (!assignedUser && !manualAssignment) {
          errors.push({ index: i, message: "No user found." });
          continue;
        }
        const cf = readCustomFields(cust, row, "admin", false);
        if (cf.errors.length) {
          errors.push({ index: i, row: row.name || i, message: cf.errors.join(" ") });
          continue;
        }

        const primaryMobile   = row.mobile || row.primaryPhone || "";
        const secondaryMobile = row.secondaryPhone || null;
        const normPrimary     = normalizePhone(primaryMobile);
        const normSecondary   = secondaryMobile ? normalizePhone(secondaryMobile) : null;

        if (!normPrimary) {
          errors.push({ index: i, row: row.name || i, message: "Missing or invalid primary phone number." });
          continue;
        }
        if (normSecondary && normSecondary === normPrimary) {
          errors.push({ index: i, row: row.name || i, message: "Secondary phone cannot be the same as primary." });
          continue;
        }
        const primaryConflict = await findLeadByPhone(companyId, normPrimary);
        if (primaryConflict) {
          errors.push({ index: i, row: row.name || i, message: `Primary number already belongs to lead "${primaryConflict.name}"` });
          continue;
        }
        if (normSecondary) {
          const secConflict = await findLeadByPhone(companyId, normSecondary);
          if (secConflict) {
            errors.push({ index: i, row: row.name || i, message: `Secondary number already belongs to lead "${secConflict.name}"` });
            continue;
          }
        }

        const lead = await Lead.create({
          name:          row.name,
          mobile:        primaryMobile,
          primaryPhone:  primaryMobile,
          secondaryPhone: normSecondary ? secondaryMobile : null,
          source:        row.source   || lc.defaultSource || "Web Form",
          campaign:      row.campaign || null,
          status:        resolveStatusKey(cust, row.status),
          date:          row.date     || new Date(),
          remark:        row.remark   || lc.defaultRemark || "Manually added",
          ...(row.temperature ? { temperature: resolveTemperatureKey(cust, row.temperature) } : {}),
          customFields:  cf.values,
          user:          assignedUser,
          company:       companyId,
          assignedAdmin: req.admin?._id || req.superAdmin?._id || null,
        });


        results.push(
          await Lead.findById(lead._id)
            .populate("user", "name email")
            .populate("previousAgents", "name email"),
        );
      } catch (err) {
        errors.push({ index: i, message: err.message });
      }
    }
    res.status(207).json({
      saved: results,
      errors,
      total: items.length,
      savedCount: results.length,
      errorCount: errors.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin import CSV ──────────────────────────────────────────────────────────
const adminImportCSV = async (req, res) => {
  try {
    const companyId = getCompanyId(req); // admin or super admin
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const rows = req.body.leads;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No leads provided in CSV." });
    const cust = await getCust(companyId);
    if (adminDenied(req, res, cust, "canImportLeads", "lead import")) return;
    const lc = cust.workflows.leadCreation;
    // Per-import choice (assignMode) overrides the company default.
    const { resolvePoolAdmins, IMPORT_MODES } = require("./leadAssignmentController");
    const importStrategy = IMPORT_MODES.includes(req.body.assignMode)
      ? req.body.assignMode
      : (cust.workflows.assignment.importStrategy || "round_robin");
    // Manual → shared pool: leads stay unassigned and every ticked admin sees
    // them under "Unassigned" until one of them assigns them to an employee.
    let poolAdmins = [];
    if (importStrategy === "manual") {
      const pool = await resolvePoolAdmins(req, companyId, req.body.poolAdmins);
      if (pool.error) return res.status(400).json({ message: pool.error });
      poolAdmins = pool.poolAdmins;
    }
    const users = await User.find({ company: companyId }).select("_id").lean();
    if (!users.length && importStrategy !== "unassigned" && importStrategy !== "manual")
      return res
        .status(400)
        .json({ message: "No users found in this company." });
    const results = [],
      errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const assignedUser =
          importStrategy === "unassigned" || importStrategy === "manual" ? null
          : importStrategy === "least_loaded" ? await getNextUser(companyId, [], { purpose: "verify", cust })
          : users[i % users.length]._id;
        const cf = readCustomFields(cust, row, "admin", false);
        if (cf.errors.length) {
          errors.push({ index: i, row: row.name || i, message: cf.errors.join(" ") });
          continue;
        }
        const mobile =
          row["Primary Number"] ||
          row.mobile ||
          row.phone ||
          row["Primary Phone"] ||
          "";
        const secondaryPhone =
          row["Additional Number"] ||
          row["Secondary Number"] ||
          row.secondaryPhone ||
          row["Secondary Phone"] ||
          null;
        const normPrimary = normalizePhone(mobile);
        const normSecondary = secondaryPhone
          ? normalizePhone(secondaryPhone)
          : null;

        // Validate: same number not in both fields
        if (normSecondary && normSecondary === normPrimary) {
          errors.push({
            index: i,
            row: row.name || i,
            message: "Additional number same as primary — skipped",
          });
          continue;
        }

        // Check uniqueness of primary number
        if (normPrimary) {
          const conflict = await findLeadByPhone(companyId, normPrimary);
          if (conflict) {
            errors.push({
              index: i,
              row: row.name || i,
              message: `Primary number already belongs to lead "${conflict.name}"`,
            });
            continue;
          }
        }

        // Check uniqueness of secondary number
        if (normSecondary) {
          const conflict = await findLeadByPhone(companyId, normSecondary);
          if (conflict) {
            errors.push({
              index: i,
              row: row.name || i,
              message: `Additional number already belongs to lead "${conflict.name}"`,
            });
            continue;
          }
        }

        const csvExtraAnswers = Object.keys(row)
          .filter(
            (k) =>
              ![
                "name",
                "mobile",
                "phone",
                "email",
                "source",
                "campaign",
                "status",
                "date",
                "remark",
                "leadgenId",
                "user",
                "Primary Number",
                "Additional Number",
                "Secondary Number",
                "Primary Phone",
                "Secondary Phone",
                "primaryPhone",
                "secondaryPhone",
              ].includes(k),
          )
          .map((k) => row[k]);

        const adminDoc = {
          name: row.name || "Unknown",
          mobile,
          primaryPhone: mobile,
          secondaryPhone: normSecondary ? secondaryPhone : null,
          normalizedSecondaryPhone: normSecondary || null,
          email: row.email || "",
          source: row.source || lc.defaultImportSource || "Excel Import",
          campaign: row.campaign || null,
          importedViaCsv: true,
          status: resolveStatusKey(cust, row.status),
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || row.notes || lc.defaultImportRemark || "Imported via Excel",
          customFields: cf.values,
          temperature:
            resolveTemperatureKey(cust, row.temperature) ||
            computeQuality(
              {
                name: row.name || "",
                mobile,
                email: row.email || "",
                _extraAnswers: csvExtraAnswers,
              },
              csvExtraAnswers.length,
            ),
          user: assignedUser,
          company: companyId,
          // Pool leads have no owning admin until claimed; otherwise the
          // importing admin owns them (super admin → none, as before).
          assignedAdmin: importStrategy === "manual" ? null : (req.admin?._id || null),
          poolAdmins,
        };
        if (row.leadgenId) adminDoc.leadgenId = row.leadgenId;

        const inserted = await Lead.collection.insertOne(adminDoc);
        const savedLead = await Lead.findById(inserted.insertedId)
          .populate("user", "name email")
          .populate("previousAgents", "name email");

        autoSendTemplates(savedLead, companyId);
        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    res.status(207).json({
      saved: results,
      errors,
      total: rows.length,
      savedCount: results.length,
      errorCount: errors.length,
      assignMode: importStrategy,
      message: importStrategy === "manual"
        ? `${results.length} leads imported as unassigned for ${poolAdmins.length} admin${poolAdmins.length === 1 ? "" : "s"} to assign.`
        : `${results.length} leads imported with ${importStrategy.replace("_", " ")} assignment.`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User import CSV ───────────────────────────────────────────────────────────
const userImportCSV = async (req, res) => {
  try {
    const rows = req.body.leads;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No leads provided in CSV." });
    const companyId = getCompanyId(req);
    const cust = await getCust(companyId);
    if (employeeDenied(req, res, cust, "canImportLeads", "lead import")) return;
    const lc = cust.workflows.leadCreation;
    const results = [],
      errors = [];

    // ── Who gets the imported leads ──────────────────────────────────────────
    // Employee → always themselves. Team Lead (with "Can reassign leads") can
    // send the whole file to ONE member, or split it round-robin across the
    // team (optionally including themselves):
    //   assignMode: "me" (default) | "member" + assignTo | "team"  (+ includeSelf)
    const selfId = String(req.user._id);
    const assignMode = String(req.body.assignMode || "me");
    let owners = [selfId];
    if (assignMode !== "me") {
      const canTeam = req.user.isTeamLead && custSvc.permission(cust, "teamLead", "canReassignLeads");
      if (!canTeam) {
        return res.status(403).json({ message: "Only a Team Lead can assign imported leads to team members." });
      }
      if (assignMode === "member") {
        const target = String(req.body.assignTo || "");
        if (!target || !(await teamScope.isInTeam(companyId, selfId, target))) {
          return res.status(403).json({ message: "You can only assign leads to members of your own team." });
        }
        owners = [target];
      } else if (assignMode === "team") {
        const members = await teamScope.getTeamMemberIds(companyId, selfId);
        owners = req.body.includeSelf ? [selfId, ...members] : members;
        if (!owners.length) return res.status(400).json({ message: "Your team has no members yet." });
      } else {
        return res.status(400).json({ message: "Unknown assignment option." });
      }
    }
    let rr = 0;
    const perOwner = {};

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const cf = readCustomFields(cust, row, "employee", false);
        if (cf.errors.length) {
          errors.push({ index: i, row: row.name || i, message: cf.errors.join(" ") });
          continue;
        }
        const mobile =
          row["Primary Number"] ||
          row.mobile ||
          row.phone ||
          row["Primary Phone"] ||
          "";
        const secondaryPhone =
          row["Additional Number"] ||
          row["Secondary Number"] ||
          row.secondaryPhone ||
          row["Secondary Phone"] ||
          null;
        const normPrimary = normalizePhone(mobile);
        const normSecondary = secondaryPhone
          ? normalizePhone(secondaryPhone)
          : null;

        if (normSecondary && normSecondary === normPrimary) {
          errors.push({
            index: i,
            row: row.name || i,
            message: "Additional number same as primary — skipped",
          });
          continue;
        }

        if (normPrimary) {
          const conflict = await findLeadByPhone(companyId, normPrimary);
          if (conflict) {
            errors.push({
              index: i,
              row: row.name || i,
              message: `Primary number already belongs to lead "${conflict.name}"`,
            });
            continue;
          }
        }

        if (normSecondary) {
          const conflict = await findLeadByPhone(companyId, normSecondary);
          if (conflict) {
            errors.push({
              index: i,
              row: row.name || i,
              message: `Additional number already belongs to lead "${conflict.name}"`,
            });
            continue;
          }
        }

        const csvExtraAnswers = Object.keys(row)
          .filter(
            (k) =>
              ![
                "name",
                "mobile",
                "phone",
                "email",
                "source",
                "campaign",
                "status",
                "date",
                "remark",
                "leadgenId",
                "user",
                "Primary Number",
                "Additional Number",
                "Secondary Number",
                "Primary Phone",
                "Secondary Phone",
                "primaryPhone",
                "secondaryPhone",
              ].includes(k),
          )
          .map((k) => row[k]);

        const userDoc = {
          name: row.name || "Unknown",
          mobile,
          primaryPhone: mobile,
          secondaryPhone: normSecondary ? secondaryPhone : null,
          normalizedSecondaryPhone: normSecondary || null,
          email: row.email || "",
          source: row.source || lc.defaultImportSource || "Excel Import",
          campaign: row.campaign || null,
          importedViaCsv: true,
          status: resolveStatusKey(cust, row.status),
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || row.notes || lc.defaultImportRemark || "Imported via Excel",
          customFields: cf.values,
          temperature:
            resolveTemperatureKey(cust, row.temperature) ||
            computeQuality(
              {
                name: row.name || "",
                mobile,
                email: row.email || "",
                _extraAnswers: csvExtraAnswers,
              },
              csvExtraAnswers.length,
            ),
          user: new mongoose.Types.ObjectId(owners[rr % owners.length]),
          company: companyId,
          // insertOne bypasses the schema's pre-validate hook, so the dedup key
          // must be set here — otherwise these leads were invisible to the
          // duplicate-phone check forever after.
          normalizedPhone: normPrimary || null,
          ...(owners[rr % owners.length] !== selfId ? {
            activityTimeline: [{
              action: "assigned", performedBy: req.user._id, role: "team_lead", timestamp: new Date(),
              note: `Imported and assigned by Team Lead ${req.user.name || ""}`.trim(),
            }],
          } : {}),
        };

        const lead = await Lead.collection.insertOne(userDoc);
        const ownerKey = owners[rr % owners.length];
        perOwner[ownerKey] = (perOwner[ownerKey] || 0) + 1;
        rr++;
        const savedLead = await Lead.findById(lead.insertedId)
          .populate("user", "name email")
          .populate("previousAgents", "name email");

        autoSendTemplates(savedLead, companyId);
        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    // Tell each team member how many leads just landed in their list.
    const otherOwners = Object.keys(perOwner).filter((id) => id !== selfId);
    let names = {};
    if (otherOwners.length) {
      const us = await User.find({ _id: { $in: otherOwners } }).select("name").lean();
      names = Object.fromEntries(us.map((u) => [String(u._id), u.name]));
      for (const id of otherOwners) {
        try { global._io && global._io.to(`agent:${id}`).emit("new_lead_assigned", { count: perOwner[id], eventType: "imported" }); } catch { /* ignore */ }
      }
    }
    const breakdown = Object.entries(perOwner).map(([id, count]) => ({
      userId: id, name: id === selfId ? "You" : (names[id] || "Member"), count,
    }));
    const message = !otherOwners.length
      ? `${results.length} leads imported and assigned to you.`
      : `${results.length} leads imported — ` + breakdown.map((b) => `${b.name}: ${b.count}`).join(", ") + ".";

    res.status(207).json({
      // Only leads that stayed with the importer go back into their own list.
      saved: results.filter((l) => String(l.user?._id || l.user) === selfId),
      errors,
      total: rows.length,
      savedCount: results.length,
      errorCount: errors.length,
      breakdown,
      message,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLead = (req, res) => {
  // Lead deletion has been removed for every role. Leads are never deleted —
  // close them (wrong entry / invalid) or merge duplicates instead, so the
  // full history stays in reports and audits.
  return res.status(403).json({
    code: "LEAD_DELETE_DISABLED",
    message: "Leads can't be deleted. Close the lead (wrong entry / invalid) or merge it with the duplicate instead.",
  });
};

const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    // PERF: lead + customization in parallel (was sequential).
    const [lead, cust] = await Promise.all([
      Lead.findOne({ _id: id, company: companyId }),
      getCust(companyId),
    ]);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    // Strip fields that must never be changed via this endpoint
    const {
      company, user, normalizedPhone, normalizedSecondaryPhone,
      leadgenId, previousAgents, reassignCount, additionalNumbers,
      mergedFrom, customFields: _rawCustom, ...safeBody
    } = req.body;

    if (employeeDenied(req, res, cust, "canEditLeadDetails", "editing lead details")) return;
    const touchesPhone = safeBody.mobile !== undefined || safeBody.primaryPhone !== undefined || safeBody.secondaryPhone !== undefined;
    if (touchesPhone && employeeDenied(req, res, cust, "canEditPhoneNumbers", "editing phone numbers")) return;
    if (safeBody.status !== undefined) safeBody.status = resolveStatusKey(cust, safeBody.status, lead.status);
    if (safeBody.temperature !== undefined) {
      if (employeeDenied(req, res, cust, "canChangeTemperature", "changing lead quality")) return;
      safeBody.temperature = resolveTemperatureKey(cust, safeBody.temperature);
    }
    const cfIn = readCustomFields(cust, req.body, isEmployeeReq(req) ? "employee" : "admin", true);
    if (cfIn.errors.length) return res.status(400).json({ message: cfIn.errors.join(" "), errors: cfIn.errors });
    for (const [k, v] of Object.entries(cfIn.values)) safeBody[`customFields.${k}`] = v;
    // Never let a flat custom-field key land as a top-level lead path.
    for (const f of cust.customFields || []) { delete safeBody[f.key]; delete safeBody[f.label]; }
    if (safeBody.industry !== undefined || safeBody.service !== undefined || safeBody.services !== undefined) {
      const isv = readIndustryServices(cust, safeBody);
      delete safeBody.industry; delete safeBody.service; delete safeBody.services;
      Object.assign(safeBody, isv);
    }

    // If caller is changing primary phone, validate uniqueness
    const newPrimary = safeBody.mobile || safeBody.primaryPhone;
    if (newPrimary) {
      const normNew = normalizePhone(newPrimary);
      if (normNew) {
        const conflict = await findLeadByPhone(companyId, normNew, id);
        if (conflict) {
          return res.status(409).json({
            message: `Primary number already belongs to lead "${conflict.name}"`,
            duplicate: true, lead: conflict,
          });
        }
        // Keep mobile + primaryPhone in sync
        safeBody.mobile       = newPrimary;
        safeBody.primaryPhone = newPrimary;
      }
    }

    // If caller is changing secondary phone, validate
    if (safeBody.secondaryPhone !== undefined) {
      const normSec = safeBody.secondaryPhone ? normalizePhone(safeBody.secondaryPhone) : null;
      const normPri = normalizePhone(newPrimary || lead.mobile || "");
      if (normSec) {
        if (normSec === normPri) {
          return res.status(400).json({ message: "Secondary phone cannot be the same as primary." });
        }
        const conflict = await findLeadByPhone(companyId, normSec, id);
        if (conflict) {
          return res.status(409).json({
            message: `Secondary number already belongs to lead "${conflict.name}"`,
            duplicate: true, lead: conflict,
          });
        }
      }
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, safeBody, { new: true });
    // SECURITY: mask PII in update response
    const _masked = maskLeadPII(updatedLead && updatedLead.toObject ? updatedLead.toObject() : updatedLead, getCallerRole(req), getCallerId(req));
    return res.status(200).json(_masked);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const scope = await getAdminLeadScope(req, companyId);
    const leadQuery = mergeLeadScope(
      companyId ? { _id: id, company: companyId } : { _id: id },
      scope
    );
    const lead = await Lead.findOne(leadQuery);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const previousUserId = lead.user ? String(lead.user) : null;

    const {
      company, leadgenId, reassignReason,
      normalizedPhone, normalizedSecondaryPhone,
      additionalNumbers, mergedFrom, customFields: _rawCustom,
      ...safeBody
    } = req.body;
    const incomingUser = req.body.user;

    const cust = await getCust(companyId || lead.company);
    if (incomingUser && String(incomingUser) !== previousUserId &&
        adminDenied(req, res, cust, "canReassignLeads", "reassigning leads")) return;
    if (safeBody.status !== undefined) safeBody.status = resolveStatusKey(cust, safeBody.status, lead.status);
    if (safeBody.temperature !== undefined) safeBody.temperature = resolveTemperatureKey(cust, safeBody.temperature);
    const cfIn = readCustomFields(cust, req.body, "admin", true);
    if (cfIn.errors.length) return res.status(400).json({ message: cfIn.errors.join(" "), errors: cfIn.errors });
    for (const [k, v] of Object.entries(cfIn.values)) safeBody[`customFields.${k}`] = v;
    for (const f of cust.customFields || []) { delete safeBody[f.key]; delete safeBody[f.label]; }
    if (safeBody.industry !== undefined || safeBody.service !== undefined || safeBody.services !== undefined) {
      const isv = readIndustryServices(cust, safeBody);
      delete safeBody.industry; delete safeBody.service; delete safeBody.services;
      Object.assign(safeBody, isv);
    }

    // Validate primary phone change
    const newPrimary = safeBody.mobile || safeBody.primaryPhone;
    if (newPrimary) {
      const normNew = normalizePhone(newPrimary);
      if (normNew) {
        const conflict = await findLeadByPhone(companyId, normNew, id);
        if (conflict) {
          return res.status(409).json({
            message: `Primary number already belongs to lead "${conflict.name}"`,
            duplicate: true, lead: conflict,
          });
        }
        safeBody.mobile       = newPrimary;
        safeBody.primaryPhone = newPrimary;
      }
    }

    // Validate secondary phone change
    if (safeBody.secondaryPhone !== undefined) {
      const normSec = safeBody.secondaryPhone ? normalizePhone(safeBody.secondaryPhone) : null;
      const normPri = normalizePhone(newPrimary || lead.mobile || "");
      if (normSec) {
        if (normSec === normPri) {
          return res.status(400).json({ message: "Secondary phone cannot be the same as primary." });
        }
        const conflict = await findLeadByPhone(companyId, normSec, id);
        if (conflict) {
          return res.status(409).json({
            message: `Secondary number already belongs to lead "${conflict.name}"`,
            duplicate: true, lead: conflict,
          });
        }
      }
    }

    const updatePayload = { ...safeBody };
    let newUserId = null;
    if (incomingUser && String(incomingUser) !== previousUserId) {
       updatePayload.user = incomingUser;
      newUserId = String(incomingUser);
      updatePayload.noActionAlert1hSentAt = null;
      updatePayload.noActionAlert2hSentAt = null;
    }

    if (newUserId && reassignReason) {
      if (!updatePayload.$push) updatePayload.$push = {};
      updatePayload.$push.activityTimeline = {
        action: "reassigned",
        performedBy: req.admin?._id || req.superAdmin?._id || null,
        role: req.admin ? "admin" : "superadmin",
        timestamp: new Date(),
        note: reassignReason.trim(),
      };
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    })
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    // BUG FIX (logic gap): status changes made here — e.g. dragging a card
    // on the admin Pipeline Board, which calls this exact endpoint — never
    // triggered nurture sequences or the Meta Conversions API send-back.
    // patchLead (the EMPLOYEE-facing update endpoint) already does both of
    // these on every status change; this admin-facing endpoint silently
    // skipped them entirely, so the identical action (changing a lead's
    // status) behaved differently depending on who did it. Both are
    // fire-and-forget and self-gate (nurture checks the company entitlement
    // internally; CAPI checks metaConversionSync below) — exactly mirroring
    // patchLead's versions of these same two triggers.
    //
    // NOT replicated here: patchLead's "interested blast" and per-outcome
    // WhatsApp/email automation. Those are tied to an agent-logged call
    // `outcome` value that has no equivalent concept in an admin drag-and-
    // drop status change, so porting them as-is would be guessing at
    // behavior rather than fixing a clear gap — flagging as a separate,
    // deliberate follow-up decision rather than bundling it in blind.
    if (updatedLead && safeBody.status !== undefined && safeBody.status !== lead.status) {
      const newStatus = safeBody.status;

      triggerNurtureForLead(String(updatedLead._id), newStatus).catch((err) =>
        console.error("[nurtureSequence] adminUpdateLead trigger error:", err.message)
      );

      const capiCompanyId = lead.company?._id || lead.company || companyId;
      if (capiCompanyId) {
        getCompanyEntitlements(capiCompanyId)
          .then((ent) => {
            if (!ent?.metaConversionSync) return;
            return sendMetaConversionEvent(updatedLead, newStatus).then((result) => {
              if (result.sent) {
                console.log(`[metaConversionSync] "${result.eventName}" sent for lead ${updatedLead._id} (via adminUpdateLead)`);
              } else {
                console.log(`[metaConversionSync] Skipped for lead ${updatedLead._id} (via adminUpdateLead): ${result.reason}`);
              }
            });
          })
          .catch((err) => console.error("[metaConversionSync] adminUpdateLead trigger error:", err.message));
      }
    }

    if (newUserId) {
      const _io = global._io;
      if (_io) {
        _io.to(`agent:${newUserId}`).emit("new_lead_assigned", {
          leadId: String(updatedLead._id),
          leadName: updatedLead.name,
          source: updatedLead.source || "",
          eventType: "reassigned",
        });
      }
      sendReassignedLeadNotification(newUserId, updatedLead).catch((e) =>
        console.error("[FCM] adminUpdateLead push error:", e.message),
      );
      // Telegram — notify newly assigned employee personally
      notifyEmployeeLead(newUserId, updatedLead, companyId).catch(e =>
        console.error("[Telegram] adminUpdateLead employee notify error:", e.message)
      );

      if (companyId) {
        const fromAdminName =
          req.admin?.name || req.superAdmin?.name || "Admin";
        const toUserName = updatedLead.user?.name || "Employee";
        notifySuperAdminReassignment(companyId, {
          lead: updatedLead,
          fromAdminName,
          toUserName,
          reason: reassignReason || "",
        }).catch((e) =>
          console.error("[FCM] superadmin reassign notify error:", e.message),
        );
      }
    }

    // SECURITY: mask PII in update response
    const _masked = maskLeadPII(updatedLead && updatedLead.toObject ? updatedLead.toObject() : updatedLead, getCallerRole(req), getCallerId(req));
    return res.status(200).json(_masked);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminDeleteLead = (req, res) => {
  // Lead deletion has been removed for every role. Leads are never deleted —
  // close them (wrong entry / invalid) or merge duplicates instead, so the
  // full history stays in reports and audits.
  return res.status(403).json({
    code: "LEAD_DELETE_DISABLED",
    message: "Leads can't be deleted. Close the lead (wrong entry / invalid) or merge it with the duplicate instead.",
  });
};

// ── Projection for mobile list — only the fields formatLead() needs ──────────
// Excludes heavy arrays (callHistory, scheduledCalls, meetingRemarks,
// previousAgents content, templateHistory, activityLog, nurtureSent, projects)
// that the list screen never renders. Full lead is fetched by GET /lead/:id.
// KEEP IN SYNC with formatLead() in src/api/leadsApi.js.
//
// FIX: `service` was missing from this projection — `industry` was listed but
// `service` was not, so even for companies with leadNurtureSequence enabled
// (where the field genuinely saves via patchLead), the mobile list's
// stale-check refresh (getMyLeads below) would strip `service` right back out
// of every lead on the very next pull. `industry` survived that refresh
// because it WAS in this list; `service` never was.
const MOBILE_LIST_PROJECTION = {
  name:              1,
  customFields:      1,
  mobile:            1,
  primaryPhone:      1,
  secondaryPhone:    1,
  email:             1,
  source:            1,
  campaign:          1,
  industry:          1,
  service:           1,
  services:          1,
  status:            1,
  remark:            1,
  initialRemark:     1,
  followUpDate:      1,
  temperature:       1,
  Quality:           1,
  company:           1,
  reassignCount:     1,
  invalidStage:      1,
  isClosed:          1,
  date:              1,
  createdAt:         1,
  updatedAt:         1,
  // callHistory: only the LAST entry for lastOutcome/lastCalledAt/remark detection.
  // $slice: -1 returns just the last element — avoids sending full history array.
  "callHistory":     { $slice: -3 },
  // scheduledCalls: return the 5 MOST RECENT entries so the frontend can show
  // follow-up due badges and filter correctly. MUST be negative ($slice: -5) —
  // entries are $push-appended chronologically, so a positive slice returns
  // the OLDEST 5 (usually already-completed calls from way back), silently
  // hiding the actual current/pending follow-up on any lead with more than 5
  // scheduledCalls accumulated over time. ($slice: 0 was wrong before this for
  // a different reason — see old comment — then "fixed" to a still-wrong
  // positive 5; -5 is the correct value.)
  "scheduledCalls":  { $slice: -5 },
  // user: populated below — only name needed for list row.
  user:              1,
};
// ── Admin lead list projection ─────────────────────────────────────────────────
// Returns ONLY the fields the AdminLeadsPage table and lead-card need.
// This cuts the Network tab payload from 50KB+ per lead to ~1KB.
// Sensitive fields (voiceBot*, AES-encrypted fields, full callHistory, etc.)
// are intentionally excluded — the detail modal fetches them individually via
// GET /lead/:id when the user opens a specific lead.
const ADMIN_LIST_PROJECTION = {
  // Only the proposal markers of each client meeting (not the full meeting
  // history) — powers the Leads page "Proposal sent" filter and tag.
  "meetingRemarks.proposalSent":   1,
  "meetingRemarks.proposalSentAt": 1,
  "meetingRemarks.metAt":          1,
  "meetingRemarks.documents.type": 1,
  industry:          1,
  service:           1,
  services:          1,
  name:              1,
  customFields:      1,
  mobile:            1,
  primaryPhone:      1,
  secondaryPhone:    1,
  email:             1,
  status:            1,
  campaign:          1,
  source:            1,
  remark:            1,
  temperature:       1,
  leadScore:         1,
  Quality:           1,
  user:              1,
  followUpDate:      1,
  isClosed:          1,
  mergedInto:        1,
  createdAt:         1,
  updatedAt:         1,
  // callHistory — last 3 only (for the recent-activity indicator)
  callHistory:       { $slice: -3 },
  // scheduledCalls — 5 MOST RECENT entries for follow-up due badge + filter.
  // Same negative-slice fix as MOBILE_LIST_PROJECTION above — a positive
  // slice here was returning the oldest 5 (often already-done) instead of
  // the current pending follow-up.
  scheduledCalls:    { $slice: -5 },
  // nurture tracking
  nurtureStage:      1,
  nurtureSequence:   1,
  // NOT included: voiceBotSummary, voiceBotScore, voiceBotTranscript,
  // templateHistory, qualificationBreakdown, activityTimeline,
  // meetingRemarks, revealLog, encryptedMobile, encryptedEmail,
  // interestedBlastSentAt, noActionAlertSuperAdminSentAt — all fetched on demand
};

const getMyLeads = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || "1",   10));
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "200", 10)));
    const skip  = (page - 1) * limit;

    // Admin/super_admin sessions arrive here via protectAny (mobile app now
    // supports admin login too — see middlewares/authMiddleware.js's
    // protectAny normalization). An admin has no single "assigned user" —
    // they should see every lead across the whole company, matching their
    // web dashboard's scope, not just leads assigned to their own account ID.
    // Without this branch, `user: req.user._id` would be `user: undefined`
    // for an admin session (protectAny's normalized req.user has no `_id`,
    // only `userId`), which is undefined query behavior — this makes the
    // scope explicit and correct for both session types instead.
    const isAdminSession = req.user.role === "admin" || req.user.role === "super_admin";

    const query = {
      company:   getCompanyId(req),
      ...(isAdminSession ? {} : { user: req.user.userId || req.user._id }),
      mergedInto: null,
      isClosed:  { $ne: true },
    };
    // Run countDocuments in parallel with the data fetch so the web dashboard
    // can compute total pages and fetch all of them (mobile app uses hasMore).
    // countDocuments on an indexed query is fast (covered by company+user index).
    // PERF: count runs IN PARALLEL with the data query (was awaited first —
    // one extra ~150 ms round trip on every page) and is skipped entirely for
    // delta refreshes, which never used it.
    const totalP = req.query.since ? null : Lead.countDocuments(query);
    // Employees only ever get their OWN leads here, so "user" is the caller —
    // fill it in directly instead of a second populate() round trip.
    const selfUser = isAdminSession ? null : { _id: req.user._id || req.user.userId, name: req.user.name, email: req.user.email };
    const withUser = (q) => (selfUser ? q : q.populate("user", "name email"));
    const fillUser = (rows) => (selfUser ? rows.map((l) => (l.user ? { ...l, user: selfUser } : l)) : rows);

    // ── Delta fetch: ?since=<ISO timestamp> ──────────────────────────────────
    // Mobile app sends this on stale-check refreshes (every 5 min tab focus).
    // Returns only leads whose updatedAt > since so the app can upsert just the
    // changed leads. Bounded at DELTA_LIMIT to prevent unbounded responses when
    // many leads changed simultaneously (e.g. bulk reassign).
    // hasMore=true signals the app to fall back to a full refetch.
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!isNaN(since.getTime())) {
        const DELTA_LIMIT = 100;
        const changed = fillUser(await withUser(Lead.find({ ...query, updatedAt: { $gt: since } })
          .sort({ updatedAt: -1 })
          .limit(DELTA_LIMIT + 1)          // fetch one extra to detect overflow
          .select(MOBILE_LIST_PROJECTION))
          .lean());

        const hasMore = changed.length > DELTA_LIMIT;
        const leads   = hasMore ? changed.slice(0, DELTA_LIMIT) : changed;
        // ?withIds=1 → also send the ids of ALL current leads (ids only — tiny)
        // so the app can drop leads that were reassigned away / closed without
        // re-downloading everything.
        let ids;
        if (req.query.withIds === "1" && !hasMore && !isAdminSession) {
          ids = (await Lead.find(query).select("_id").lean()).map((d) => String(d._id));
        }
        // SECURITY: mask PII in delta response
        const _callerRole = getCallerRole(req);
        const _callerId = getCallerId(req);
        return res.status(200).json({ leads: leads.map(l => maskLeadPII(l, _callerRole, _callerId)), delta: true, hasMore, ids, serverTime: new Date().toISOString() });
      }
    }

    // ── Normal paginated fetch ────────────────────────────────────────────────
    // No countDocuments() — use the one-extra trick to compute hasMore.
    // Eliminates a full index scan on every mobile request.
    const [rawRows, total] = await Promise.all([
      withUser(Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1)                  // fetch one extra to detect next page
        .select(MOBILE_LIST_PROJECTION))
        .lean(),
      totalP,
    ]);
    const raw = fillUser(rawRows);

    const hasMore = raw.length > limit;
    const rawLeads = hasMore ? raw.slice(0, limit) : raw;
    // SECURITY: mask PII — never return raw phone/email for non-superadmin
    const callerRole = getCallerRole(req);
    const callerId = getCallerId(req);
    const leads = rawLeads.map(l => maskLeadPII(l, callerRole, callerId));

    res.status(200).json({
      leads,
      page,
      limit,
      hasMore,
      total,                               // total assigned leads (for KPIs)
      pages: Math.ceil(total / limit),     // total pages (for web dashboard multi-fetch)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const patchLead = async (req, res) => {
  try {
    const { id } = req.params;
    // PERF: lead + customization + entitlements are independent → fetch them
    // together (was 3 sequential round trips ≈ 0.45 s to a remote database).
    const reqCompanyStr = String(getCompanyId(req) || "");
    const [lead, custPre, entsPre] = await Promise.all([
      Lead.findOne({ _id: id, company: getCompanyId(req) }),
      getCust(reqCompanyStr),
      getCompanyEntitlements(reqCompanyStr).catch(() => null),
    ]);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const { remark, followUpDate, temperature, Quality, industry, service } = req.body;
    let { status, outcome } = req.body;
    const update = {};

    const companyIdStr = String(lead.company?._id || lead.company || "");
    const cust = companyIdStr === reqCompanyStr ? custPre : await getCust(companyIdStr);
    const lu = cust.workflows.leadUpdate;

    // ── Canonicalise status / outcome against the company's customization ───
    // Clients may send a key, a renamed label or an alias — always store the key.
    if (status !== undefined && status !== null && status !== "") {
      status = resolveStatusKey(cust, status, lead.status);
    } else if (status === "" || status === null) {
      status = undefined;
    }
    const outcomeObj = (typeof outcome === "string" && outcome.trim()) ? custSvc.findOutcome(cust, outcome) : null;
    if (outcomeObj) outcome = outcomeObj.key;

    if (status !== undefined) update.status = status;
    if (remark !== undefined) update.remark = remark;

    // industry and service are saved only when the lead's company has the
    // leadNurtureSequence feature enabled.
    // FIX: was checking ents?.features?.leadNurtureSequence but the entitlement
    // object has no nested `features` key — leadNurtureSequence is a top-level
    // key on ents (spread from planLimits.features at build time). The broken
    // path always returned undefined → false → silently dropped industry/service
    // on every save even when the toggle was ON.
    const ents = companyIdStr === reqCompanyStr ? entsPre : await getCompanyEntitlements(companyIdStr).catch(() => null);
    // Nurture is fully multi-tenant now (jobs/nurtureSequenceJob.js gates on
    // this exact same entitlement flag via getNurtureEnabledCompanyIds()), so
    // there's no longer a hardcoded company to bypass this check for.
    // NURTURE_COMPANY_ID is kept only for backward compatibility with this
    // import and is always null — `=== NURTURE_COMPANY_ID` never matches,
    // leaving the entitlement flag as the single source of truth.
    const nurtureEnabled = !!ents?.leadNurtureSequence || companyIdStr === NURTURE_COMPANY_ID;
    // Industry / service are also plain lead fields when the company shows
    // them (Customize CRM → Lead Fields) — not only for nurture companies.
    const showIndustry = nurtureEnabled || cust.leadFields?.industry?.visible !== false;
    const showService  = nurtureEnabled || cust.leadFields?.service?.visible !== false;
    const isv = readIndustryServices(cust, { industry, service, services: req.body.services });
    if (showIndustry && isv.industry !== undefined) update.industry = isv.industry;
    if (showService && isv.services !== undefined) { update.services = isv.services; update.service = isv.service; }

    const temp = temperature || Quality;
    if (temp) {
      const tKey = resolveTemperatureKey(cust, temp);
      if (tKey && tKey !== lead.temperature) {
        if (employeeDenied(req, res, cust, "canChangeTemperature", "changing lead quality")) return;
      }
      if (tKey) update.temperature = tKey;
    }

    // ── Company custom fields ─────────────────────────────────────────────────
    const cfIn = readCustomFields(cust, req.body, isEmployeeReq(req) ? "employee" : "admin", true);
    if (cfIn.errors.length) return res.status(400).json({ message: cfIn.errors.join(" "), errors: cfIn.errors });

    const pushOps = {};
    const setOps = {};
    for (const [k, v] of Object.entries(cfIn.values)) setOps[`customFields.${k}`] = v;

    // ── Optional server-side auto-advance of status from the outcome ─────────
    // (Customize CRM → Workflows → "Move status from outcome"). Never downgrades.
    if (lu.autoAdvanceStatusFromOutcome && outcomeObj?.autoStatus && (status === undefined || status === lead.status)) {
      const target = custSvc.findStatus(cust, outcomeObj.autoStatus);
      const current = custSvc.findStatus(cust, lead.status);
      if (target && (!current || (target.order || 0) > (current.order || 0)) && !["won", "lost"].includes(current?.category)) {
        status = target.key;
        update.status = status;
      }
    }

    // ── Call history — only push when this is a genuine call interaction.
    // A bare remark-only edit (no outcome, no calledNumber) should NOT create
    // a new call log entry. We require at least one of:
    //   • outcome (employee chose a call outcome from the dropdown)
    //   • calledNumber (mobile app passed the dialled number)
    // This prevents the "Update Lead" remark textarea from inflating call counts.
    // isGenuineCall: only true when outcome is a non-empty string (user explicitly
    // chose a call outcome) OR mobile app passed a calledNumber.
    // outcome="" (blank placeholder) means user did NOT make a call — no callHistory entry.
    const isGenuineCall = !!(
      (outcome && typeof outcome === "string" && outcome.trim().length > 0) ||
      req.body.calledNumber
    );
    const hasRemark = !!(remark && String(remark).trim());
    if (isGenuineCall && lu.remarkRequired && !hasRemark) {
      return res.status(400).json({ message: "A remark is required when logging a call." });
    }
    if (isGenuineCall && (hasRemark || !lu.remarkRequired)) {
      const histEntry = {
        userId: req.user._id,
        userName: req.user.name || "",
        remark: hasRemark ? String(remark).trim() : "",
        outcome: outcome || lu.defaultOutcomeWhenMissing || "Call Back",
        calledAt: new Date(),
      };
      if (req.body.calledNumber) histEntry.calledNumber = req.body.calledNumber;
      if (req.body.numberType) histEntry.numberType = req.body.numberType;
      pushOps.callHistory = histEntry;
    }

    // ── Follow-up scheduling — driven by the outcome's follow-up rule ────────
    //   none     → never     optional → only if a date is picked
    //   required → a date must be picked    auto → picked date, else N days later
    // Leads moving to a "lost" status never get a new follow-up here (the
    // Not-Interested flow schedules its own).
    const statusCat = custSvc.statusCategory(cust, status !== undefined ? status : lead.status);
    const rule = outcomeObj ? outcomeObj.followUp : (outcome === "Call Back" ? "auto" : "optional");
    if ((status !== undefined || outcomeObj) && statusCat !== "lost" && rule !== "none") {
      if (rule === "required" && !followUpDate) {
        return res.status(400).json({ message: `Pick a follow-up date for "${outcomeObj?.label || outcome}".` });
      }
      const shouldSchedule = !!(followUpDate || rule === "auto");

      if (shouldSchedule) {
        if (followUpDate && employeeDenied(req, res, cust, "canScheduleFollowUps", "scheduling follow-ups")) return;
        let scheduledAt;
        if (followUpDate) {
          const provided = new Date(followUpDate);
          if (Number.isNaN(provided.getTime())) {
            return res.status(400).json({ message: "Invalid follow-up date." });
          }
          if (lu.preventPastFollowUp && provided < custSvc.companyDayStart(cust)) {
            return res
              .status(400)
              .json({ message: "Follow-up date cannot be in the past." });
          }
          scheduledAt = provided;
        } else {
          const days = outcomeObj ? outcomeObj.autoFollowUpDays : lu.defaultFollowUpDays;
          scheduledAt = custSvc.companyDateAt(cust, days, lu.defaultFollowUpHour);
        }

        pushOps.scheduledCalls = {
          type: "follow-up",
          scheduledAt,
          done: false,
          doneAt: null,
          note: `Follow-up after status "${status !== undefined ? status : lead.status}" — outcome: ${outcome || lu.defaultOutcomeWhenMissing || "Call Back"}`,
        };
      }
    }

    // ── Close the previous pending follow-up — only when it was really handled ──
    // FOLLOW-UP PING FIX: this used to run on EVERY patch, so changing just the
    // temperature or status right after setting a follow-up silently marked it
    // done and its reminder never fired. Now:
    //   • a NEW follow-up is being set      → the old pending one is replaced
    //   • a call/remark is being logged     → close the oldest one only if it is
    //                                         already due (≤ 30 min from now)
    //   • anything else (temperature, plain status change) → leave it pending
    if (lu.completeOldestPendingOnUpdate !== false) {
      const pendingCalls = (lead.scheduledCalls || [])
        .map((sc, idx) => ({ sc, idx }))
        .filter(({ sc }) => sc && !sc.done)
        .sort((a, b) => new Date(a.sc.scheduledAt) - new Date(b.sc.scheduledAt));

      if (pendingCalls.length > 0) {
        const { sc, idx } = pendingCalls[0];
        const settingNew = !!pushOps.scheduledCalls;
        const loggedCall = isGenuineCall || hasRemark;
        const isDue = new Date(sc.scheduledAt).getTime() <= Date.now() + 30 * 60 * 1000;
        if (settingNew || (loggedCall && isDue)) {
          setOps[`scheduledCalls.${idx}.done`] = true;
          setOps[`scheduledCalls.${idx}.doneAt`] = new Date();
        }
      }
    }

    // BUG FIX ("I picked a date but the follow-up went to the next day"):
    // closing the oldest pending follow-up ($set scheduledCalls.N.done) and
    // adding the new one ($push scheduledCalls) in the SAME update is rejected
    // by MongoDB ("would create a conflict at 'scheduledCalls'"), so the whole
    // save failed — the agent's chosen date was never stored and the old
    // auto "next day" follow-up stayed. Now the array is rebuilt once and
    // written with a single $set.
    const newFollowUp = pushOps.scheduledCalls || null;
    const scSetKeys = Object.keys(setOps).filter((k) => k.startsWith("scheduledCalls."));
    if (pushOps.scheduledCalls && scSetKeys.length) {
      const arr = (lead.scheduledCalls || []).map((sc) => (sc && sc.toObject ? sc.toObject() : { ...sc }));
      for (const k of scSetKeys) {
        const [, idxStr, field] = k.split(".");
        const i = Number(idxStr);
        if (arr[i] && field) arr[i][field] = setOps[k];
        delete setOps[k];
      }
      arr.push(pushOps.scheduledCalls);
      delete pushOps.scheduledCalls;
      setOps.scheduledCalls = arr;
    }

    if (Object.keys(pushOps).length > 0) update.$push = pushOps;
    if (Object.keys(setOps).length > 0)
      update.$set = { ...(update.$set || {}), ...setOps };

    const updatedLead = await Lead.findByIdAndUpdate(id, update, { new: true });

    // ── Telegram — ping the assigned employee when a new follow-up is scheduled
    // Fires the moment a follow-up call is set (via pushOps.scheduledCalls
    // above), not when it becomes due — that's the separate daily
    // followUpReminderJob.js, which nudges the LEAD, not the employee.
    // Company-gated + silently skipped if Telegram isn't configured, same as
    // every other Telegram call site. Fire-and-forget, never blocks the response.
    if (updatedLead && newFollowUp) {
      const followUpCompanyId = lead.company?._id || lead.company || getCompanyId(req);
      const assignedEmployeeId = updatedLead.user?._id || updatedLead.user || req.user?._id;
      if (followUpCompanyId && assignedEmployeeId) {
        notifyEmployeeFollowUp(
          assignedEmployeeId,
          updatedLead,
          followUpCompanyId,
          newFollowUp.scheduledAt,
          newFollowUp.note
        ).catch((err) =>
          console.error("[telegram] notifyEmployeeFollowUp patchLead trigger error:", err.message)
        );
      }
    }

    // ── Auto-blast when lead is marked Interested ─────────────────────────────
    // Fires SMS, Email, and WhatsApp to the lead when the employee selects
    // "Interested" as the call outcome OR the lead status is set to "Interested".
    // Uses company's interestedBlast settings. Sends only ONCE per lead
    // (guarded by interestedBlastSentAt — claimed atomically below).
    const isInterestedNow =
      (outcomeObj ? outcomeObj.behavior === "interested"
                  : (typeof outcome === "string" && outcome.trim().toLowerCase() === "interested")) ||
      (status !== undefined && custSvc.statusCategory(cust, status) === "interested");

    if (isInterestedNow && updatedLead) {
      const blastCompanyId =
        lead.company?._id || lead.company || getCompanyId(req);
      if (blastCompanyId) {
        // Atomically claim the blast — only one request can ever win this,
        // so the lead gets each blast exactly one time.
        Lead.findOneAndUpdate(
          { _id: id, $or: [{ interestedBlastSentAt: null }, { interestedBlastSentAt: { $exists: false } }] },
          { $set: { interestedBlastSentAt: new Date() } },
          { new: true }
        )
          .then(async (claimed) => {
            if (!claimed) {
              console.log(`[interestedBlast] Skipped — blast already sent for lead ${id}`);
              return;
            }
            const summary = await sendInterestedBlast(claimed, blastCompanyId);
            // Keep the once-only lock ONLY if at least one channel actually
            // delivered. If everything failed or was skipped (toggles off,
            // provider misconfigured, template rejected), release the claim
            // so the blast can retry the next time the lead is saved as
            // Interested — otherwise a single bad attempt would permanently
            // lock the lead out of ever receiving the blast.
            const anySent = (summary || []).some((r) => r.status === "sent");
            if (!anySent) {
              await Lead.updateOne(
                { _id: id },
                { $set: { interestedBlastSentAt: null } }
              ).catch(() => {});
            }
          })
          .catch((err) =>
            console.error("[interestedBlast] patchLead trigger error:", err.message)
          );
      }
    }

    // ── Per-outcome automation (WhatsApp + Email to the lead) ─────────────────
    // Fires a lead-facing message based on the call outcome the agent logged
    // (Answered / Not Answered / Busy / Switch Off / Call Back Later / Not
    // Interested). "Interested" is intentionally left to the interestedBlast
    // above; "Client Meeting" and "Invalid" are ignored by the service, so
    // they never double-send. Fire-and-forget — never blocks the response, and
    // the service self-guards against sending the same outcome to the same lead
    // more than once per day.
    if (updatedLead && typeof outcome === "string" && outcome.trim()) {
      const autoCompanyId = lead.company?._id || lead.company || getCompanyId(req);
      if (autoCompanyId) {
        sendOutcomeAutomation(updatedLead, autoCompanyId, outcome).catch((err) =>
          console.error("[outcomeAutomation] patchLead trigger error:", err.message)
        );
      }
    }

    // ── Meta Conversions API (CAPI) send-back ─────────────────────────────────
    // Tells Meta which leads actually converted, mapped from CRM status
    // (New→Lead, In Progress→Contact, Interested→Schedule, Converted→Purchase;
    // Not Interested is never sent). STRICTLY company-gated — only fires when
    // Company.devOverrides.featureToggles.metaConversionSync is true for this
    // company; every other company is a silent no-op even if the lead came
    // from Meta. Fire-and-forget, never blocks the response.
    if (updatedLead && status !== undefined) {
      const capiCompanyId = lead.company?._id || lead.company || getCompanyId(req);
      if (capiCompanyId) {
        getCompanyEntitlements(capiCompanyId)
          .then((ent) => {
            if (!ent?.metaConversionSync) return; // not enabled for this company — do nothing
            return sendMetaConversionEvent(updatedLead, status).then((result) => {
              if (result.sent) {
                console.log(`[metaConversionSync] "${result.eventName}" sent for lead ${updatedLead._id}`);
              } else {
                console.log(`[metaConversionSync] Skipped for lead ${updatedLead._id}: ${result.reason}`);
              }
            });
          })
          .catch((err) => console.error("[metaConversionSync] patchLead trigger error:", err.message));
      }
    }

    // ── Nurture sequence — immediate status-change trigger ────────────────────
    // Fires V1 (or next sequential variation) instantly when a lead's status
    // changes. Company-gated inside triggerNurtureForLead — no-op for all
    // other companies. Fire-and-forget, never blocks the response.
    if (updatedLead && status !== undefined && status !== lead.status) {
      triggerNurtureForLead(String(updatedLead._id), status).catch((err) =>
        console.error("[nurtureSequence] patchLead trigger error:", err.message)
      );
    }

    // SECURITY: mask PII in update response
    const _masked = maskLeadPII(updatedLead && updatedLead.toObject ? updatedLead.toObject() : updatedLead, getCallerRole(req), getCallerId(req));
    return res.status(200).json(_masked);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const patchLeadTemperature = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      temperature,
      voiceBotSummary,
      voiceBotScore,
      voiceBotReason,
      voiceBotNextAction,
      voiceBotService,
      voiceBotCallSid,
      voiceBotDuration,
      voiceBotTranscript,
      lastCalledByBot,
    } = req.body;

    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId)
      return res.status(400).json({ message: "Company not found in token." });
    const tempCust = await getCust(companyId);
    const tempKey = resolveTemperatureKey(tempCust, temperature);
    if (!tempKey) {
      const allowed = tempCust.temperatures.filter((t) => t.active).map((t) => t.label).join(", ");
      return res
        .status(400)
        .json({ message: `temperature must be one of: ${allowed}` });
    }
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const update = { temperature: tempKey };
    if (voiceBotSummary !== undefined) update.voiceBotSummary = voiceBotSummary;
    if (voiceBotScore !== undefined) update.voiceBotScore = voiceBotScore;
    if (voiceBotReason !== undefined) update.voiceBotReason = voiceBotReason;
    if (voiceBotNextAction !== undefined)
      update.voiceBotNextAction = voiceBotNextAction;
    if (voiceBotService !== undefined) update.voiceBotService = voiceBotService;
    if (voiceBotCallSid !== undefined) update.voiceBotCallSid = voiceBotCallSid;
    if (voiceBotDuration !== undefined)
      update.voiceBotDuration = voiceBotDuration;
    if (voiceBotTranscript !== undefined)
      update.voiceBotTranscript = voiceBotTranscript;
    if (lastCalledByBot !== undefined) update.lastCalledByBot = lastCalledByBot;

    const updatedLead = await Lead.findByIdAndUpdate(id, update, { new: true });
    // SECURITY: mask PII in update response
    const _masked = maskLeadPII(updatedLead && updatedLead.toObject ? updatedLead.toObject() : updatedLead, getCallerRole(req), getCallerId(req));
    return res.status(200).json(_masked);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const markNotInterested = async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    if (!remark || !remark.trim())
      return res.status(400).json({ message: "A remark/reason is required." });

    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const cust = await getCust(lead.company);
    if (employeeDenied(req, res, cust, "canMarkNotInterested", "marking leads Not Interested")) return;
    const wf = cust.workflows.notInterested;
    const niOutcome = (cust.outcomes.find((o) => o.behavior === "notInterested") || { key: "Not Interested" }).key;

    const historyEntry = {
      userId: req.user._id,
      userName: req.user.name || "",
      remark: remark.trim(),
      outcome: niOutcome,
      calledAt: new Date(),
    };

    // Workflow switched off → simply mark the lead lost, keep it with the agent.
    const stage = (wf.enabled && wf.verification) ? (lead.niStage || null) : "__direct__";

    // Common pieces of the update applied in every branch.
    const updatePayload = {
      $set: { remark: remark.trim() },
      $push: {
        callHistory: historyEntry,
        previousAgents: req.user._id,
      },
    };

    let nextUserId  = null;
    let outcome     = "";   // describes which branch ran (for the client)
    let message     = "";
    let scheduledForResponse = [];

    if (stage === "__direct__") {
      // ── Verification disabled for this company ─────────────────────────────
      updatePayload.$set.status = wf.finalStatus;
      if (wf.enabled) {
        const newScheduledCalls = buildScheduledCalls(cust, "notInterested");
        scheduledForResponse = newScheduledCalls;
        if (newScheduledCalls.length) updatePayload.$push.scheduledCalls = { $each: newScheduledCalls };
      }
      outcome = "marked_directly";
      message = scheduledForResponse.length
        ? `Lead marked ${wf.finalStatus}. ${scheduledForResponse.length} follow-up call(s) scheduled.`
        : `Lead marked ${wf.finalStatus}.`;
    } else if (!stage) {
      // ── STAGE 1: first Not Interested ────────────────────────────────────
      // Reassign to another agent for VERIFICATION. Remember the original
      // employee so a second NI can be sent back to them. Schedule the 3 calls.
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      // Workflow "verifier: team_lead" → the employee's own Team Lead verifies
      // (falls back to round robin when they have no Team Lead).
      if (wf.verifier === "team_lead" && custSvc.permission(cust, "teamLead", "canVerifyNotInterested")) {
        const tlId = await teamScope.getTeamLeadOf(req.user._id);
        if (tlId && String(tlId) !== String(req.user._id)) nextUserId = tlId;
      }
      if (!nextUserId) nextUserId = await getNextUser(req.user.company, excludeIds, { purpose: "verify", cust });

      const newScheduledCalls = buildScheduledCalls(cust, "notInterested");
      scheduledForResponse = newScheduledCalls;

      updatePayload.$set.niOriginalAgent = req.user._id;
      updatePayload.$set.reassignCount   = (lead.reassignCount || 0) + 1;
      updatePayload.$push.scheduledCalls = { $each: newScheduledCalls };

      if (nextUserId) {
        updatePayload.$set.user    = nextUserId;
        updatePayload.$set.niStage = "verification";
        updatePayload.$set.status  = wf.verificationStatus;
      } else {
        // No other agent available — keep with current employee, no verification.
        updatePayload.$set.niStage = null;
        updatePayload.$set.status  = wf.finalStatus;
      }

      outcome = nextUserId ? "sent_for_verification" : "no_verifier_available";
      message = nextUserId
        ? `Lead sent for verification to ${"another agent"} with ${newScheduledCalls.length} scheduled calls.`
        : `No other agent available; lead kept with you. ${newScheduledCalls.length} follow-up calls scheduled.`;
    } else if (stage === "verification") {
      // ── STAGE 2: verifier ALSO marks Not Interested ──────────────────────
      // Send the lead BACK to the original employee, keep it active with the
      // remaining (already-scheduled) follow-ups. Do not schedule new calls.
      const backTo = lead.niOriginalAgent || null;

      if (backTo) {
        updatePayload.$set.user = backTo;
      }
      updatePayload.$set.niStage = "returned";
      // Keep the lead actionable for the original employee with its remaining
      // follow-ups; flag it Not Interested so it's visibly confirmed.
      updatePayload.$set.status  = wf.finalStatus;

      outcome = "returned_to_original";
      message = backTo
        ? "Verification confirmed Not Interested. Lead returned to the original employee with remaining follow-ups."
        : "Verification confirmed Not Interested. Original employee unavailable; lead kept with you.";

      nextUserId = backTo;
    } else {
      // ── STAGE 3+: already returned once — avoid ping-pong ────────────────
      // Reset to New so it stays with the current owner; keep follow-ups intact.
      updatePayload.$set.status = wf.resetStatus;
      outcome = "kept_no_reassign";
      message = "Lead marked Not Interested again. Kept with current employee; existing follow-ups retained.";
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    })
      .populate("user", "name email")
      .populate("previousAgents", "name email")
      .populate("niOriginalAgent", "name email");

    // Build a human message that includes the resolved agent name where relevant.
    if (outcome === "sent_for_verification") {
      message = `Lead sent for verification to ${updatedLead.user?.name || "another agent"} with ${scheduledForResponse.length} scheduled calls.`;
    } else if (outcome === "returned_to_original") {
      message = `Verification confirmed Not Interested. Lead returned to ${updatedLead.user?.name || "the original employee"} with remaining follow-ups.`;
    }

    // Notify the receiving agent (verifier in stage 1, original employee in stage 2).
    if (nextUserId) {
      const _io = global._io;
      if (_io) {
        _io.to(`agent:${nextUserId}`).emit("new_lead_assigned", {
          leadId:   String(updatedLead._id),
          leadName: updatedLead.name,
          source:   updatedLead.source || "",
          eventType: outcome === "sent_for_verification" ? "verification" : "reassigned",
        });
      }
      sendReassignedLeadNotification(nextUserId, updatedLead).catch((e) =>
        console.error("[FCM] reassign push error:", e.message),
      );
      notifyEmployeeLead(nextUserId, updatedLead, updatedLead.company).catch((e) =>
        console.error("[Telegram] NI-reassign employee notify error:", e.message),
      );
    }

    return res.status(200).json({
      lead:           updatedLead,
      reassignedTo:   nextUserId ? updatedLead.user : null,
      scheduledCalls: scheduledForResponse,
      niStage:        updatedLead.niStage,
      outcome,
      // Back-compat flag used by the existing modal success screen:
      // true means "no new reassignment happened" (stage 2 return or stage 3).
      isSecondNI:     outcome !== "sent_for_verification",
      isVerification: outcome === "sent_for_verification",
      isReturned:     outcome === "returned_to_original",
      message,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── markColdReassign ──────────────────────────────────────────────────────────
const markColdReassign = async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    if (!remark || !remark.trim())
      return res.status(400).json({ message: "A remark/reason is required." });

    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const cust = await getCust(lead.company);
    if (employeeDenied(req, res, cust, "canMarkCold", "the cold-lead flow")) return;
    const wf = cust.workflows.cold;
    // The quality that triggers this flow (default "Cold"); falls back to the
    // first quality flagged triggersColdFlow, then "Cold".
    const coldTemp = (cust.temperatures.find((t) => t.triggersColdFlow) || { key: "Cold" }).key;

    const historyEntry = {
      userId: req.user._id,
      userName: req.user.name || "",
      remark: remark.trim(),
      outcome: coldTemp,
      calledAt: new Date(),
    };

    const buildColdScheduledCalls = () => buildScheduledCalls(cust, "cold");

    // Workflow off / verification off → just set the quality, no reassignment.
    const stage = (wf.enabled && wf.verification) ? (lead.coldStage || null) : "__direct__";

    const updatePayload = {
      $set: { temperature: coldTemp, remark: remark.trim() },
      $push: {
        callHistory: historyEntry,
        previousAgents: req.user._id,
      },
    };

    let nextUserId  = null;
    let outcome     = "";
    let scheduledForResponse = [];

    if (stage === "__direct__") {
      if (wf.enabled) {
        const newScheduledCalls = buildColdScheduledCalls();
        scheduledForResponse = newScheduledCalls;
        if (newScheduledCalls.length) updatePayload.$push.scheduledCalls = { $each: newScheduledCalls };
      }
      outcome = "marked_directly";
    } else if (!stage) {
      // ── STAGE 1: first Cold mark — send to another agent for VERIFICATION ──
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      nextUserId = await getNextUser(req.user.company, excludeIds, { purpose: "verify", cust });

      const newScheduledCalls = buildColdScheduledCalls();
      scheduledForResponse = newScheduledCalls;

      updatePayload.$set.coldOriginalAgent = req.user._id;
      updatePayload.$set.coldReassignCount = (lead.coldReassignCount || 0) + 1;
      updatePayload.$push.scheduledCalls   = { $each: newScheduledCalls };

      if (nextUserId) {
        updatePayload.$set.user      = nextUserId;
        updatePayload.$set.coldStage = "verification";
        updatePayload.$set.status    = wf.verificationStatus;
      } else {
        updatePayload.$set.coldStage = null;
        // No verifier available — keep with current agent, status unchanged.
      }

      outcome = nextUserId ? "sent_for_verification" : "no_verifier_available";
    } else if (stage === "verification") {
      // ── STAGE 2: verifier ALSO marks Cold — return to original employee ───
      const backTo = lead.coldOriginalAgent || null;
      if (backTo) updatePayload.$set.user = backTo;
      updatePayload.$set.coldStage = "returned";
      // Keep it active for the original employee with remaining follow-ups.
      updatePayload.$set.status    = wf.returnStatus;

      outcome = "returned_to_original";
      nextUserId = backTo;
    } else {
      // ── STAGE 3+: already returned — keep with current owner, no reassign ─
      updatePayload.$set.status = wf.returnStatus;
      outcome = "kept_no_reassign";
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    })
      .populate("user", "name email")
      .populate("previousAgents", "name email")
      .populate("coldOriginalAgent", "name email");

    let message;
    if (outcome === "marked_directly") {
      message = scheduledForResponse.length
        ? `Lead marked ${coldTemp}. ${scheduledForResponse.length} follow-up call(s) scheduled.`
        : `Lead marked ${coldTemp}.`;
    } else if (outcome === "sent_for_verification") {
      message = `Cold lead sent for verification to ${updatedLead.user?.name || "another agent"} with ${scheduledForResponse.length} scheduled calls.`;
    } else if (outcome === "no_verifier_available") {
      message = `No other agent available; lead kept with you. ${scheduledForResponse.length} follow-up calls scheduled.`;
    } else if (outcome === "returned_to_original") {
      message = `Verification confirmed Cold. Lead returned to ${updatedLead.user?.name || "the original employee"} with remaining follow-ups.`;
    } else {
      message = "Lead marked Cold again. Kept with current employee; existing follow-ups retained.";
    }

    if (nextUserId) {
      const _io = global._io;
      if (_io) {
        _io.to(`agent:${nextUserId}`).emit("new_lead_assigned", {
          leadId:   String(updatedLead._id),
          leadName: updatedLead.name,
          source:   updatedLead.source || "",
          eventType: outcome === "sent_for_verification" ? "verification" : "cold_reassigned",
        });
      }
      sendReassignedLeadNotification(nextUserId, updatedLead).catch((e) =>
        console.error("[FCM] cold-reassign push error:", e.message),
      );
      notifyEmployeeLead(nextUserId, updatedLead, updatedLead.company).catch((e) =>
        console.error("[Telegram] cold-reassign employee notify error:", e.message),
      );
    }

    return res.status(200).json({
      lead:           updatedLead,
      reassignedTo:   nextUserId ? updatedLead.user : null,
      scheduledCalls: scheduledForResponse,
      coldStage:      updatedLead.coldStage,
      outcome,
      // Back-compat flag: true when no fresh reassignment happened.
      isSecondCold:   outcome !== "sent_for_verification",
      isVerification: outcome === "sent_for_verification",
      isReturned:     outcome === "returned_to_original",
      message,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── markInvalid ───────────────────────────────────────────────────────────────
// Two-step "Invalid" verification flow, mirroring markNotInterested:
//   STAGE 1 (first Invalid): reassign round-robin to another agent for
//     verification. Remember the original employee. Lead status → "Verification".
//   STAGE 2 (verifier ALSO marks Invalid): CLOSE the lead — isClosed=true,
//     unassign it (user=null) so it leaves every employee panel, and notify the
//     admin. It then appears only in the admin "Closed Leads" view.
//   If the verifier DISAGREES (picks any other outcome), that goes through the
//     normal patchLead path — the lead returns to the original employee via the
//     "return" branch below is NOT used; disagreement is handled by the client
//     simply choosing a different outcome, which we cannot intercept here.
//     To explicitly support "verifier rejects invalid", the client calls this
//     endpoint with { reject: true } → lead returns to original employee + admin
//     is notified.
const markInvalid = async (req, res) => {
  try {
    const { id } = req.params;
    const { remark, reject } = req.body;

    if (!remark || !remark.trim())
      return res.status(400).json({ message: "A remark/reason is required." });

    const companyId = getCompanyId(req);
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    if (lead.isClosed)
      return res.status(400).json({ message: "Lead is already closed." });

    const cust = await getCust(companyId || lead.company);
    if (employeeDenied(req, res, cust, "canMarkInvalid", "marking leads Invalid")) return;
    const wf = cust.workflows.invalid;
    const invalidOutcome = (cust.outcomes.find((o) => o.behavior === "invalid") || { key: "Invalid" }).key;
    if (!wf.enabled) {
      return res.status(400).json({ message: "The Invalid lead workflow is turned off for your company." });
    }

    const _io = global._io;
    const UserModel = require("../models/Users");

    // Resolve the admin who should be notified for this lead.
    const resolveAdminId = async () => {
      try {
        const employee = await UserModel.findById(lead.user || req.user._id)
          .select("createdBy")
          .lean();
        const raw = lead.assignedAdmin || employee?.createdBy || null;
        return raw ? String(raw) : null;
      } catch {
        return null;
      }
    };

    const stage = lead.invalidStage || null;

    const historyEntry = {
      userId:   req.user._id,
      userName: req.user.name || "",
      remark:   remark.trim(),
      outcome:  reject ? `${invalidOutcome} Rejected` : invalidOutcome,
      calledAt: new Date(),
    };

    // ── Verifier REJECTS invalid → return to original employee + notify admin ──
    if (stage === "verification" && reject) {
      const backTo = lead.invalidOriginalAgent || null;
      const updatePayload = {
        $set: {
          remark:       remark.trim(),
          invalidStage: null,
          status:       wf.resetStatus,
        },
        $push: { callHistory: historyEntry },
      };
      if (backTo) updatePayload.$set.user = backTo;

      const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, { new: true })
        .populate("user", "name email")
        .populate("invalidOriginalAgent", "name email");

      // Notify the original employee it's back with them.
      if (backTo && _io) {
        _io.to(`agent:${backTo}`).emit("new_lead_assigned", {
          leadId:    String(updatedLead._id),
          leadName:  updatedLead.name,
          source:    updatedLead.source || "",
          eventType: "invalid_rejected",
        });
      }
      if (backTo) {
        sendReassignedLeadNotification(backTo, updatedLead).catch((e) =>
          console.error("[FCM] invalid-reject reassign error:", e.message),
        );
        notifyEmployeeLead(backTo, updatedLead, updatedLead.company).catch((e) =>
          console.error("[Telegram] invalid-reject notify error:", e.message),
        );
      }

      // Notify admin that the verification rejected the Invalid mark.
      if (_io) {
        const adminId = await resolveAdminId();
        const payload = {
          leadId:     String(updatedLead._id),
          leadName:   updatedLead.name,
          remark:     remark.trim(),
          verifiedBy: req.user.name || "Employee",
          returnedTo: updatedLead.user?.name || "original employee",
          at:         new Date().toISOString(),
        };
        if (adminId) _io.to(`admin_room:${adminId}`).emit("lead_invalid_rejected", payload);
        if (updatedLead.company)
          _io.to(`company_admin:${String(updatedLead.company)}`).emit("lead_invalid_rejected", payload);
      }

      return res.status(200).json({
        lead:         updatedLead,
        outcome:      "invalid_rejected",
        invalidStage: null,
        isClosed:     false,
        message: `Verification rejected the Invalid mark. Lead returned to ${updatedLead.user?.name || "the original employee"}.`,
      });
    }

    // ── STAGE 2: verifier CONFIRMS Invalid → close the lead ────────────────────
    if (stage === "verification") {
      const updatedLead = await Lead.findByIdAndUpdate(
        id,
        {
          $set: {
            remark:       remark.trim(),
            isClosed:     true,
            closeReason:  remark.trim() || "Invalid (verified)",
            closedAt:     new Date(),
            closedBy:     req.user._id,
            invalidStage: null,
            status:       wf.closedStatus,
            user:         null,   // remove from every employee panel
          },
          $push: { callHistory: historyEntry },
        },
        { new: true },
      ).populate("invalidOriginalAgent", "name email");

      // Notify admin the lead has been verified-invalid and closed.
      if (_io) {
        const adminId = await resolveAdminId();
        const payload = {
          leadId:     String(updatedLead._id),
          leadName:   updatedLead.name,
          remark:     remark.trim(),
          closedBy:   req.user.name || "Employee",
          closedAt:   new Date().toISOString(),
          reason:     "Verified Invalid",
        };
        if (adminId) _io.to(`admin_room:${adminId}`).emit("lead_closed_by_user", payload);
        if (updatedLead.company)
          _io.to(`company_admin:${String(updatedLead.company)}`).emit("lead_closed_by_user", payload);
      }

      return res.status(200).json({
        lead:         updatedLead,
        outcome:      "closed_invalid",
        invalidStage: null,
        isClosed:     true,
        message: "Verification confirmed Invalid. Lead closed and removed from employee panels.",
      });
    }

    // ── STAGE 1: first Invalid → send to another agent for verification ────────
    // (verification switched off for the company → close immediately)
    const excludeIds = [...(lead.previousAgents || []), req.user._id];
    const nextUserId = wf.verification
      ? await getNextUser(req.user.company, excludeIds, { purpose: "verify", cust })
      : null;

    const updatePayload = {
      $set: {
        remark:               remark.trim(),
        invalidOriginalAgent: req.user._id,
        invalidReassignCount: (lead.invalidReassignCount || 0) + 1,
      },
      $push: {
        callHistory:    historyEntry,
        previousAgents: req.user._id,
      },
    };

    if (nextUserId) {
      updatePayload.$set.user         = nextUserId;
      updatePayload.$set.invalidStage = "verification";
      updatePayload.$set.status       = wf.verificationStatus;
    } else {
      // No other agent available — close immediately with the single mark.
      updatePayload.$set.invalidStage = null;
      updatePayload.$set.isClosed     = true;
      updatePayload.$set.closeReason  = remark.trim() || invalidOutcome;
      updatePayload.$set.closedAt     = new Date();
      updatePayload.$set.closedBy     = req.user._id;
      updatePayload.$set.status       = wf.closedStatus;
      updatePayload.$set.user         = null;
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, { new: true })
      .populate("user", "name email")
      .populate("invalidOriginalAgent", "name email");

    if (nextUserId) {
      // Notify the verifier.
      if (_io) {
        _io.to(`agent:${nextUserId}`).emit("new_lead_assigned", {
          leadId:    String(updatedLead._id),
          leadName:  updatedLead.name,
          source:    updatedLead.source || "",
          eventType: "invalid_verification",
        });
      }
      sendReassignedLeadNotification(nextUserId, updatedLead).catch((e) =>
        console.error("[FCM] invalid-verify reassign error:", e.message),
      );
      notifyEmployeeLead(nextUserId, updatedLead, updatedLead.company).catch((e) =>
        console.error("[Telegram] invalid-verify notify error:", e.message),
      );
    } else if (_io) {
      // No verifier — closed straight away; notify admin.
      const adminId = await resolveAdminId();
      const payload = {
        leadId:   String(updatedLead._id),
        leadName: updatedLead.name,
        remark:   remark.trim(),
        closedBy: req.user.name || "Employee",
        closedAt: new Date().toISOString(),
        reason:   "Invalid (no verifier available)",
      };
      if (adminId) _io.to(`admin_room:${adminId}`).emit("lead_closed_by_user", payload);
      if (updatedLead.company)
        _io.to(`company_admin:${String(updatedLead.company)}`).emit("lead_closed_by_user", payload);
    }

    return res.status(200).json({
      lead:         updatedLead,
      reassignedTo: nextUserId ? updatedLead.user : null,
      outcome:      nextUserId ? "sent_for_verification" : "closed_no_verifier",
      invalidStage: updatedLead.invalidStage,
      isClosed:     !!updatedLead.isClosed,
      message: nextUserId
        ? `Lead marked Invalid and sent to ${updatedLead.user?.name || "another agent"} for verification.`
        : "Lead marked Invalid. No other agent available, so it was closed immediately.",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── closeLeadWrongEntry ───────────────────────────────────────────────────────
const closeLeadWrongEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const companyId = getCompanyId(req);
    const cust = await getCust(companyId);
    if (employeeDenied(req, res, cust, "canCloseLeads", "closing leads")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          isClosed: true,
          closeReason: reason || "Wrong entry",
          closedAt: new Date(),
          closedBy: req.admin?._id || req.superAdmin?._id || null,
        },
      },
      { new: true },
    );
    return res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── closeLeadByUser (employee closes a lead with a phone number + remark) ──────
// POST /lead/:id/close-by-user
// Body: { phone: "9876543210", remark: "Customer not reachable after 5 attempts" }
// Marks the lead as closed, records the closing phone number and remark, then
// emits a real-time socket notification to the admin's room.
const closeLeadByUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    const phone = String(req.body.phone || "");
    const companyId = getCompanyId(req);
    const cust = await getCust(companyId);
    if (employeeDenied(req, res, cust, "canCloseLeads", "closing leads")) return;
    const closeCfg = cust.workflows.closeByEmployee;
    if (!closeCfg.enabled)
      return res.status(400).json({ message: "Closing leads is turned off for your company." });
    if (closeCfg.requirePhone && !phone.trim())
      return res.status(400).json({ message: "Phone number is required to close a lead." });
    if (!remark || !remark.trim())
      return res.status(400).json({ message: "Remark is required to close a lead." });

    const lead = await Lead.findOne({ _id: id, company: companyId, user: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found or not assigned to you." });
    if (lead.isClosed) return res.status(400).json({ message: "Lead is already closed." });

    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          isClosed:       true,
          closeReason:    remark.trim(),
          closedAt:       new Date(),
          closedBy:       req.user._id,
          status:         closeCfg.closedStatus,
        },
        $push: {
          callHistory: {
            userId:   req.user._id,
            userName: req.user.name || "",
            remark:   remark.trim(),
            outcome:  "Closed",
            calledAt: new Date(),
            calledNumber: phone.replace(/\D/g, ""),
            numberType: "Closing",
          },
        },
      },
      { new: true }
    );

    // ── Notify admin via socket ───────────────────────────────────────────────
    const _io = global._io;
    if (_io) {
      try {
        const UserModel = require("../models/Users");
        const employee  = await UserModel.findById(req.user._id).select("createdBy name").lean();

        // Resolve adminId: prefer lead.assignedAdmin, then employee.createdBy
        const rawAdminId = lead.assignedAdmin || employee?.createdBy || null;
        const adminId    = rawAdminId ? String(rawAdminId) : null;

        if (adminId) {
          _io.to(`admin_room:${adminId}`).emit("lead_closed_by_user", {
            leadId:   String(lead._id),
            leadName: lead.name,
            phone:    phone.replace(/\D/g, ""),
            remark:   remark.trim(),
            closedBy: req.user.name || "Employee",
            closedAt: new Date().toISOString(),
          });
        }
        // Also emit to company-wide admin room as fallback so any admin on duty sees it
        if (lead.company) {
          _io.to(`company_admin:${String(lead.company)}`).emit("lead_closed_by_user", {
            leadId:   String(lead._id),
            leadName: lead.name,
            phone:    phone.replace(/\D/g, ""),
            remark:   remark.trim(),
            closedBy: req.user.name || "Employee",
            closedAt: new Date().toISOString(),
          });
        }
      } catch (socketErr) {
        console.error("[closeLeadByUser] socket error:", socketErr.message);
      }
    }

    return res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateLeadEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    if (!email || !email.trim())
      return res.status(400).json({ message: "email is required" });

    const companyId = req.admin?.company?._id || req.admin?.company;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found" });

    lead.email = email.trim().toLowerCase();
    await lead.save();

    return res.status(200).json({ message: "Email updated", lead });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkUpdateEmails = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ message: "updates array is required" });

    let matched = 0,
      notFound = 0;
    const notFoundList = [];

    const scope = await getAdminLeadScope(req, companyId);

    for (const row of updates) {
      const mobile = (row.mobile || "").replace(/\D/g, "");
      const email = (row.email || "").trim().toLowerCase();
      if (!mobile || !email) continue;

      const result = await Lead.updateMany(
        mergeLeadScope({ company: companyId, mobile }, scope),
        { $set: { email } },
      );

      if (result.matchedCount > 0) {
        matched += result.matchedCount;
      } else {
        notFound++;
        notFoundList.push(mobile);
      }
    }

    res.json({
      message: `${matched} lead(s) updated, ${notFound} mobile(s) not found`,
      matched,
      notFound,
      notFoundList,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminGetAllLeads = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId)
      return res.status(400).json({ message: "Company not found in token." });

    // PERF FIX: this previously called Lead.find(query) with NO .limit()/.skip()
    // at all — it silently ignored the `page`/`limit` query params the frontend
    // was already sending (?page=1&limit=500) and fetched EVERY lead in the
    // company, with every embedded array (callHistory, meetingRemarks,
    // activityTimeline, templateHistory, qualificationBreakdown, reveal logs,
    // etc.) plus 2 populates, on every single load of the Lead Management page.
    // That unbounded fetch — not the field-encryption work — is what made this
    // page take 5-6 seconds: as the leads collection grows, so does the payload
    // size and the client-side JSON parse/render cost.
    //
    // This now honours page/limit the same way getMyLeads already does, capped
    // at 500 per page to keep each request small and fast. Response shape is
    // unchanged from the frontend's point of view: AdminLeadsPage.fetchLeads
    // already reads `leadsRes.data?.leads` first (with an array fallback for
    // backward compatibility), so no frontend change is required for this fix.
    const page  = Math.max(1, parseInt(req.query.page  || "1",   10));
    // FIX: removed hardcoded 500 cap — allow fetching all leads across pages.
    // Frontend now fetches multiple pages if total > limit.
    // Capped at 1000 per page so one request can never pull an unbounded payload.
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || "500", 10) || 500));
    const skip  = (page - 1) * limit;

    // Per-admin isolation: admins see only their own leads; super_admin sees all.
    const scope = await getAdminLeadScope(req, companyId);
    const query = mergeLeadScope({ company: companyId, mergedInto: null }, scope);

    // PERF: the total count is only needed on page 1 (the client reads
    // `pages` from page 1 and then fetches the rest). Counting again on every
    // later page doubled the DB work for big companies.
    const [leads, total] = await Promise.all([
      Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(ADMIN_LIST_PROJECTION)
        .populate("user", "name email")
        .lean(),
      page === 1 || req.query.count === "1" ? Lead.countDocuments(query) : Promise.resolve(null),
    ]);

    // SECURITY: mask PII based on caller role
    const _callerRole = getCallerRole(req);
    const _callerId = getCallerId(req);
    const maskedLeads = leads.map(l => maskLeadPII(l.toObject ? l.toObject() : l, _callerRole, _callerId));
    res.status(200).json({ leads: maskedLeads, total, page, limit, pages: total == null ? null : (Math.ceil(total / limit) || 1) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── checkDuplicate: checks both primary and secondary phone ───────────────────
const checkDuplicate = async (req, res) => {
  try {
    const { mobile } = req.query;
    if (!mobile)
      return res
        .status(400)
        .json({ message: "mobile query param is required" });

    const companyId  = req.user?.company || req.admin?.company?._id || req.admin?.company;
    const normalized = normalizePhone(mobile);
    if (!normalized) return res.status(200).json({ duplicate: false });

    const existing = await Lead.findOne({
      company: companyId,
      $or: [
        { normalizedPhone: normalized },
        { normalizedSecondaryPhone: normalized },
      ],
    })
      .select("name mobile primaryPhone secondaryPhone status user createdAt")
      .populate("user", "name");

    if (existing) {
      // Return both `lead` (legacy) and `existingLead` (required by merge flow)
      return res.status(200).json({ duplicate: true, lead: existing, existingLead: existing });
    }
    return res.status(200).json({ duplicate: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const logPhoneReveal = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = req.user?._id || req.admin?._id;
    const actorName = req.user?.name || req.admin?.name || "";
    const companyId =
      req.user?.company || req.admin?.company?._id || req.admin?.company;

    const revealCust = await getCust(companyId);
    if (employeeDenied(req, res, revealCust, "canRevealContact", "revealing contact details")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found" });

    await Lead.findByIdAndUpdate(id, {
      $inc: { phoneRevealCount: 1 },
      $push: {
        phoneRevealLog: {
          userId: actorId,
          userName: actorName,
          revealedAt: new Date(),
        },
      },
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Log Email Reveal ──────────────────────────────────────────────────────────
const logEmailReveal = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId   = req.user?._id   || req.admin?._id;
    const actorName = req.user?.name  || req.admin?.name || "";
    const companyId =
      req.user?.company || req.admin?.company?._id || req.admin?.company;

    const revealCust = await getCust(companyId);
    if (employeeDenied(req, res, revealCust, "canRevealContact", "revealing contact details")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found" });

    await Lead.findByIdAndUpdate(id, {
      $inc: { emailRevealCount: 1 },
      $push: {
        emailRevealLog: {
          userId:    actorId,
          userName:  actorName,
          revealedAt: new Date(),
        },
      },
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getFollowUpAlerts = async (req, res) => {
  try {
    const company =
      req.user?.company || req.admin?.company?._id || req.admin?.company;
    if (!company)
      return res.status(400).json({ message: "Company not found." });

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const baseQuery = { company };
    if (
      req.user &&
      req.user.role !== "admin" &&
      req.user.role !== "superadmin"
    ) {
      baseQuery.user = req.user._id;
    }

    // Per-admin isolation (no-op for super_admin and employees).
    const scope = await getAdminLeadScope(req, company);
    const alertQuery = mergeLeadScope({
      ...baseQuery,
      scheduledCalls: {
        $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } },
      },
    }, scope);

    const leads = await Lead.find(alertQuery)
      .select("_id name status scheduledCalls")
      .lean();

    let todayLeadCount = 0,
      overdueLeadCount = 0;

    for (const lead of leads) {
      const pendingCalls = lead.scheduledCalls
        .filter((sc) => !sc.done)
        .map((sc) => new Date(sc.scheduledAt))
        .sort((a, b) => a - b);

      if (pendingCalls.length === 0) continue;

      const earliest = pendingCalls[0];
      if (earliest < todayStart) {
        overdueLeadCount++;
      } else if (earliest <= todayEnd) {
        todayLeadCount++;
      }
    }

    return res.status(200).json({
      todayCount: todayLeadCount,
      overdueCount: overdueLeadCount,
      total: todayLeadCount + overdueLeadCount,
      todayLeadCount,
      overdueLeadCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /lead/admin/pending-notifications ─────────────────────────────────────
// Powers the notification bell on LOAD, so it shows currently-pending issues
// even if the admin was offline when the 15-min job emitted its socket events
// (those live emits are lost if no socket is in the room). Returns the same
// shape the bell already renders for `no_action_alert` and `follow_up_alert`,
// as a list of ready-to-display notification objects.
//
// Scope: super_admin → whole company; admin → only leads they are responsible
// for (assignedAdmin). Mirrors the job's no-action criteria (assigned, open,
// not converted/closed, no call activity) and the follow-up overdue/today logic.
const getPendingNotifications = async (req, res) => {
  try {
    const role    = req.admin?.role || req.user?.role;
    const company = req.admin?.company?._id || req.admin?.company || req.user?.company;
    const adminId = req.admin?._id || req.user?._id;
    if (!company) return res.status(400).json({ message: "Company not found." });

    const isSuperAdmin = role === "super_admin" || role === "superadmin";

    const notifCust    = await getCust(company);
    const na           = notifCust.alerts.noAction;
    const now          = Date.now();
    const oneHourAgo   = new Date(now - na.firstAlertHours  * 60 * 60 * 1000);
    const twoHoursAgo  = new Date(now - na.secondAlertHours * 60 * 60 * 1000);
    const fmtH = (h) => (h % 1 === 0 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(h * 60)} minutes`);
    const todayStart   = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd     = new Date(); todayEnd.setHours(23, 59, 59, 999);

    // Scope filter: admins see only their own assigned leads.
    const scope = { company };
    if (!isSuperAdmin && adminId) scope.assignedAdmin = adminId;

    // ── No-action leads (assigned, untouched, past 1h / 2h) ───────────────────
    const noActionBase = {
      ...scope,
      user:        { $ne: null },
      isClosed:    { $ne: true },
      status:      { $nin: custSvc.closedStatusKeys(notifCust) },
      callHistory: { $size: 0 },
    };

    // PERF: ONE no-action query (1h list is a superset of the 2h list) run in
    // parallel with the follow-up query — was 3 sequential round trips.
    const [noActionAll, fuLeads] = await Promise.all([
      !na.enabled ? [] : Lead.find({ ...noActionBase, createdAt: { $lte: oneHourAgo } })
        .select("_id name user createdAt").populate("user", "name").lean(),
      // ── Follow-up leads (scheduled call not done, overdue or due today) ────
      Lead.find({
        ...scope,
        scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } } },
      }).select("_id name scheduledCalls").lean(),
    ]);
    const noAction2h = noActionAll.filter(l => new Date(l.createdAt) <= twoHoursAgo);
    const noAction1h = noActionAll.filter(l => new Date(l.createdAt) > twoHoursAgo); // 1h list excludes those already 2h+

    const overdue = [], dueToday = [];
    for (const lead of fuLeads) {
      const earliest = lead.scheduledCalls
        .filter(sc => !sc.done)
        .map(sc => new Date(sc.scheduledAt))
        .sort((a, b) => a - b)[0];
      if (!earliest) continue;
      if (earliest < todayStart) overdue.push(lead);
      else if (earliest <= todayEnd) dueToday.push(lead);
    }

    // ── Assemble bell-ready notification objects ──────────────────────────────
    const notifications = [];
    const mkLeads = (arr) => arr.map(l => ({ leadId: String(l._id), leadName: l.name, assignedTo: l.user?.name || "" }));

    if (noAction2h.length) notifications.push({
      id: "noa-2h", type: "no_action",
      title: `${noAction2h.length} Lead${noAction2h.length > 1 ? "s" : ""} — No Action`,
      body: noAction2h.length === 1
        ? `"${noAction2h[0].name}" has had no activity for ${fmtH(na.secondAlertHours)}.`
        : `${noAction2h.length} leads have had no activity for ${fmtH(na.secondAlertHours)}.`,
      leads: mkLeads(noAction2h), threshold: "2h",
      timestamp: new Date().toISOString(), urgent: true,
    });
    if (noAction1h.length) notifications.push({
      id: "noa-1h", type: "no_action",
      title: `${noAction1h.length} Lead${noAction1h.length > 1 ? "s" : ""} — No Action`,
      body: noAction1h.length === 1
        ? `"${noAction1h[0].name}" has had no activity for ${fmtH(na.firstAlertHours)}.`
        : `${noAction1h.length} leads have had no activity for ${fmtH(na.firstAlertHours)}.`,
      leads: mkLeads(noAction1h), threshold: "1h",
      timestamp: new Date().toISOString(), urgent: false,
    });
    if (overdue.length) notifications.push({
      id: "fu-overdue", type: "follow_up",
      title: `${overdue.length} Overdue Follow-Up${overdue.length > 1 ? "s" : ""}`,
      body: overdue.length === 1 ? `"${overdue[0].name}" — overdue.` : `${overdue.length} leads are overdue.`,
      leads: mkLeads(overdue), threshold: "overdue",
      timestamp: new Date().toISOString(), urgent: true,
    });
    if (dueToday.length) notifications.push({
      id: "fu-due", type: "follow_up",
      title: `${dueToday.length} Follow-Up${dueToday.length > 1 ? "s" : ""} Due Today`,
      body: dueToday.length === 1 ? `"${dueToday[0].name}" — due today.` : `${dueToday.length} leads need follow-up today.`,
      leads: mkLeads(dueToday), threshold: "today",
      timestamp: new Date().toISOString(), urgent: false,
    });

    return res.status(200).json({ notifications, count: notifications.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Add or replace the secondary (additional) phone on a lead.
// Enforces: max one additional number, uniqueness across all leads in company.
const addSecondaryPhone = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { secondaryPhone } = req.body;
    if (!secondaryPhone || !String(secondaryPhone).trim()) {
      return res.status(400).json({ message: "secondaryPhone is required" });
    }
    const companyId = getCompanyId(req);
    if (employeeDenied(req, res, await getCust(companyId), "canEditPhoneNumbers", "editing phone numbers")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    }, scope));
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const normPrimary   = normalizePhone(lead.primaryPhone || lead.mobile || "");
    const normSecondary = normalizePhone(secondaryPhone);

    if (!normSecondary) {
      return res.status(400).json({ message: "Invalid phone number format." });
    }

    if (normSecondary === normPrimary) {
      return res
        .status(409)
        .json({
          message: "Additional number cannot be the same as primary number.",
        });
    }

    // Ensure uniqueness: no other lead in the company has this number
    if (companyId) {
      const conflict = await Lead.findOne({
        company: companyId,
        _id: { $ne: id },
        $or: [
          { normalizedPhone: normSecondary },
          { normalizedSecondaryPhone: normSecondary },
        ],
      }).select("name mobile primaryPhone secondaryPhone status createdAt").lean();
      if (conflict) {
        return res.status(409).json({
          message: `This number already belongs to lead "${conflict.name}".`,
          existingLead: conflict,   // ← required by frontend merge flow
        });
      }
    }

    const now = new Date();
    const actorId = req.user?._id || req.admin?._id || null;

    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          secondaryPhone,
          normalizedSecondaryPhone: normSecondary,
        },
        $push: {
          activityTimeline: {
            action: "additional_number_added",
            performedBy: actorId,
            role: req.admin ? "admin" : "user",
            timestamp: now,
            note: `Additional number added: ${secondaryPhone}`,
          },
        },
      },
      { new: true },
    ).populate("user", "name email");

    return res.status(200).json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /lead/:id/secondary-phone ──────────────────────────────────────────
// Remove the additional phone from a lead. Logs the action.
const removeSecondaryPhone = async (req, res, next) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    if (employeeDenied(req, res, await getCust(companyId), "canEditPhoneNumbers", "editing phone numbers")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    }, scope));
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const actorId = req.user?._id || req.admin?._id || null;
    const removedNumber = lead.secondaryPhone || "";

    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          secondaryPhone: null,
          normalizedSecondaryPhone: null,
        },
        $push: {
          activityTimeline: {
            action: "additional_number_removed",
            performedBy: actorId,
            role: req.admin ? "admin" : "user",
            timestamp: new Date(),
            note: `Additional number removed: ${removedNumber}`,
          },
        },
      },
      { new: true },
    ).populate("user", "name email");

    return res.status(200).json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
};

// ── PUT /lead/:id/swap-phones ─────────────────────────────────────────────────
// Swap primary and secondary phone numbers. Maintains full audit history.
const swapPhones = async (req, res, next) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    if (employeeDenied(req, res, await getCust(companyId), "canEditPhoneNumbers", "editing phone numbers")) return;
    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    }, scope));
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    if (!lead.secondaryPhone) {
      return res
        .status(400)
        .json({ message: "No additional number to swap with." });
    }

    const oldPrimary = lead.primaryPhone || lead.mobile;
    const oldSecondary = lead.secondaryPhone;
    const actorId = req.user?._id || req.admin?._id || null;

    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          mobile: oldSecondary,
          primaryPhone: oldSecondary,
          normalizedPhone: normalizePhone(oldSecondary) || null,
          secondaryPhone: oldPrimary,
          normalizedSecondaryPhone: normalizePhone(oldPrimary) || null,
        },
        $push: {
          activityTimeline: {
            action: "numbers_swapped",
            performedBy: actorId,
            role: req.admin ? "admin" : "user",
            timestamp: new Date(),
            note: `Numbers swapped. New primary: ${oldSecondary}, new additional: ${oldPrimary}`,
          },
        },
      },
      { new: true },
    ).populate("user", "name email");

    return res.status(200).json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
};

// ── POST /lead/admin/:id/merge  (or /superadmin/:id/merge) ────────────────────
// Merge a duplicate lead into an existing lead.
//
// Body: { secondaryPhone, sourceName, sourceMobile, sourceLeadId? }
//
// What this does:
//   1. Adds `secondaryPhone` to the TARGET lead (the one whose :id is in the URL).
//   2. Logs a timeline entry on the target lead.
//   3. If `sourceLeadId` is provided, marks that lead as mergedInto the target
//      so it stops appearing as an active lead after page refresh.
//   4. Returns the updated target lead.
const mergeLead = async (req, res, next) => {
  try {
    const { id } = req.params;                       // SURVIVOR: the lead we keep (its number stays primary)
    const { secondaryPhone, sourceName, sourceMobile, sourceLeadId } = req.body;
    // secondaryPhone = the number to attach to the survivor (the absorbed lead's primary)
    // sourceLeadId   = the duplicate lead to fold in + hide (optional)

    if (!secondaryPhone || !String(secondaryPhone).trim()) {
      return res.status(400).json({ message: "secondaryPhone is required for merge." });
    }

    const companyId = getCompanyId(req);
    if (employeeDenied(req, res, await getCust(companyId), "canMergeLeads", "merging leads")) return;
    const actorId   = req.user?._id || req.admin?._id || req.superAdmin?._id || null;
    const actorRole = req.admin ? "admin" : (req.superAdmin ? "superadmin" : "user");

    // ── Load the SURVIVING lead (the one we keep) ────────────────────────────
    const scope = await getAdminLeadScope(req, companyId);
    const survivor = await Lead.findOne(mergeLeadScope({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    }, scope));
    if (!survivor) return res.status(404).json({ message: "Target lead not found." });

    const normSecondary = normalizePhone(secondaryPhone);
    if (!normSecondary) {
      return res.status(400).json({ message: "Invalid phone number format." });
    }
    const normPrimary  = normalizePhone(survivor.primaryPhone || survivor.mobile || "");
    const normExisting = survivor.secondaryPhone ? normalizePhone(survivor.secondaryPhone) : null;
    // "Adding a number" only when it differs from the survivor's own primary.
    const addingNewNumber = normSecondary !== normPrimary;

    // ── Load the lead being absorbed (optional) ──────────────────────────────
    let source = null;
    if (sourceLeadId) {
      source = await Lead.findOne({
        _id: sourceLeadId,
        ...(companyId ? { company: companyId } : {}),
      });
    }

    // A lead holds at most TWO numbers. Reject merges that would need a third.
    if (addingNewNumber && normExisting && normExisting !== normSecondary) {
      return res.status(409).json({
        message: `"${survivor.name}" already has two numbers. Remove one before merging.`,
      });
    }
    if (source && source.secondaryPhone) {
      const normSrcSec = normalizePhone(source.secondaryPhone);
      if (normSrcSec && normSrcSec !== normPrimary && normSrcSec !== normSecondary) {
        return res.status(409).json({
          message: `"${source.name}" has two numbers, so it can't be merged into a single lead. Remove one of its numbers first.`,
        });
      }
    }

    // ── Conflict check: the number must not belong to a THIRD lead ───────────
    // Exclude BOTH the survivor (id) and the absorbed source (sourceLeadId):
    // the source legitimately owns this number — folding it in is the point.
    if (companyId && addingNewNumber) {
      const excludeIds = [id, ...(sourceLeadId ? [sourceLeadId] : [])];
      const conflict = await Lead.findOne({
        company: companyId,
        _id: { $nin: excludeIds },
        $or: [
          { normalizedPhone: normSecondary },
          { normalizedSecondaryPhone: normSecondary },
        ],
      }).select("name").lean();
      if (conflict) {
        return res.status(409).json({
          message: `This number already belongs to lead "${conflict.name}".`,
        });
      }
    }

    const now        = new Date();
    const mergedName = sourceName || source?.name || "";

    // ── Build the survivor update ────────────────────────────────────────────
    // Collect every $push into ONE object — multiple $push keys silently
    // overwrite each other in a single update document.
    const setOps  = {};
    const pushOps = {};

    if (addingNewNumber) {
      setOps.secondaryPhone           = secondaryPhone;
      setOps.normalizedSecondaryPhone = normSecondary;
    }
    if (mergedName) setOps.mergedSourceName = mergedName;

    // Fold the absorbed lead's embedded history into the survivor (strip the
    // sub-document _ids so the survivor mints fresh ones).
    const stripId = (arr) => (arr || []).map((d) => {
      const o = typeof d.toObject === "function" ? d.toObject() : { ...d };
      delete o._id;
      return o;
    });
    const timelineExtra = [];
    if (source) {
      const ch = stripId(source.callHistory);
      const sc = stripId(source.scheduledCalls);
      if (ch.length) pushOps.callHistory    = { $each: ch };
      if (sc.length) pushOps.scheduledCalls = { $each: sc };
      timelineExtra.push(...stripId(source.activityTimeline));
    }

    const mergeNote = mergedName
      ? `Merged with duplicate lead "${mergedName}" (${sourceMobile || secondaryPhone}). ${addingNewNumber ? "Number added as secondary; " : ""}call logs, WhatsApp and history consolidated.`
      : (addingNewNumber
          ? `Merged duplicate number ${secondaryPhone} as secondary.`
          : `Merged duplicate entry for ${secondaryPhone}.`);

    pushOps.activityTimeline = {
      $each: [
        ...timelineExtra,
        { action: "leads_merged", performedBy: actorId, role: actorRole, timestamp: now, note: mergeNote },
      ],
    };

    const update = {};
    if (Object.keys(setOps).length)  update.$set  = setOps;
    if (Object.keys(pushOps).length) update.$push = pushOps;

    const updated = await Lead.findByIdAndUpdate(id, update, { new: true })
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    // ── Re-point the absorbed lead's external records + hide it ──────────────
    if (source) {
      const MobileCallLog        = require("../models/MobileCallLog");
      const WhatsAppConversation = require("../models/WhatsAppConversation");

      // Call logs + recordings are fetched strictly by matchedLead, so they
      // must be moved to the survivor or they vanish from its view. Their
      // number is now the survivor's secondary.
      await MobileCallLog.updateMany(
        { matchedLead: source._id, ...(companyId ? { company: companyId } : {}) },
        { $set: { matchedLead: survivor._id, matchedNumberType: addingNewNumber ? "Secondary" : "Primary" } },
      ).catch((e) => console.error("[mergeLead] MobileCallLog re-point failed:", e.message));

      // WhatsApp threads → survivor (the by-lead fetch also searches by phone
      // variants, but re-pointing keeps the data consistent).
      await WhatsAppConversation.updateMany(
        { lead: source._id, ...(companyId ? { company: companyId } : {}) },
        { $set: { lead: survivor._id } },
      ).catch((e) => console.error("[mergeLead] WhatsAppConversation re-point failed:", e.message));

      // Hide the source AND free its number from the dedup index so future
      // calls/WhatsApp resolve to the survivor (whose secondary now owns it).
      await Lead.findByIdAndUpdate(source._id, {
        $set: {
          mergedInto:               survivor._id,
          normalizedPhone:          null,
          normalizedSecondaryPhone: null,
        },
        $push: {
          activityTimeline: {
            action:      "leads_merged",
            performedBy: actorId,
            role:        actorRole,
            timestamp:   now,
            note:        `This lead was merged into "${survivor.name}" (${survivor.primaryPhone || survivor.mobile}). Its number is now a secondary on that lead.`,
          },
        },
      }).catch((e) => console.error("[mergeLead] hide source failed:", e.message));
    }

    return res.status(200).json({
      success:       true,
      lead:          updated,
      absorbedLeadId: source ? String(source._id) : null,
      dataOnlyMerge: !addingNewNumber,
    });
  } catch (err) {
    next(err);
  }
};

// ── getLeadActionSummary ──────────────────────────────────────────────────────
// GET /lead/:id/action-summary?refresh=0|1
// Builds (or returns cached) an AI action summary for a lead based on its
// remarks. On Pro/Advance (callTranscription/aiSummary entitlement) the call
// transcripts/summaries are folded in for a richer result.
// Cached on the lead; regenerated only when new remarks/calls were added since
// the cache was built, or when ?refresh=1 is passed.
const getLeadActionSummary = async (req, res) => {
  try {
    const { id } = req.params;
    const forceRefresh = String(req.query.refresh || "") === "1";
    const companyId = getCompanyId(req);

    const scope = await getAdminLeadScope(req, companyId);
    const lead = await Lead.findOne(mergeLeadScope({ _id: id, company: companyId }, scope));
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    // Resolve entitlements → decide whether transcripts are available.
    let includeTranscripts = false;
    try {
      const { getCompanyEntitlements } = require("../services/entitlementService");
      const ent = await getCompanyEntitlements(companyId);
      includeTranscripts = !!(ent && (ent.callTranscription || ent.aiSummary));
    } catch (e) {
      console.warn("[actionSummary] entitlement check failed:", e.message);
    }

    // On Pro/Advance, attach the lead's call transcripts/summaries.
    if (includeTranscripts) {
      try {
        const MobileCallLog = require("../models/MobileCallLog");
        const logs = await MobileCallLog.find({
          company: companyId,
          matchedLead: lead._id,
        }).select("recordings").lean();

        const recs = [];
        for (const log of logs) {
          for (const r of (log.recordings || [])) {
            if (r.transcript || r.summary) {
              recs.push({ transcript: r.transcript || "", summary: r.summary || null });
            }
          }
        }
        lead._callRecordings = recs;
      } catch (e) {
        console.warn("[actionSummary] transcript fetch failed:", e.message);
        lead._callRecordings = [];
      }
    }

    const {
      generateLeadActionSummary,
      computeSummarySignature,
    } = require("../utils/leadActionSummary");

    const signature = computeSummarySignature(lead, includeTranscripts);

    // Return cache when fresh and not force-refreshing.
    if (
      !forceRefresh &&
      lead.actionSummarySignature &&
      lead.actionSummarySignature === signature &&
      lead.actionSummary &&
      lead.actionSummary.generatedAt
    ) {
      return res.status(200).json({
        ...lead.actionSummary.toObject?.() ?? lead.actionSummary,
        cached: true,
      });
    }

    // Generate fresh.
    let result;
    try {
      result = await generateLeadActionSummary(lead, { includeTranscripts });
    } catch (e) {
      // FIX: this used to collapse every non-"not configured" error into one
      // generic "busy, try again" message — an expired API key, a
      // decommissioned model, and an actual rate limit all looked identical.
      // callGrok() (utils/leadActionSummary.js) now classifies these
      // properly; pass that through instead of flattening it back down.
      console.error("[actionSummary] generation error:", e.code || "UNKNOWN", e.message);
      if (e.code === "GROK_NOT_CONFIGURED") {
        return res.status(503).json({
          message: "AI summary is not configured. Set GROQ_API_KEY on the server.",
          code: "GROK_NOT_CONFIGURED",
        });
      }
      if (e.code === "GROK_AUTH_FAILED") {
        return res.status(502).json({ message: e.message, code: "GROK_AUTH_FAILED" });
      }
      if (e.code === "GROK_BAD_REQUEST") {
        return res.status(502).json({ message: e.message, code: "GROK_BAD_REQUEST" });
      }
      if (e.code === "GROK_RATE_LIMITED") {
        return res.status(429).json({ message: e.message, code: "GROK_RATE_LIMITED" });
      }
      if (e.code === "GROK_NETWORK_ERROR") {
        return res.status(502).json({ message: e.message, code: "GROK_NETWORK_ERROR" });
      }
      if (e.code === "GROK_PAYLOAD_TOO_LARGE") {
        return res.status(413).json({ message: e.message, code: "GROK_PAYLOAD_TOO_LARGE" });
      }
      return res.status(502).json({
        message: "AI summary service is unavailable right now. Please try again shortly.",
        code: "GROK_UNAVAILABLE",
      });
    }

    const generatedAt = new Date();
    const payload = { ...result, generatedAt };

    // Persist cache (best-effort — never fail the response on a write error).
    Lead.findByIdAndUpdate(id, {
      $set: { actionSummary: payload, actionSummarySignature: signature },
    }).catch((e) => console.error("[actionSummary] cache write failed:", e.message));

    return res.status(200).json({ ...payload, cached: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getLead,
  getLeads,
  getLeadsByCampaign,
  getDistinctCampaigns,
  createLead,
  adminCreateLead,
  adminCreateLeadsBulk,
  adminImportCSV,
  userImportCSV,
  updateLead,
  patchLead,
  patchLeadTemperature,
  markNotInterested,
  markColdReassign,
  markInvalid,
  deleteLead,
  adminUpdateLead,
  adminDeleteLead,
  closeLeadWrongEntry,
  closeLeadByUser,
  getMyLeads,
  updateLeadEmail,
  bulkUpdateEmails,
  adminGetAllLeads,
  checkDuplicate,
  logPhoneReveal,
  logEmailReveal,
  getFollowUpAlerts,
  getPendingNotifications,
  addSecondaryPhone,
  removeSecondaryPhone,
  swapPhones,
  mergeLead,
  getLeadActionSummary,
};
