// controllers/leadController.js — Merge Number feature removed; Single Additional Phone Number system
const Lead = require("../models/Leads");
const User = require("../models/Users");
const Company = require("../models/Company");
const { normalizePhone } = require("../utils/normalizePhone");
const { computeQuality } = require("../utils/qualityHelper");
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
const { notifyCampaignLead, notifyEmployeeLead } = require("../services/telegramService");

// ── Helper: pick next user (round-robin, excluding previousAgents) ─────────────────
async function getNextUser(companyId, excludeIds = []) {
  const users = await User.find({ company: companyId }).select("_id").lean();
  if (!users.length) return null;
  const pool = users.filter(
    (u) => !excludeIds.some((e) => e.toString() === u._id.toString()),
  );
  const candidates = pool.length > 0 ? pool : users;
  const counts = await Promise.all(
    candidates.map((u) =>
      Lead.countDocuments({
        company: companyId,
        user: u._id,
        status: { $nin: ["Not Interested", "Converted"] },
      }).then((c) => ({ userId: u._id, count: c })),
    ),
  );
  counts.sort((a, b) => a.count - b.count);
  return counts[0].userId;
}

// ── Helper: build scheduled calls (+3d follow-up, +7d & +30d verification) ────
function buildScheduledCalls() {
  const now = Date.now();
  return [
    {
      type: "follow-up",
      scheduledAt: new Date(now + 3 * 24 * 60 * 60 * 1000),
      done: false,
      note: "Auto follow-up after Not Interested",
    },
    {
      type: "verification",
      scheduledAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      done: false,
      note: "7-day verification call",
    },
    {
      type: "verification",
      scheduledAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      done: false,
      note: "1-month verification call",
    },
  ];
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
    const leads = await Lead.find({
      company: getCompanyId(req),
      $or: [{ user: req.user._id }, { user: null }],
      mergedInto: null,
    })
      .populate("user", "name email")
      .populate("previousAgents", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    res.status(200).json(lead);
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
      const leads = await Lead.find({ company: companyId, $or: or })
        .populate("user", "name email")
        .populate("previousAgents", "name email");
      return res.status(200).json(leads);
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

    const leads = await Lead.find(filter)
      .populate("user", "name email")
      .populate("previousAgents", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDistinctCampaigns = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const campaigns = await Lead.distinct("campaign", {
      company: companyId,
      campaign: { $nin: [null, ""] },
    });
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
    if (normSecondary) {
      if (normSecondary === normPrimary) {
        return res.status(400).json({ message: "Secondary phone cannot be the same as primary." });
      }
      const conflict = await findLeadByPhone(companyId, normSecondary);
      if (conflict) {
        return res.status(409).json({
          message: `Secondary number already belongs to lead "${conflict.name}"`,
          duplicate: true, lead: conflict,
        });
      }
    }
    const conflict = await findLeadByPhone(companyId, normPrimary);
    if (conflict) {
      return res.status(409).json({
        message: `Primary number already belongs to lead "${conflict.name}"`,
        duplicate: true, lead: conflict,
      });
    }

    const lead = await Lead.create({
      ...req.body,
      mobile:        primaryMobile,
      primaryPhone:  primaryMobile,
      secondaryPhone: normSecondary ? secondaryMobile : null,
      user:    req.body.user || req.user._id,
      company: companyId,
    });

    autoSendTemplates(lead, companyId);
    res.status(201).json(lead);
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
    let assignedUser = req.body.user || null;
    if (!assignedUser) {
      assignedUser = await getNextUser(companyId);
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
      source: req.body.source || "Web Form",
      campaign: req.body.campaign || null,
      status: req.body.status || "New",
      date: req.body.date || new Date(),
      remark: req.body.remark || "Manually added",
      temperature:
        req.body.temperature ||
        computeQuality(
          {
            name: req.body.name || "",
            mobile: primaryMobile,
            email: req.body.email || "",
            _extraAnswers: [],
          },
          0,
        ),
      user: assignedUser,
      company: companyId,
      assignedAdmin: req.admin?._id || req.superAdmin?._id || null,
    });

    const populated = await Lead.findById(lead._id)
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    const io = global._io;
    if (io) {
      io.to("wa_admin").emit("wa_new_lead", {
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
    const results = [],
      errors = [];
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
     try {
        const assignedUser = row.user || (fallbackUser ? fallbackUser._id : null);
        if (!assignedUser) {
          errors.push({ index: i, message: "No user found." });
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
          source:        row.source   || "Web Form",
          campaign:      row.campaign || null,
          status:        row.status   || "New",
          date:          row.date     || new Date(),
          remark:        row.remark   || "Manually added",
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
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    const rows = req.body.leads;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No leads provided in CSV." });
    const users = await User.find({ company: companyId }).select("_id").lean();
    if (!users.length)
      return res
        .status(400)
        .json({ message: "No users found in this company." });
    const results = [],
      errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const assignedUser = users[i % users.length]._id;
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
          source: row.source || "Excel Import",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || row.notes || "Imported via Excel",
          temperature:
            row.temperature ||
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
          assignedAdmin: req.admin?._id || null,
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
      message: `${results.length} leads imported with round-robin assignment.`,
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
    const results = [],
      errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
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
          source: row.source || "Excel Import",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || row.notes || "Imported via Excel",
          temperature:
            row.temperature ||
            computeQuality(
              {
                name: row.name || "",
                mobile,
                email: row.email || "",
                _extraAnswers: csvExtraAnswers,
              },
              csvExtraAnswers.length,
            ),
          user: req.user._id,
          company: companyId,
        };

        const lead = await Lead.collection.insertOne(userDoc);
        const savedLead = await Lead.findById(lead.insertedId)
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
      message: `${results.length} leads imported and assigned to you.`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    await Lead.findByIdAndDelete(id);
    return res
      .status(200)
      .json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    // Strip fields that must never be changed via this endpoint
    const {
      company, user, normalizedPhone, normalizedSecondaryPhone,
      leadgenId, previousAgents, reassignCount, additionalNumbers,
      mergedFrom, ...safeBody
    } = req.body;

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
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const leadQuery = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(leadQuery);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const previousUserId = lead.user ? String(lead.user) : null;

    const {
      company, leadgenId, reassignReason,
      normalizedPhone, normalizedSecondaryPhone,
      additionalNumbers, mergedFrom,
      ...safeBody
    } = req.body;
    const incomingUser = req.body.user;

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

    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminDeleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin
      ? req.admin.company._id || req.admin.company
      : null;
    const query = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(query);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    await Lead.findByIdAndDelete(id);
    return res
      .status(200)
      .json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMyLeads = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit || "200", 10)),
    );
    const skip = (page - 1) * limit;

    const query = { company: getCompanyId(req), user: req.user._id, mergedInto: null, isClosed: { $ne: true } };

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .populate("previousAgents", "name email")
        .populate("projects", "name color"),
      Lead.countDocuments(query),
    ]);

    res.status(200).json({
      leads,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const patchLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const { status, remark, outcome, followUpDate, temperature, Quality } =
      req.body;
    const update = {};

    if (status !== undefined) update.status = status;
    if (remark !== undefined) update.remark = remark;

    const temp = temperature || Quality;
    if (temp && ["Hot", "Warm", "Cold"].includes(temp))
      update.temperature = temp;

    const pushOps = {};
    const setOps = {};

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
    if (remark && remark.trim() && isGenuineCall) {
      const histEntry = {
        userId: req.user._id,
        userName: req.user.name || "",
        remark: remark.trim(),
        outcome: outcome || "Call Back",
        calledAt: new Date(),
      };
      if (req.body.calledNumber) histEntry.calledNumber = req.body.calledNumber;
      if (req.body.numberType) histEntry.numberType = req.body.numberType;
      pushOps.callHistory = histEntry;
    }

    const pendingCalls = lead.scheduledCalls
      .map((sc, idx) => ({ sc, idx }))
      .filter(({ sc }) => !sc.done)
      .sort((a, b) => new Date(a.sc.scheduledAt) - new Date(b.sc.scheduledAt));

    if (pendingCalls.length > 0) {
      const { idx } = pendingCalls[0];
      setOps[`scheduledCalls.${idx}.done`] = true;
      setOps[`scheduledCalls.${idx}.doneAt`] = new Date();
    }

    if (status !== undefined && status !== "Not Interested") {
      const shouldSchedule = !!(followUpDate || outcome === "Call Back");

      if (shouldSchedule) {
        let scheduledAt;
        if (followUpDate) {
          const provided = new Date(followUpDate);
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          if (provided < todayStart) {
            return res
              .status(400)
              .json({ message: "Follow-up date cannot be in the past." });
          }
          scheduledAt = provided;
        } else {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 0, 0, 0);
          scheduledAt = tomorrow;
        }

        pushOps.scheduledCalls = {
          type: "follow-up",
          scheduledAt,
          done: false,
          doneAt: null,
          note: `Follow-up after status "${status}" — outcome: ${outcome || "Call Back"}`,
        };
      }
    }

    if (Object.keys(pushOps).length > 0) update.$push = pushOps;
    if (Object.keys(setOps).length > 0)
      update.$set = { ...(update.$set || {}), ...setOps };

    const updatedLead = await Lead.findByIdAndUpdate(id, update, { new: true });

    // ── Auto-blast when lead is marked Interested ─────────────────────────────
    // Fires SMS, Email, and WhatsApp to the lead when the employee selects
    // "Interested" as the call outcome OR the lead status is set to "Interested".
    // Uses company's interestedBlast settings. Sends only ONCE per lead
    // (guarded by interestedBlastSentAt — claimed atomically below).
    const isInterestedNow =
      (typeof outcome === "string" && outcome.trim().toLowerCase() === "interested") ||
      (typeof status === "string" && status.trim().toLowerCase() === "interested");

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

    return res.status(200).json(updatedLead);
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

    if (!["Hot", "Warm", "Cold"].includes(temperature))
      return res
        .status(400)
        .json({ message: "temperature must be Hot, Warm, or Cold" });

    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId)
      return res.status(400).json({ message: "Company not found in token." });
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const update = { temperature };
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
    return res.status(200).json(updatedLead);
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

    const historyEntry = {
      userId: req.user._id,
      userName: req.user.name || "",
      remark: remark.trim(),
      outcome: "Not Interested",
      calledAt: new Date(),
    };

    const stage = lead.niStage || null;

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

    if (!stage) {
      // ── STAGE 1: first Not Interested ────────────────────────────────────
      // Reassign to another agent for VERIFICATION. Remember the original
      // employee so a second NI can be sent back to them. Schedule the 3 calls.
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      nextUserId = await getNextUser(req.user.company, excludeIds);

      const newScheduledCalls = buildScheduledCalls();
      scheduledForResponse = newScheduledCalls;

      updatePayload.$set.niOriginalAgent = req.user._id;
      updatePayload.$set.reassignCount   = (lead.reassignCount || 0) + 1;
      updatePayload.$push.scheduledCalls = { $each: newScheduledCalls };

      if (nextUserId) {
        updatePayload.$set.user    = nextUserId;
        updatePayload.$set.niStage = "verification";
        updatePayload.$set.status  = "Verification";
      } else {
        // No other agent available — keep with current employee, no verification.
        updatePayload.$set.niStage = null;
        updatePayload.$set.status  = "Not Interested";
      }

      outcome = nextUserId ? "sent_for_verification" : "no_verifier_available";
      message = nextUserId
        ? `Lead sent for verification to ${"another agent"} with 3 scheduled calls.`
        : "No other agent available; lead kept with you. 3 follow-up calls scheduled.";
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
      updatePayload.$set.status  = "Not Interested";

      outcome = "returned_to_original";
      message = backTo
        ? "Verification confirmed Not Interested. Lead returned to the original employee with remaining follow-ups."
        : "Verification confirmed Not Interested. Original employee unavailable; lead kept with you.";

      nextUserId = backTo;
    } else {
      // ── STAGE 3+: already returned once — avoid ping-pong ────────────────
      // Reset to New so it stays with the current owner; keep follow-ups intact.
      updatePayload.$set.status = "New";
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
      message = `Lead sent for verification to ${updatedLead.user?.name || "another agent"} with 3 scheduled calls.`;
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

    const historyEntry = {
      userId: req.user._id,
      userName: req.user.name || "",
      remark: remark.trim(),
      outcome: "Cold",
      calledAt: new Date(),
    };

    const buildColdScheduledCalls = () => ([
      {
        type: "follow-up",
        scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        done: false,
        note: "Auto follow-up after Cold reassignment",
      },
      {
        type: "verification",
        scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        done: false,
        note: "7-day verification call",
      },
      {
        type: "verification",
        scheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        done: false,
        note: "1-month verification call",
      },
    ]);

    const stage = lead.coldStage || null;

    const updatePayload = {
      $set: { temperature: "Cold", remark: remark.trim() },
      $push: {
        callHistory: historyEntry,
        previousAgents: req.user._id,
      },
    };

    let nextUserId  = null;
    let outcome     = "";
    let scheduledForResponse = [];

    if (!stage) {
      // ── STAGE 1: first Cold mark — send to another agent for VERIFICATION ──
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      nextUserId = await getNextUser(req.user.company, excludeIds);

      const newScheduledCalls = buildColdScheduledCalls();
      scheduledForResponse = newScheduledCalls;

      updatePayload.$set.coldOriginalAgent = req.user._id;
      updatePayload.$set.coldReassignCount = (lead.coldReassignCount || 0) + 1;
      updatePayload.$push.scheduledCalls   = { $each: newScheduledCalls };

      if (nextUserId) {
        updatePayload.$set.user      = nextUserId;
        updatePayload.$set.coldStage = "verification";
        updatePayload.$set.status    = "Verification";
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
      updatePayload.$set.status    = "New";

      outcome = "returned_to_original";
      nextUserId = backTo;
    } else {
      // ── STAGE 3+: already returned — keep with current owner, no reassign ─
      updatePayload.$set.status = "New";
      outcome = "kept_no_reassign";
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    })
      .populate("user", "name email")
      .populate("previousAgents", "name email")
      .populate("coldOriginalAgent", "name email");

    let message;
    if (outcome === "sent_for_verification") {
      message = `Cold lead sent for verification to ${updatedLead.user?.name || "another agent"} with 3 scheduled calls.`;
    } else if (outcome === "no_verifier_available") {
      message = "No other agent available; lead kept with you. 3 follow-up calls scheduled.";
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
      outcome:  reject ? "Invalid Rejected" : "Invalid",
      calledAt: new Date(),
    };

    // ── Verifier REJECTS invalid → return to original employee + notify admin ──
    if (stage === "verification" && reject) {
      const backTo = lead.invalidOriginalAgent || null;
      const updatePayload = {
        $set: {
          remark:       remark.trim(),
          invalidStage: null,
          status:       "New",
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
            status:       "Not Interested",
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
    const excludeIds = [...(lead.previousAgents || []), req.user._id];
    const nextUserId = await getNextUser(req.user.company, excludeIds);

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
      updatePayload.$set.status       = "Verification";
    } else {
      // No other agent available — close immediately with the single mark.
      updatePayload.$set.invalidStage = null;
      updatePayload.$set.isClosed     = true;
      updatePayload.$set.closeReason  = remark.trim() || "Invalid";
      updatePayload.$set.closedAt     = new Date();
      updatePayload.$set.closedBy     = req.user._id;
      updatePayload.$set.status       = "Not Interested";
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
    const lead = await Lead.findOne({ _id: id, company: companyId });
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
    const { phone, remark } = req.body;
    if (!phone || !phone.trim())
      return res.status(400).json({ message: "Phone number is required to close a lead." });
    if (!remark || !remark.trim())
      return res.status(400).json({ message: "Remark is required to close a lead." });

    const companyId = getCompanyId(req);
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
          status:         "Not Interested",
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
    const lead = await Lead.findOne({ _id: id, company: companyId });
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

    for (const row of updates) {
      const mobile = (row.mobile || "").replace(/\D/g, "");
      const email = (row.email || "").trim().toLowerCase();
      if (!mobile || !email) continue;

      const result = await Lead.updateMany(
        { company: companyId, mobile },
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
    const leads = await Lead.find({ company: companyId, mergedInto: null })
      .sort({ createdAt: -1 })
      .populate("user", "name email")
      .populate("previousAgents", "name email");
    res.status(200).json(leads);
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

    const lead = await Lead.findOne({ _id: id, company: companyId });
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

    const lead = await Lead.findOne({ _id: id, company: companyId });
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

    const leads = await Lead.find({
      ...baseQuery,
      scheduledCalls: {
        $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } },
      },
    })
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

    const now          = Date.now();
    const oneHourAgo   = new Date(now - 60  * 60 * 1000);
    const twoHoursAgo  = new Date(now - 120 * 60 * 1000);
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
      status:      { $nin: ["Not Interested", "Converted"] },
      callHistory: { $size: 0 },
    };

    const noAction2h = await Lead.find({ ...noActionBase, createdAt: { $lte: twoHoursAgo } })
      .select("_id name user").populate("user", "name").lean();
    const twoHourIds = new Set(noAction2h.map(l => String(l._id)));
    const noAction1h = (await Lead.find({ ...noActionBase, createdAt: { $lte: oneHourAgo } })
      .select("_id name user").populate("user", "name").lean())
      .filter(l => !twoHourIds.has(String(l._id))); // 1h list excludes those already 2h+

    // ── Follow-up leads (scheduled call not done, overdue or due today) ───────
    const fuLeads = await Lead.find({
      ...scope,
      scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } } },
    }).select("_id name scheduledCalls").lean();

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
        ? `"${noAction2h[0].name}" has had no activity for 2 hours.`
        : `${noAction2h.length} leads have had no activity for 2 hours.`,
      leads: mkLeads(noAction2h), threshold: "2h",
      timestamp: new Date().toISOString(), urgent: true,
    });
    if (noAction1h.length) notifications.push({
      id: "noa-1h", type: "no_action",
      title: `${noAction1h.length} Lead${noAction1h.length > 1 ? "s" : ""} — No Action`,
      body: noAction1h.length === 1
        ? `"${noAction1h[0].name}" has had no activity for 1 hour.`
        : `${noAction1h.length} leads have had no activity for 1 hour.`,
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
const addSecondaryPhone = async (req, res) => {
  try {
    const { id } = req.params;
    const { secondaryPhone } = req.body;
    if (!secondaryPhone || !String(secondaryPhone).trim()) {
      return res.status(400).json({ message: "secondaryPhone is required" });
    }
    const companyId = getCompanyId(req);
    const lead = await Lead.findOne({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    });
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
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /lead/:id/secondary-phone ──────────────────────────────────────────
// Remove the additional phone from a lead. Logs the action.
const removeSecondaryPhone = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const lead = await Lead.findOne({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    });
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
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /lead/:id/swap-phones ─────────────────────────────────────────────────
// Swap primary and secondary phone numbers. Maintains full audit history.
const swapPhones = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const lead = await Lead.findOne({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    });
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
    res.status(500).json({ message: err.message });
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
const mergeLead = async (req, res) => {
  try {
    const { id } = req.params;                       // SURVIVOR: the lead we keep (its number stays primary)
    const { secondaryPhone, sourceName, sourceMobile, sourceLeadId } = req.body;
    // secondaryPhone = the number to attach to the survivor (the absorbed lead's primary)
    // sourceLeadId   = the duplicate lead to fold in + hide (optional)

    if (!secondaryPhone || !String(secondaryPhone).trim()) {
      return res.status(400).json({ message: "secondaryPhone is required for merge." });
    }

    const companyId = getCompanyId(req);
    const actorId   = req.user?._id || req.admin?._id || req.superAdmin?._id || null;
    const actorRole = req.admin ? "admin" : (req.superAdmin ? "superadmin" : "user");

    // ── Load the SURVIVING lead (the one we keep) ────────────────────────────
    const survivor = await Lead.findOne({
      _id: id,
      ...(companyId ? { company: companyId } : {}),
    });
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
    res.status(500).json({ message: err.message });
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

    const lead = await Lead.findOne({ _id: id, company: companyId });
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
      if (e.code === "GROK_NOT_CONFIGURED") {
        return res.status(503).json({
          message: "AI summary is not configured. Set GROQ_API_KEY on the server.",
          code: "GROK_NOT_CONFIGURED",
        });
      }
      console.error("[actionSummary] generation error:", e.message);
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
