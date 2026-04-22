// controllers/leadController.js
const Lead = require("../models/Leads");
const User = require("../models/Users");
const { notifyTelegram } = require("../utils/telegramNotifier");

// ── Helper: pick next user (round-robin, excluding previousAgents) ─────────────────
async function getNextUser(companyId, excludeIds = []) {
  const users = await User.find({ company: companyId }).select("_id").lean();
  if (!users.length) return null;
  const pool = users.filter(u => !excludeIds.some(e => e.toString() === u._id.toString()));
  const candidates = pool.length > 0 ? pool : users;
  const counts = await Promise.all(
    candidates.map(u =>
      Lead.countDocuments({ company: companyId, user: u._id, status: { $nin: ["Not Interested", "Converted"] } })
        .then(c => ({ userId: u._id, count: c }))
    )
  );
  counts.sort((a, b) => a.count - b.count);
  return counts[0].userId;
}

// ── Helper: build scheduled calls (+3d follow-up, +7d & +30d verification) ────
function buildScheduledCalls() {
  const now = Date.now();
  return [
    { type: "follow-up",    scheduledAt: new Date(now + 3  * 24 * 60 * 60 * 1000), done: false, note: "Auto follow-up after Not Interested" },
    { type: "verification", scheduledAt: new Date(now + 7  * 24 * 60 * 60 * 1000), done: false, note: "7-day verification call" },
    { type: "verification", scheduledAt: new Date(now + 30 * 24 * 60 * 60 * 1000), done: false, note: "1-month verification call" },
  ];
}

