// controllers/leadController.js — FIXED (auto-template now uses direct in-process calls)
const Lead    = require("../models/Leads");
const User    = require("../models/Users");
const Company = require("../models/Company");
const { computeQuality } = require("../utils/qualityHelper");
const { sendNewLeadNotification, sendReassignedLeadNotification } = require('../services/fcmService');

// ── UPDATED: Resolve companyId from req — prefers req.companyId (companyIsolation middleware)
//    then falls back to existing req.admin / req.superAdmin / req.user patterns.
// FIX: added req.superAdmin check so PUT /lead/superadmin/:id (protectSuperAdmin)
//      no longer returns null → 404 "Lead Not Found".
const getCompanyId = (req) =>
  req.companyId ||
  (req.admin      ? (req.admin.company?._id      || req.admin.company)      : null) ||
  (req.superAdmin ? (req.superAdmin.company?._id || req.superAdmin.company) : null) ||
  req.user?.company ||
  null;

// Telegram notifier — optional, safe no-op if not present
let notifyTelegram = async () => {};
try {
  notifyTelegram = require("../utils/telegramNotifier").notifyTelegram;
} catch (e) {
  console.warn("telegramNotifier not available:", e.message);
}

// ── Auto-template service — direct in-process calls, no HTTP, no auth tokens ──
// FIX: The old code used axios to call internal HTTP endpoints with
// INTERNAL_ADMIN_TOKEN which was NOT a valid JWT → 401 silently dropped every
// WhatsApp / Email / SMS auto-send.  The new service bypasses HTTP entirely.
const { autoSendTemplates } = require("../services/autoTemplateService");
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
      company: getCompanyId(req),
      $or: [{ user: req.user._id }, { user: null }],
    }).populate("user", "name email").populate("previousAgents", "name email");
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
    const { campaign } = req.query;
    if (!campaign)
      return res
        .status(400)
        .json({ message: "campaign query param is required" });
    const leads = await Lead.find({ company: companyId, campaign })
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
      company:  companyId,
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
// FIX: now calls autoSendTemplates so user-created leads also get WA/Email/SMS
const createLead = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const lead = await Lead.create({
      ...req.body,
      user: req.body.user || req.user._id,
      company: companyId,
    });

    notifyTelegram(lead, "Manual").catch((e) =>
      console.error("Telegram error:", e.message),
    );

    // Auto-send WhatsApp / Email / SMS if toggles are on
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
        return res
          .status(400)
          .json({
            message: "No users found in this company to assign the lead.",
          });
    }
    const lead = await Lead.create({
      name:     req.body.name,
      mobile:   req.body.mobile,
      email:    req.body.email  || "",   // ← FIX: was being dropped, autoTemplate needs it
      source:   req.body.source   || "Web Form",
      campaign: req.body.campaign || null,
      status:   req.body.status   || "New",
      date:     req.body.date     || new Date(),
      remark:   req.body.remark   || "Manually added",
      temperature: req.body.temperature || computeQuality({
        name:   req.body.name   || "",
        mobile: req.body.mobile || "",
        email:  req.body.email  || "",
        _extraAnswers: [],
      }, 0),
      user:    assignedUser,
      company: companyId,
    });
    const populated = await Lead.findById(lead._id)
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    // ── Notify WhatsApp panel about new lead via socket ───────────────────────
    const io = global._io;
    if (io) {
      io.to("wa_admin").emit("wa_new_lead", {
        lead: {
          _id:        lead._id,
          name:       lead.name,
          mobile:     lead.mobile,
          cleanPhone: (lead.mobile || "").replace(/\D/g, ""),
          status:     lead.status,
          source:     lead.source,
          campaign:   lead.campaign,
          date:       lead.date,
          createdAt:  lead.createdAt,
          user:       populated?.user || null,
          existingConversationId:     null,
          existingConversationStatus: null,
        },
      });

      // ── NEW: emit to agent's personal socket room so LeadsScreen can refetch ──
      // The mobile app joins `agent:<userId>` on socket connect (see mobile patch).
      // This lets the app instantly refetch leads without waiting for FCM delivery.
      if (assignedUser) {
        io.to(`agent:${assignedUser}`).emit('new_lead_assigned', {
          leadId:    String(lead._id),
          leadName:  lead.name,
          source:    lead.source || 'Web Form',
          eventType: 'new',
        });
      }
    }

    // ── Notify admin on WhatsApp ──────────────────────────────────────────────
    notifyTelegram(lead, req.body.source || "Manual").catch((e) =>
      console.error("Telegram error:", e.message),
    );

    // ── Auto-send WhatsApp / Email / SMS template if enabled ─────────────────
    // FIX: pass `populated` not `lead` — populated has all fields including email
    autoSendTemplates(populated, companyId);

    // ── NEW: FCM push notification to the assigned agent's device ────────────
    // Fire-and-forget — never blocks the HTTP response.
    // sendNewLeadNotification is a no-op if FCM is not configured.
    if (assignedUser) {
      sendNewLeadNotification(assignedUser, lead).catch((e) =>
        console.error('[FCM] adminCreateLead push error:', e.message),
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
          await Lead.findById(lead._id).populate("user", "name email").populate("previousAgents", "name email"),
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
        const savedLead = await Lead.findById(inserted.insertedId)
          .populate("user", "name email")
          .populate("previousAgents", "name email");

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(adminDoc, row.source || "CSV Import").catch((e) =>
          console.error("Telegram error:", e.message),
        );

        // ── Auto-send WhatsApp / Email / SMS if toggles are on ───────────────
        autoSendTemplates(savedLead, companyId);

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
          company: getCompanyId(req),
        };
        const lead = await Lead.collection.insertOne(userDoc);
        const savedLead = await Lead.findById(lead.insertedId)
          .populate("user", "name email")
          .populate("previousAgents", "name email");

        // ── Notify admin on WhatsApp ────────────────────────────────────────
        notifyTelegram(userDoc, row.source || "CSV Import").catch((e) =>
          console.error("Telegram error:", e.message),
        );

        // ── Auto-send WhatsApp / Email / SMS if toggles are on ───────────────
        autoSendTemplates(savedLead, getCompanyId(req));

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

// ✅ FIX: strip protected fields before spreading req.body — prevents a user
//         from reassigning a lead to themselves or changing the company by
//         sending { user: "...", company: "..." } in the request body.
//         adminUpdateLead already did this; now the user endpoint does too.
const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
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

// ── CHANGE 4: adminUpdateLead — notify agent when admin manually reassigns ────
const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    // FIX: mirror adminDeleteLead — if companyId resolved to null (e.g. legacy
    // SuperAdmin token where protectSuperAdmin sets req.superAdmin but the
    // SuperAdmin document has no company field), fall back to an id-only query
    // so the lead is still found and the update proceeds.
    const leadQuery = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(leadQuery);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });

    // Capture old assignee before update so we can detect a reassignment
    const previousUserId = lead.user ? String(lead.user) : null;

    const { company, user, leadgenId, reassignReason, ...safeBody } = req.body;

    // ── NEW: allow admin to manually reassign by passing `user` in body ──────
    // The old code stripped `user` from safeBody, preventing reassignment from
    // the admin panel. We now handle it explicitly and cleanly.
    const updatePayload = { ...safeBody };
    let newUserId = null;
    if (user && String(user) !== previousUserId) {
      updatePayload.user = user;
      newUserId = String(user);
    }

    // ── Record reassign reason in activityTimeline ────────────────────────────
    if (newUserId && reassignReason) {
      if (!updatePayload.$push) updatePayload.$push = {};
      updatePayload.$push.activityTimeline = {
        action:      "reassigned",
        performedBy: req.admin?._id || req.superAdmin?._id || null,
        role:        req.admin ? "admin" : "superadmin",
        timestamp:   new Date(),
        note:        reassignReason.trim(),
      };
    }

    const updatedLead = await Lead.findByIdAndUpdate(id, updatePayload, {
      new: true,
    }).populate("user", "name email").populate("previousAgents", "name email");

    // ── NEW: notify newly assigned agent if lead was reassigned ──────────────
    if (newUserId) {
      const _io = global._io;
      if (_io) {
        _io.to(`agent:${newUserId}`).emit('new_lead_assigned', {
          leadId:    String(updatedLead._id),
          leadName:  updatedLead.name,
          source:    updatedLead.source || '',
          eventType: 'reassigned',
        });
      }
      // ✅ FIX BUG 3: Use sendReassignedLeadNotification (not sendNewLeadNotification)
      // for manual admin reassignments — matches the correct notification title
      // "🔄 Lead Reassigned to You" instead of "📋 New Lead Assigned".
      sendReassignedLeadNotification(newUserId, updatedLead).catch((e) =>
        console.error('[FCM] adminUpdateLead push error:', e.message),
      );
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

    const query = { company: getCompanyId(req), user: req.user._id };

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .populate("previousAgents", "name email"),
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

    const lead = await Lead.findOne({ _id: id, company: getCompanyId(req) });
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
    }).populate("user", "name email").populate("previousAgents", "name email");

    const message = isSecondNI
      ? "Lead marked Not Interested again. 3 follow-up calls scheduled. Status reset to New."
      : nextUserId
        ? `Lead reassigned to ${updatedLead.user?.name || "another agent"} with 3 scheduled calls.`
        : "No other agent available; lead kept with you. 3 follow-up calls scheduled.";

    // ── NEW: socket push to newly assigned agent ──────────────────────────────
    if (!isSecondNI && nextUserId) {
      const _io = global._io;
      if (_io) {
        _io.to(`agent:${nextUserId}`).emit('new_lead_assigned', {
          leadId:    String(updatedLead._id),
          leadName:  updatedLead.name,
          source:    updatedLead.source || '',
          eventType: 'reassigned',
        });
      }

      // ── NEW: FCM push notification to the newly assigned agent ───────────
      sendReassignedLeadNotification(nextUserId, updatedLead).catch((e) =>
        console.error('[FCM] reassign push error:', e.message),
      );
    }

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
      .populate("user", "name email")
      .populate("previousAgents", "name email");
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

// ── Helper: merge duplicate lead INTO primary lead ────────────────────────────
// Combines callHistory, scheduledCalls, additionalNumbers, previousAgents,
// phoneRevealLog from `duplicate` into `primary`, then soft-deletes the
// duplicate (isClosed=true, mergedInto=primary._id).
async function performMerge(primary, duplicate, actorId) {
  const now = new Date();

  // Collect additional numbers from duplicate (primary number + its additionals)
  const incomingNumbers = [
    { number: duplicate.mobile, label: "Merged primary", addedBy: actorId, addedAt: now },
    ...(duplicate.additionalNumbers || []).map(n => ({ ...n, addedBy: actorId, addedAt: now })),
  ].filter(n => {
    // Skip numbers already on the primary (by normalized last-10 comparison)
    const norm = String(n.number).replace(/\D/g, "").slice(-10);
    const primNorm = String(primary.mobile).replace(/\D/g, "").slice(-10);
    if (norm === primNorm) return false;
    return !(primary.additionalNumbers || []).some(
      e => String(e.number).replace(/\D/g, "").slice(-10) === norm
    );
  });

  // Deduplicate previousAgents
  const existingAgentIds = new Set((primary.previousAgents || []).map(String));
  const newAgents = (duplicate.previousAgents || []).filter(
    id => !existingAgentIds.has(String(id))
  );

  // Build the timeline entry for the merge event
  const mergeNote = `Merged from duplicate lead "${duplicate.name}" (${duplicate.mobile})`;

  await Lead.findByIdAndUpdate(primary._id, {
    $push: {
      callHistory:      { $each: duplicate.callHistory      || [] },
      scheduledCalls:   { $each: duplicate.scheduledCalls   || [] },
      additionalNumbers:{ $each: incomingNumbers },
      previousAgents:   { $each: newAgents },
      phoneRevealLog:   { $each: duplicate.phoneRevealLog   || [] },
      mergedFrom:       duplicate._id,
      activityTimeline: {
        action:      "merged",
        performedBy: actorId,
        role:        "system",
        timestamp:   now,
        note:        mergeNote,
      },
    },
    $inc: { phoneRevealCount: duplicate.phoneRevealCount || 0 },
  });

  // Soft-close the duplicate
  await Lead.findByIdAndUpdate(duplicate._id, {
    $set: {
      isClosed:    true,
      closeReason: mergeNote,
      closedAt:    now,
      closedBy:    actorId,
      mergedInto:  primary._id,
    },
    $push: {
      activityTimeline: {
        action:      "merged",
        performedBy: actorId,
        role:        "system",
        timestamp:   now,
        note:        `This lead was merged into "${primary.name}" (${primary.mobile})`,
      },
    },
  });
}

