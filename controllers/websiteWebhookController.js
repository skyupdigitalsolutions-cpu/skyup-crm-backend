const WebsiteConfig = require("../models/WebsiteConfig");
const Lead          = require("../models/Leads");
const User          = require("../models/Users");

async function getNextAssignedUser(config) {
  const users = await User.find({
    company:  config.company,
    isActive: { $ne: false },
  }).select("_id").lean();

  if (!users || users.length === 0) {
    console.warn(`⚠️  No active users for company ${config.company} — lead unassigned`);
    return null;
  }

  const updated = await WebsiteConfig.findByIdAndUpdate(
    config._id,
    { $inc: { roundRobinIndex: 1 } },
    { new: false }
  );

  const index = (updated.roundRobinIndex || 0) % users.length;
  return users[index]._id;
}

const receiveWebsiteWebhook = async (req, res) => {
  res.sendStatus(200);

  try {
    const { webhook_secret, name, mobile, email, message } = req.body;

    if (!webhook_secret) return console.warn("⚠️  No webhook_secret in payload");

    const config = await WebsiteConfig.findOne({ webhookSecret: webhook_secret });
    if (!config) return console.error(`❌ No WebsiteConfig found for secret: "${webhook_secret}"`);
    if (!config.isActive) return console.warn(`⚠️  WebsiteConfig "${config.sourceName}" is PAUSED`);

    const cleanMobile = (mobile || "").replace(/\D/g, "");

    // Deduplicate: same mobile + company within last 10 minutes
    if (cleanMobile) {
      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
      const duplicate  = await Lead.findOne({
        company:   config.company,
        mobile:    cleanMobile,
        createdAt: { $gte: tenMinsAgo },
      });
      if (duplicate) {
        console.log(`⏭ Duplicate submission — mobile "${cleanMobile}" already saved recently`);
        return;
      }
    }

    const assignedUserId = await getNextAssignedUser(config);

    const newLead = await Lead.create({
      name:     (name || "Unknown").trim(),
      mobile:   cleanMobile,
      email:    (email || "").trim(),
      source:   "Website",
      campaign: config.sourceName,
      status:   config.defaultStatus,
      date:     new Date(),
      remark:   message ? `${config.defaultRemark} — ${message}` : config.defaultRemark,
      user:     assignedUserId,
      company:  config.company,
    });

    console.log(`✅ WEBSITE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | source: "${config.sourceName}" | id: ${newLead._id}`);
  } catch (err) {
    console.error("❌ WEBSITE WEBHOOK ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveWebsiteWebhook };