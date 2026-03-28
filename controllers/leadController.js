const Lead = require("../models/Leads");
const User = require("../models/Users");

const getLeads = async (req, res) => {
  try {
    const leads = await Lead.find({
      company: req.user.company,
      user: req.user._id,
    });
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
// protectAdmin sets req.admin (has company); protectSuperAdmin sets req.superAdmin (no company)
// For superadmin: companyId must be sent in the request body
const adminCreateLead = async (req, res) => {
  try {
    // Resolve companyId — admin has it on their profile, superadmin passes it in body
    const companyId = req.admin
      ? (req.admin.company._id || req.admin.company)
      : req.body.companyId;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required." });
    }

    // If a specific user (agent) _id was passed, use it; otherwise find first user in company
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

module.exports = { getLead, getLeads, createLead, adminCreateLead, updateLead, deleteLead };