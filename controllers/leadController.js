const Lead = require("../models/Leads");

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
      user: req.user._id,
      company: req.user.company,
    });
    res.status(201).json(lead);
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
    const lead = await Lead.findOne({ _id: id, company: req.user.company });
    if (!lead) {
      return res.status(404).json({ message: "Lead Not Found!.." });
    }
    const updatedLead = await Lead.findByIdAndUpdate(id, req.body, {
      new: true,
    });
    return res.status(200).json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getLead, getLeads, createLead, updateLead, deleteLead };