// ── POST /lead/:id/additional-numbers ─────────────────────────────────────────
// Add an alternate number to a lead.  Works for both user & admin tokens.
// AUTO-MERGE: if the added number is the primary number of another lead in the
// same company, the two leads are automatically merged and the response includes
// { merged: true, mergedLeadId }.
const addAdditionalNumber = async (req, res) => {
  try {
    const { id } = req.params;
    const { number, label = "" } = req.body;
    if (!number || !String(number).trim()) {
      return res.status(400).json({ message: "number is required" });
    }
    const actorId   = req.user?._id   || req.admin?._id   || null;
    const companyId = req.user?.company || req.admin?.company?._id || req.admin?.company || null;

    const lead = await Lead.findOne({ _id: id, ...(companyId ? { company: companyId } : {}) });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    // Normalize the incoming number (last 10 digits)
    const normalizedIncoming = String(number).replace(/\D/g, "").slice(-10);

    // Prevent adding own primary number
    const ownNorm = String(lead.mobile).replace(/\D/g, "").slice(-10);
    if (normalizedIncoming === ownNorm) {
      return res.status(409).json({ message: "This is already the primary number of this lead" });
    }

    // Prevent duplicate additional number on same lead
    const already = lead.additionalNumbers.some(
      n => String(n.number).replace(/\D/g, "").slice(-10) === normalizedIncoming
    );
    if (already) return res.status(409).json({ message: "Number already linked to this lead" });

    // ── AUTO-MERGE CHECK ──────────────────────────────────────────────────────
    // Look for another lead in the same company whose primary normalizedPhone
    // matches the number being added. If found, merge it in.
    const duplicateLead = companyId
      ? await Lead.findOne({
          company:         companyId,
          normalizedPhone: normalizedIncoming,
          _id:             { $ne: id },
          isClosed:        { $ne: true },
        })
      : null;

    if (duplicateLead) {
      await performMerge(lead, duplicateLead, actorId);
      const updatedLead = await Lead.findById(lead._id)
        .populate("user", "name email")
        .populate("previousAgents", "name email");
      return res.json({
        success:       true,
        merged:        true,
        mergedLeadId:  String(duplicateLead._id),
        mergedLeadName: duplicateLead.name,
        additionalNumbers: updatedLead.additionalNumbers,
        lead: updatedLead,
      });
    }

    // ── No duplicate — just add the number normally ───────────────────────────
    lead.additionalNumbers.push({ number: String(number).trim(), label, addedBy: actorId });
    await lead.save();

    return res.json({ success: true, merged: false, additionalNumbers: lead.additionalNumbers });
  } catch (err) {
    console.error("[addAdditionalNumber]", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /lead/admin/:id/merge/:duplicateId ───────────────────────────────────
// Manual merge: admin explicitly merges duplicateId INTO :id (the keeper).
const mergeLeads = async (req, res) => {
  try {
    const { id, duplicateId } = req.params;
    if (id === duplicateId) return res.status(400).json({ message: "Cannot merge a lead into itself" });

    const companyId = getCompanyId(req);
    const q = companyId ? { company: companyId } : {};

    const [primary, duplicate] = await Promise.all([
      Lead.findOne({ _id: id,          ...q }),
      Lead.findOne({ _id: duplicateId, ...q }),
    ]);
    if (!primary)   return res.status(404).json({ message: "Primary lead not found" });
    if (!duplicate) return res.status(404).json({ message: "Duplicate lead not found" });
    if (duplicate.isClosed) return res.status(409).json({ message: "Duplicate lead is already closed/merged" });

    const actorId = req.admin?._id || req.superAdmin?._id || null;
    await performMerge(primary, duplicate, actorId);

    const updatedPrimary = await Lead.findById(primary._id)
      .populate("user", "name email")
      .populate("previousAgents", "name email");

    return res.status(200).json({
      success:      true,
      lead:         updatedPrimary,
      mergedLeadId: String(duplicate._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /lead/:id/additional-numbers/:index ────────────────────────────────
// Remove an alternate number by its array index.
const removeAdditionalNumber = async (req, res) => {
  try {
    const { id, index } = req.params;
    const idx = parseInt(index, 10);
    const companyId =
      req.user?.company || req.admin?.company?._id || req.admin?.company || null;

    const lead = await Lead.findOne({ _id: id, ...(companyId ? { company: companyId } : {}) });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    if (isNaN(idx) || idx < 0 || idx >= lead.additionalNumbers.length) {
      return res.status(400).json({ message: "Invalid index" });
    }

    lead.additionalNumbers.splice(idx, 1);
    await lead.save();

    return res.json({ success: true, additionalNumbers: lead.additionalNumbers });
  } catch (err) {
    console.error("[removeAdditionalNumber]", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// ── PATCH /lead/admin/:id/close-wrong-entry ───────────────────────────────────
// Admin closes a lead as a wrong entry. Stores the remark, marks isClosed=true,
// and appends an activityTimeline event. Does NOT delete the document — the
// record is kept for audit purposes and filtered out of normal views.
const closeLeadWrongEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: "A reason/remark is required to close this lead." });
    }

    const companyId = getCompanyId(req);
    const leadQuery = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(leadQuery);
    if (!lead) return res.status(404).json({ message: "Lead Not Found!.." });
    if (lead.isClosed) return res.status(409).json({ message: "Lead is already closed." });

    const actorId   = req.admin?._id || req.superAdmin?._id || null;
    const actorRole = req.admin ? "admin" : "superadmin";

    const updatedLead = await Lead.findByIdAndUpdate(
      id,
      {
        $set: {
          isClosed:    true,
          closeReason: String(reason).trim(),
          closedAt:    new Date(),
          closedBy:    actorId,
        },
        $push: {
          activityTimeline: {
            action:      "closed_wrong_entry",
            performedBy: actorId,
            role:        actorRole,
            timestamp:   new Date(),
            note:        String(reason).trim(),
          },
        },
      },
      { new: true }
    ).populate("user", "name email");

    return res.status(200).json({ success: true, lead: updatedLead });
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
  deleteLead,
  adminUpdateLead,
  adminDeleteLead,
  closeLeadWrongEntry,
  mergeLeads,
  getMyLeads,
  updateLeadEmail,
  bulkUpdateEmails,
  adminGetAllLeads,
  checkDuplicate,
  logPhoneReveal,
  getFollowUpAlerts,
  autoSendTemplates,
  addAdditionalNumber,
  removeAdditionalNumber,
};
