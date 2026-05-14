// controllers/leadController.js
const Lead = require("../models/Leads");
const User = require("../models/Users");
const { computeQuality } = require("../utils/qualityHelper");
// const { notifyTelegram } = require("../utils/telegramNotifier");

// At the top of leadController.js
let notifyTelegram = async () => {}; // safe no-op default
try {
  notifyTelegram = require("../utils/telegramNotifier").notifyTelegram;
} catch (e) {
  console.warn("telegramNotifier not available:", e.message);
}

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
    if (!campaign)
      return res
        .status(400)
        .json({ message: "campaign query param is required" });
    const leads = await Lead.find({ company: companyId, campaign }).populate(
      "user",
      "name email",
    );
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

    notifyTelegram(lead, "Manual").catch((e) =>
      console.error("Telegram error:", e.message),
    );

    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin creates a single lead ───────────────────────────────────────────────
const adminCreateLead = async (req, res) => {
  try {
    const companyId = req.admin
      ? req.admin.company._id || req.admin.company
      : req.body.companyId;
    if (!companyId)
      return res.status(400).json({ message: "companyId is required." });
    let assignedUser = req.body.user || null;
    if (!assignedUser) {
      assignedUser = await getNextUser(companyId);
      if (!assignedUser)
        return res
          .status(400)
          .json({
            message: "No users found in this company to assign the lead.",
          });
    }
    const lead = await Lead.create({
      name: req.body.name,
      mobile: req.body.mobile,
      source: req.body.source || "Web Form",
      campaign: req.body.campaign || null,
      status: req.body.status || "New",
      date: req.body.date || new Date(),
      remark: req.body.remark || "Manually added",
      temperature: req.body.temperature || computeQuality({
        name:  req.body.name   || "",
        mobile: req.body.mobile || "",
        email:  req.body.email  || "",
        _extraAnswers: [],
      }, 0),
      user: assignedUser,
      company: companyId,
    });
    const populated = await Lead.findById(lead._id).populate(
      "user",
      "name email",
    );

    // ── Notify admin on WhatsApp ──────────────────────────────────────────────
    notifyTelegram(lead, req.body.source || "Manual").catch((e) =>
      console.error("Telegram error:", e.message),
    );

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin bulk create leads ───────────────────────────────────────────────────
const adminCreateLeadsBulk = async (req, res) => {
  try {
    const companyId = req.admin
      ? req.admin.company._id || req.admin.company
      : req.body.companyId;
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
        const assignedUser =
          row.user || (fallbackUser ? fallbackUser._id : null);
        if (!assignedUser) {
          errors.push({ index: i, message: "No user found." });
          continue;
        }
        const lead = await Lead.create({
          name: row.name,
          mobile: row.mobile,
          source: row.source || "Web Form",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date || new Date(),
          remark: row.remark || "Manually added",
          user: assignedUser,
          company: companyId,
        });

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(lead, row.source || "Bulk Import").catch((e) =>
          console.error("Telegram error:", e.message),
        );

        results.push(
          await Lead.findById(lead._id).populate("user", "name email"),
        );
      } catch (err) {
        errors.push({ index: i, message: err.message });
      }
    }
    res
      .status(207)
      .json({
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
        const mobile = row.mobile || row.phone || "";
        const csvExtraAnswers = Object.keys(row)
          .filter(k => !["name","mobile","phone","email","source","campaign","status","date","remark","leadgenId","user"].includes(k))
          .map(k => row[k]);
        const adminDoc = {
          name: row.name || "Unknown",
          mobile,
          email: row.email || "",
          source: row.source || "CSV Import",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || "Imported via CSV",
          temperature: row.temperature || computeQuality(
            { name: row.name || "", mobile, email: row.email || "", _extraAnswers: csvExtraAnswers },
            csvExtraAnswers.length
          ),
          user: assignedUser,
          company: companyId,
        };
        if (row.leadgenId) adminDoc.leadgenId = row.leadgenId;
        const inserted = await Lead.collection.insertOne(adminDoc);
        const savedLead = await Lead.findById(inserted.insertedId).populate(
          "user",
          "name email",
        );

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(adminDoc, row.source || "CSV Import").catch((e) =>
          console.error("Telegram error:", e.message),
        );
        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    res
      .status(207)
      .json({
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
    const results = [],
      errors = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const mobile = row.mobile || row.phone || "";
        const csvExtraAnswers = Object.keys(row)
          .filter(k => !["name","mobile","phone","email","source","campaign","status","date","remark","leadgenId","user"].includes(k))
          .map(k => row[k]);
        const userDoc = {
          name: row.name || "Unknown",
          mobile,
          email: row.email || "",
          source: row.source || "CSV Import",
          campaign: row.campaign || null,
          status: row.status || "New",
          date: row.date ? new Date(row.date) : new Date(),
          remark: row.remark || "Imported via CSV",
          temperature: row.temperature || computeQuality(
            { name: row.name || "", mobile, email: row.email || "", _extraAnswers: csvExtraAnswers },
            csvExtraAnswers.length
          ),
          user: req.user._id,
          company: req.user.company,
        };
        const lead = await Lead.collection.insertOne(userDoc);
        const savedLead = await Lead.findById(lead.insertedId).populate(
          "user",
          "name email",
        );

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(userDoc, row.source || "CSV Import").catch((e) =>
          console.error("Telegram error:", e.message),
        );

        results.push(savedLead);
      } catch (err) {
        errors.push({ index: i, row: row.name || i, message: err.message });
      }
    }
    res
      .status(207)
      .json({
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
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    await Lead.findByIdAndDelete(id);
    return res
      .status(200)
      .json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ✅ FIX: strip protected fields before spreading req.body — prevents a user
//         from reassigning a lead to themselves or changing the company by
//         sending { user: "...", company: "..." } in the request body.
//         adminUpdateLead already did this; now the user endpoint does too.
const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    // Strip fields that must not be changed via the user endpoint
    const { company, user, normalizedPhone, leadgenId, previousAgents, reassignCount, ...safeBody } = req.body;

    const updatedLead = await Lead.findByIdAndUpdate(id, safeBody, {
      new: true,
    });
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin
      ? req.admin.company._id || req.admin.company
      : req.body.companyId;
    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    const { company, user, leadgenId, ...safeBody } = req.body;
    const updatedLead = await Lead.findByIdAndUpdate(id, safeBody, {
      new: true,
    }).populate("user", "name email");
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

// ── GET /api/lead/my-leads ────────────────────────────────────────────────────
// ✅ FIX: now returns paginated shape { leads, total, page, pages } instead of
//         a plain array. Mobile leadsApi.js and UserLeadsPage.jsx both expect
//         this shape; the plain-array response caused mobile to silently get 0
//         leads (firstPage.data.leads was undefined → formatLead crash).
//
//         Frontend UserLeadsPage already handles both shapes via:
//           res.data?.leads || (Array.isArray(res.data) ? res.data : [])
//         so it continues to work. Mobile leadsApi no longer needs the fallback.
//
//         Default limit=200 so a single call fetches all leads for most users
//         without needing multi-page parallel fetches. Callers may pass
//         ?page=N&limit=N to paginate explicitly.
const getMyLeads = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "200", 10)));
    const skip  = (page - 1) * limit;

    const query = { company: req.user.company, user: req.user._id };

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email"),
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
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const { status, remark, outcome, followUpDate, temperature, Quality } = req.body;
    const update = {};

    if (status !== undefined) update.status = status;
    if (remark !== undefined) update.remark = remark;

    // Accept temperature from both 'temperature' and 'Quality' field names
    const temp = temperature || Quality;
    if (temp && ["Hot", "Warm", "Cold"].includes(temp)) update.temperature = temp;

    // Build $push and $set ops separately to avoid MongoDB conflict
    const pushOps = {};
    const setOps  = {};

    // ── Push call to callHistory ──────────────────────────────────────────────
    if (remark && remark.trim()) {
      pushOps.callHistory = {
        userId:   req.user._id,
        userName: req.user.name || "",
        remark:   remark.trim(),
        outcome:  outcome || "Call Back",
        calledAt: new Date(),
      };
    }

    // ── Mark the nearest pending follow-up as done (FIX: progress was stuck) ─
    // Find first pending (not done) scheduled call by earliest scheduledAt
    const pendingCalls = lead.scheduledCalls
      .map((sc, idx) => ({ sc, idx }))
      .filter(({ sc }) => !sc.done)
      .sort((a, b) => new Date(a.sc.scheduledAt) - new Date(b.sc.scheduledAt));

    if (pendingCalls.length > 0) {
      const { idx } = pendingCalls[0];
      setOps[`scheduledCalls.${idx}.done`]   = true;
      setOps[`scheduledCalls.${idx}.doneAt`] = new Date();
    }

    // ── Schedule next follow-up only if explicitly requested ─────────────────
    // Only schedule a new follow-up when agent provides a followUpDate
    // OR when outcome is "Call Back" (agent explicitly wants a callback)
    if (status !== undefined && status !== "Not Interested") {
      const shouldSchedule = !!(followUpDate || outcome === "Call Back");

      if (shouldSchedule) {
        let scheduledAt;
        if (followUpDate) {
          const provided   = new Date(followUpDate);
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          if (provided < todayStart) {
            return res.status(400).json({ message: "Follow-up date cannot be in the past." });
          }
          scheduledAt = provided;
        } else {
          // Default: tomorrow 9am
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 0, 0, 0);
          scheduledAt = tomorrow;
        }

        pushOps.scheduledCalls = {
          type:        "follow-up",
          scheduledAt,
          done:        false,
          doneAt:      null,
          note:        `Follow-up after status "${status}" — outcome: ${outcome || "Call Back"}`,
        };
      }
    }

    // ── Assemble final update ─────────────────────────────────────────────────
    if (Object.keys(pushOps).length > 0) update.$push = pushOps;
    if (Object.keys(setOps).length  > 0) update.$set  = { ...(update.$set || {}), ...setOps };

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

    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    const historyEntry = {
      userId: req.user._id,
      userName: req.user.name || "",
      remark: remark.trim(),
      outcome: "Not Interested",
      calledAt: new Date(),
    };

    const newScheduledCalls = buildScheduledCalls();
    const currentReassignCount = lead.reassignCount || 0;
    const isSecondNI = currentReassignCount >= 1;

    let nextUserId = null;
    let newStatus = "Not Interested";

    if (!isSecondNI) {
      const excludeIds = [...(lead.previousAgents || []), req.user._id];
      nextUserId = await getNextUser(req.user.company, excludeIds);
    } else {
      newStatus = "New";
    }

    const updatePayload = {
      $set: {
        status: newStatus,
        remark: remark.trim(),
        reassignCount: currentReassignCount + 1,
      },
      $push: {
        callHistory: historyEntry,
        scheduledCalls: { $each: newScheduledCalls },
        previousAgents: req.user._id,
      },
    };

    // ✅ Now add user inside $set instead of top-level
    if (!isSecondNI && nextUserId) {
      updatePayload.$set.user = nextUserId;
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    }).populate("user", "name email");

    const message = isSecondNI
      ? "Lead marked Not Interested again. 3 follow-up calls scheduled. Status reset to New."
      : nextUserId
        ? `Lead reassigned to ${updatedLead.user?.name || "another agent"} with 3 scheduled calls.`
        : "No other agent available; lead kept with you. 3 follow-up calls scheduled.";

    return res.status(200).json({
      lead: updatedLead,
      reassignedTo: isSecondNI ? null : updatedLead.user,
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

// ── GET all leads for admin ───────────────────────────────────────────────────
const adminGetAllLeads = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId)
      return res.status(400).json({ message: "Company not found in token." });
    const leads = await Lead.find({ company: companyId })
      .sort({ createdAt: -1 })
      .populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const checkDuplicate = async (req, res) => {
  try {
    const { mobile } = req.query;
    if (!mobile) return res.status(400).json({ message: "mobile query param is required" });

    const companyId = req.user?.company || req.admin?.company?._id || req.admin?.company;

    // Normalize: last 10 digits
    const normalized = mobile.replace(/\D/g, "").slice(-10);

    const existing = await Lead.findOne({
      company: companyId,
      normalizedPhone: normalized,
    }).select("name mobile status user").populate("user", "name");

    if (existing) {
      return res.status(200).json({ duplicate: true, lead: existing });
    }
    return res.status(200).json({ duplicate: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── POST /api/lead/:id/reveal-phone ──────────────────────────────────────────
// Called by frontend each time a user reveals a masked phone number.
// Increments persisted reveal count and logs who/when.
const logPhoneReveal = async (req, res) => {
  try {
    const { id } = req.params;

    // Works for both user token and admin token
    const actorId   = req.user?._id   || req.admin?._id;
    const actorName = req.user?.name  || req.admin?.name || "";
    const companyId = req.user?.company || req.admin?.company?._id || req.admin?.company;

    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found" });

    await Lead.findByIdAndUpdate(id, {
      $inc:  { phoneRevealCount: 1 },
      $push: {
        phoneRevealLog: {
          userId:     actorId,
          userName:   actorName,
          revealedAt: new Date(),
        },
      },
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// ── Follow-up alert counts for sidebar notification dots ─────────────────────
// GET /api/lead/follow-up-alerts        (user token)
// GET /api/lead/admin/follow-up-alerts  (admin token)
const getFollowUpAlerts = async (req, res) => {
  try {
    const company =
      req.user?.company ||
      req.admin?.company?._id ||
      req.admin?.company;
    if (!company) return res.status(400).json({ message: "Company not found." });

    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);

    const baseQuery = { company };
    if (req.user && req.user.role !== "admin" && req.user.role !== "superadmin") {
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

    // Count UNIQUE LEADS — not individual scheduledCall entries.
    // A lead with multiple stale pending entries still counts as 1.
    // A lead is "overdue" if its earliest pending call is past today.
    // A lead is "today" if its earliest pending call is today (and not overdue).
    let todayLeadCount   = 0;
    let overdueLeadCount = 0;

    for (const lead of leads) {
      // Find the earliest pending scheduled call for this lead
      const pendingCalls = lead.scheduledCalls
        .filter(sc => !sc.done)
        .map(sc => new Date(sc.scheduledAt))
        .sort((a, b) => a - b);

      if (pendingCalls.length === 0) continue;

      const earliest = pendingCalls[0];
      if (earliest < todayStart) {
        // Overdue: earliest pending call is before today
        overdueLeadCount++;
      } else if (earliest <= todayEnd) {
        // Due today
        todayLeadCount++;
      }
    }

    return res.status(200).json({
      todayCount:      todayLeadCount,
      overdueCount:    overdueLeadCount,
      total:           todayLeadCount + overdueLeadCount,
      todayLeadCount,
      overdueLeadCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getLead,
  getLeads,
  getLeadsByCampaign,
  createLead,
  adminCreateLead,
  adminCreateLeadsBulk,
  adminImportCSV,
  userImportCSV,
  updateLead,
  patchLead,
  patchLeadTemperature,
  markNotInterested,
  deleteLead,
  adminUpdateLead,
  adminDeleteLead,
  getMyLeads,
  updateLeadEmail,
  bulkUpdateEmails,
  adminGetAllLeads,
  checkDuplicate,
  logPhoneReveal,
  getFollowUpAlerts,
};