// ── GET all leads (user sees own + unassigned) ────────────────────────────────
const getLeads = async (req, res) => {
  try {
    const leads = await Lead.find({
      company: req.user.company,
      $or: [{ user: req.user._id }, { user: null }],
    }).populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    res.status(200).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLeadsByCampaign = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { campaign } = req.query;
    if (!campaign) return res.status(400).json({ message: "campaign query param is required" });
    const leads = await Lead.find({ company: companyId, campaign }).populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User creates a lead manually ──────────────────────────────────────────────
const createLead = async (req, res) => {
  try {
    const lead = await Lead.create({
      ...req.body,
      user: req.body.user || req.user._id,
      company: req.user.company,
    });

   notifyTelegram(lead, "Manual").catch(e => console.error("Telegram error:", e.message));

    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin creates a single lead ───────────────────────────────────────────────
const adminCreateLead = async (req, res) => {
  try {
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;
    if (!companyId) return res.status(400).json({ message: "companyId is required." });
    let assignedUser = req.body.user || null;
    if (!assignedUser) {
      assignedUser = await getNextUser(companyId);
      if (!assignedUser) return res.status(400).json({ message: "No users found in this company to assign the lead." });
    }
    const lead = await Lead.create({
      name: req.body.name, mobile: req.body.mobile,
      source: req.body.source || "Web Form",
      campaign: req.body.campaign || null,
      status: req.body.status || "New",
      date: req.body.date || new Date(),
      remark: req.body.remark || "Manually added",
      user: assignedUser, company: companyId,
    });
    const populated = await Lead.findById(lead._id).populate("user", "name email");

    // ── Notify admin on WhatsApp ──────────────────────────────────────────────
   notifyTelegram(lead, req.body.source || "Manual").catch(e => console.error("Telegram error:", e.message));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin bulk create leads ───────────────────────────────────────────────────
const adminCreateLeadsBulk = async (req, res) => {
  try {
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;
    if (!companyId) return res.status(400).json({ message: "companyId is required." });
    const items = req.body.leads;
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: "leads array is required and must not be empty." });
    if (items.length > 50)
      return res.status(400).json({ message: "Maximum 50 leads per bulk request." });
    const fallbackUser = await User.findOne({ company: companyId }).select("_id").lean();
    const results = [], errors = [];
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const assignedUser = row.user || (fallbackUser ? fallbackUser._id : null);
        if (!assignedUser) { errors.push({ index: i, message: "No user found." }); continue; }
        const lead = await Lead.create({
          name: row.name, mobile: row.mobile,
          source: row.source || "Web Form",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date || new Date(),
          remark: row.remark || "Manually added",
          user: assignedUser, company: companyId,
        });

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(lead, row.source || "Bulk Import").catch(e => console.error("Telegram error:", e.message));

        results.push(await Lead.findById(lead._id).populate("user", "name email"));
      } catch (err) {
        errors.push({ index: i, message: err.message });
      }
    }
    res.status(207).json({ saved: results, errors, total: items.length, savedCount: results.length, errorCount: errors.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin import CSV ──────────────────────────────────────────────────────────
const adminImportCSV = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "companyId is required." });
    const rows = req.body.leads;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No leads provided in CSV." });
    const users = await User.find({ company: companyId }).select("_id").lean();
    if (!users.length) return res.status(400).json({ message: "No users found in this company." });
    const results = [], errors = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const assignedUser = users[i % users.length]._id;
        const mobile = row.mobile || row.phone || "";
        const adminDoc = {
          name: row.name || "Unknown", mobile, email: row.email || "",
          source: row.source || "CSV Import", campaign: row.campaign || null,
          status: row.status || "New", date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || "Imported via CSV", user: assignedUser, company: companyId,
        };
        if (row.leadgenId) adminDoc.leadgenId = row.leadgenId;
        const inserted = await Lead.collection.insertOne(adminDoc);
        const savedLead = await Lead.findById(inserted.insertedId).populate("user", "name email");

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(adminDoc, row.source || "CSV Import").catch(e => console.error("Telegram error:", e.message));
        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    res.status(207).json({ saved: results, errors, total: rows.length, savedCount: results.length, errorCount: errors.length, message: `${results.length} leads imported with round-robin assignment.` });
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
    const results = [], errors = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const mobile = row.mobile || row.phone || "";
        const userDoc = {
          name: row.name || "Unknown", mobile, email: row.email || "",
          source: row.source || "CSV Import", campaign: row.campaign || null,
          status: row.status || "New", date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || "Imported via CSV", user: req.user._id, company: req.user.company,
        };
        const lead = await Lead.collection.insertOne(userDoc);
        const savedLead = await Lead.findById(lead.insertedId).populate("user", "name email");

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(userDoc, row.source || "CSV Import").catch(e => console.error("Telegram error:", e.message));

        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    res.status(207).json({ saved: results, errors, total: rows.length, savedCount: results.length, errorCount: errors.length, message: `${results.length} leads imported and assigned to you.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    await Lead.findByIdAndDelete(id);
    return res.status(200).json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    const updatedLead = await Lead.findByIdAndUpdate(id, req.body, { new: true });
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin ? (req.admin.company._id || req.admin.company) : req.body.companyId;
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    const { company, user, leadgenId, ...safeBody } = req.body;
    const updatedLead = await Lead.findByIdAndUpdate(id, safeBody, { new: true }).populate("user", "name email");
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminDeleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin ? (req.admin.company._id || req.admin.company) : null;
    const query = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(query);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    await Lead.findByIdAndDelete(id);
    return res.status(200).json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMyLeads = async (req, res) => {
  try {
    const leads = await Lead.find({ company: req.user.company, user: req.user._id })
      .sort({ createdAt: -1 })
      .populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const patchLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    const { status, remark, followUpDate } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    if (remark !== undefined) update.remark = remark;

    if (status !== undefined && status !== "Not Interested") {
      let scheduledAt;
      if (followUpDate) {
        const provided = new Date(followUpDate);
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (provided < todayStart) {
          return res.status(400).json({ message: "Follow-up date cannot be in the past." });
        }
        scheduledAt = provided;
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        scheduledAt = tomorrow;
      }

      const followUpEntry = {
        type:        "follow-up",
        scheduledAt,
        done:        false,
        doneAt:      null,
        note:        `Follow-up after status set to "${status}"`,
      };
      update.$push = { scheduledCalls: followUpEntry };
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, update, { new: true });
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
      voiceBotSummary, voiceBotScore, voiceBotReason,
      voiceBotNextAction, voiceBotService, voiceBotCallSid,
      voiceBotDuration, voiceBotTranscript, lastCalledByBot,
    } = req.body;

    if (!["Hot", "Warm", "Cold"].includes(temperature))
      return res.status(400).json({ message: "temperature must be Hot, Warm, or Cold" });

    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not found in token." });
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const update = { temperature };
    if (voiceBotSummary    !== undefined) update.voiceBotSummary    = voiceBotSummary;
    if (voiceBotScore      !== undefined) update.voiceBotScore      = voiceBotScore;
    if (voiceBotReason     !== undefined) update.voiceBotReason     = voiceBotReason;
    if (voiceBotNextAction !== undefined) update.voiceBotNextAction = voiceBotNextAction;
    if (voiceBotService    !== undefined) update.voiceBotService    = voiceBotService;
    if (voiceBotCallSid    !== undefined) update.voiceBotCallSid    = voiceBotCallSid;
    if (voiceBotDuration   !== undefined) update.voiceBotDuration   = voiceBotDuration;
    if (voiceBotTranscript !== undefined) update.voiceBotTranscript = voiceBotTranscript;
    if (lastCalledByBot    !== undefined) update.lastCalledByBot    = lastCalledByBot;

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

    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const historyEntry = {
      userId:   req.user._id,
      userName: req.user.name || "",
      remark:   remark.trim(),
      outcome:  "Not Interested",
      calledAt: new Date(),
    };

    const newScheduledCalls = buildScheduledCalls();
    const currentReassignCount = lead.reassignCount || 0;
    const isSecondNI = currentReassignCount >= 1;

    let nextUserId = null;
    let newStatus  = "Not Interested";

    if (!isSecondNI) {
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      nextUserId = await getNextUser(req.user.company, excludeIds);
    } else {
      newStatus = "New";
    }

    const updatePayload = {
      status:        newStatus,
      remark:        remark.trim(),
      reassignCount: currentReassignCount + 1,
      $push: {
        callHistory:    historyEntry,
        scheduledCalls: { $each: newScheduledCalls },
        previousAgents: req.user._id,
      },
    };

    if (!isSecondNI && nextUserId) {
      updatePayload.user = nextUserId;
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, { new: true })
      .populate("user", "name email");

    const message = isSecondNI
      ? "Lead marked Not Interested again. 3 follow-up calls scheduled. Status reset to New."
      : nextUserId
        ? `Lead reassigned to ${updatedLead.user?.name || "another agent"} with 3 scheduled calls.`
        : "No other agent available; lead kept with you. 3 follow-up calls scheduled.";

    return res.status(200).json({
      lead:           updatedLead,
      reassignedTo:   isSecondNI ? null : updatedLead.user,
      scheduledCalls: newScheduledCalls,
      isSecondNI,
      message,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── PATCH /api/lead/admin/update-email/:id ────────────────────────────────────
// Admin updates email of a single lead
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

// ── PATCH /api/lead/admin/bulk-update-emails ──────────────────────────────────
// Body: { updates: [{ mobile, email }, ...] }
// Matches leads by mobile number within company and sets their email
const bulkUpdateEmails = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ message: "updates array is required" });

    let matched = 0, notFound = 0;
    const notFoundList = [];

    for (const row of updates) {
      const mobile = (row.mobile || "").replace(/\D/g, "");
      const email  = (row.email  || "").trim().toLowerCase();
      if (!mobile || !email) continue;

      const result = await Lead.updateMany(
        { company: companyId, mobile },
        { $set: { email } }
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

// ── GET all leads for admin ───────────────────────────────────────────────────
const adminGetAllLeads = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not found in token." });
    const leads = await Lead.find({ company: companyId })
      .sort({ createdAt: -1 })
      .populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getLead, getLeads, getLeadsByCampaign,
  createLead, adminCreateLead, adminCreateLeadsBulk,
  adminImportCSV, userImportCSV,
  updateLead, patchLead, patchLeadTemperature,
  markNotInterested,
  deleteLead, adminUpdateLead, adminDeleteLead,
  getMyLeads,
  updateLeadEmail, bulkUpdateEmails,
  adminGetAllLeads,
};