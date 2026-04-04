const Lead = require("../models/Leads");
const User = require("../models/Users");

const getLeads = async (req, res) => {
  try {
    // Return leads assigned to this user OR unassigned leads for the same company
    const leads = await Lead.find({
      company: req.user.company,
      $or: [
        { user: req.user._id },
        { user: null },
      ],
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
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }
    res.status(200).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin fetches leads for a specific campaign (used in Campaigns → LeadDrawer)
const getLeadsByCampaign = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { campaign } = req.query;

    if (!campaign) {
      return res.status(400).json({ message: "campaign query param is required" });
    }

    const leads = await Lead.find({
      company:  companyId,
      campaign: campaign,
    }).populate("user", "name email");

    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLead = async (req, res) => {
  try {
    const lead = await Lead.create({
      ...req.body,
      user: req.body.user || req.user._id,
      company: req.user.company,
    });
    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin OR SuperAdmin creates a lead from the dashboard ───────────────────
const adminCreateLead = async (req, res) => {
  try {
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required." });
    }

    let assignedUser = req.body.user || null;
    if (!assignedUser) {
      const fallback = await User.findOne({ company: companyId }).select("_id").lean();
      if (!fallback) {
        return res.status(400).json({ message: "No users found in this company to assign the lead." });
      }
      assignedUser = fallback._id;
    }

    const lead = await Lead.create({
      name:     req.body.name,
      mobile:   req.body.mobile,
      source:   req.body.source   || "Web Form",
      campaign: req.body.campaign || null,
      status:   req.body.status   || "New",
      date:     req.body.date     || new Date(),
      remark:   req.body.remark   || "Manually added",
      user:     assignedUser,
      company:  companyId,
    });

    const populated = await Lead.findById(lead._id).populate("user", "name email");
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin OR SuperAdmin bulk-creates leads (up to 50 at a time) ─────────────
const adminCreateLeadsBulk = async (req, res) => {
  try {
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required." });
    }

    const items = req.body.leads; // array of lead objects
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "leads array is required and must not be empty." });
    }
    if (items.length > 50) {
      return res.status(400).json({ message: "Maximum 50 leads per bulk request." });
    }

    // Resolve a fallback user once (round-robin not applied here – caller passes user per row)
    const fallbackUser = await User.findOne({ company: companyId }).select("_id").lean();

    const results   = [];
    const errors    = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const assignedUser = row.user || (fallbackUser ? fallbackUser._id : null);
        if (!assignedUser) {
          errors.push({ index: i, message: "No user found in this company to assign the lead." });
          continue;
        }

        // leadgenId is intentionally omitted for manual leads so sparse index is not triggered
        const lead = await Lead.create({
          name:     row.name,
          mobile:   row.mobile,
          source:   row.source   || "Web Form",
          campaign: row.campaign || null,
          status:   row.status   || "New",
          date:     row.date     || new Date(),
          remark:   row.remark   || "Manually added",
          user:     assignedUser,
          company:  companyId,
          // leadgenId deliberately absent — undefined is not indexed by sparse index
        });

        const populated = await Lead.findById(lead._id).populate("user", "name email");
        results.push(populated);
      } catch (err) {
        errors.push({ index: i, message: err.message });
      }
    }

    res.status(207).json({
      saved:  results,
      errors: errors,
      total:  items.length,
      savedCount:  results.length,
      errorCount:  errors.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }
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
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }
    const updatedLead = await Lead.findByIdAndUpdate(id, req.body, { new: true });
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin / SuperAdmin update a lead ────────────────────────────────────────
const adminUpdateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;

    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }

    // Strip fields that should never be overwritten via this route
    const { company, user, leadgenId, ...safeBody } = req.body;

    const updatedLead = await Lead.findByIdAndUpdate(id, safeBody, { new: true })
      .populate("user", "name email");
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Admin / SuperAdmin delete a lead ────────────────────────────────────────
const adminDeleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : null;

    const query = companyId ? { _id: id, company: companyId } : { _id: id };
    const lead = await Lead.findOne(query);
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }
    await Lead.findByIdAndDelete(id);
    return res.status(200).json({ message: "Deleted the Lead Successfully!.." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User: fetch only leads assigned to themselves ────────────────────────────
const getMyLeads = async (req, res) => {
  try {
    const leads = await Lead.find({
      company: req.user.company,
      user:    req.user._id,           // strictly only this user's leads
    })
      .sort({ createdAt: -1 })
      .populate("user", "name email");
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User: PATCH status + remark on a lead (same as updateLead but PATCH verb) ─
const patchLead = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }

    // Only allow safe fields — never let user overwrite company/user/leadgenId
    const { status, remark } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    if (remark !== undefined) update.remark = remark;

    const updatedLead = await Lead.findByIdAndUpdate(id, update, { new: true });
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── User: PATCH temperature on a lead ───────────────────────────────────────
const patchLeadTemperature = async (req, res) => {
  try {
    const { id } = req.params;
    const { temperature } = req.body;

    if (!["Hot", "Warm", "Cold"].includes(temperature)) {
      return res.status(400).json({ message: "temperature must be Hot, Warm, or Cold" });
    }

    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }

    const updatedLead = await Lead.findByIdAndUpdate(
      id,
      { temperature },
      { new: true }
    );
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getLead, getLeads, getLeadsByCampaign,
  createLead, adminCreateLead, adminCreateLeadsBulk,
  updateLead, patchLead, patchLeadTemperature,
  deleteLead, adminUpdateLead, adminDeleteLead,
  getMyLeads,
};