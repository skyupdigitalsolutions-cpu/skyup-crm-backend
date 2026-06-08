// controllers/websiteWebhookController.js
const WebsiteConfig      = require("../models/WebsiteConfig");
const Lead               = require("../models/Leads");
const User               = require("../models/Users");
const { normalizePhone } = require("../utils/normalizePhone");
const { autoSendTemplates } = require("../services/autoTemplateService");
const { notifyCampaignLead } = require("../services/telegramService");

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

    // normalizePhone is the single canonical normaliser — do not fall back to
    // raw strip, which would bypass country-code handling and allow ghost dupes.
    const cleanMobile = normalizePhone(mobile);
    if (!cleanMobile) {
      console.warn(`⚠️  Webhook: unparseable mobile "${mobile}" — lead skipped`);
      return;
    }

    // ── Phone-based dedup — checks BOTH primaryPhone and secondaryPhone ───────
    if (cleanMobile) {
      const normPhone = cleanMobile; // already normalized above
      const duplicate = await Lead.findOne({
            company: config.company,
            $or: [
              { normalizedPhone:          normPhone },
              { normalizedSecondaryPhone: normPhone },
            ],
          }, { _id: 1, name: 1 }).lean();
      if (duplicate) {
        console.log(`⏭ Duplicate — mobile "${cleanMobile}" normalizes to "${normPhone}", exists as "${duplicate.name}"`);
        return;
      }
    }

    const assignedUserId = await getNextAssignedUser(config);

    let newLead;
    try {
      newLead = await Lead.create({
        name:            (name || "Unknown").trim(),
        mobile:          cleanMobile,
        primaryPhone:    cleanMobile,
        normalizedPhone: cleanMobile, // redundant but guards against hook timing issues
        secondaryPhone:  null,
        normalizedSecondaryPhone: null,
        email:           (email || "").trim(),
        source:       "Website",
        campaign:     config.sourceName,
        status:       config.defaultStatus,
        date:         new Date(),
        remark:       message ? `${config.defaultRemark} — ${message}` : config.defaultRemark,
        user:         assignedUserId,
        company:      config.company,
      });
    } catch (createErr) {
      if (createErr.code === 11000) {
        console.log(`   ⚠ Race-condition duplicate for ${cleanMobile} — skipping`);
        return;
      }
      throw createErr;
    }

    console.log(`✅ WEBSITE LEAD SAVED — "${newLead.name}" | ${newLead.mobile} | source: "${config.sourceName}" | id: ${newLead._id}`);

    autoSendTemplates(newLead, config.company);
    // Campaign-only Telegram notification
    notifyCampaignLead(newLead, config.company).catch(e =>
      console.error("[Telegram] Website lead notify error:", e.message)
    );

    try {
      const io = global._io;
      if (io) {
        const populatedLead = await Lead.findById(newLead._id).populate("user", "name email").lean();
        io.emit("new_website_lead", {
          lead:     populatedLead,
          campaign: config.sourceName,
          company:  String(config.company),
        });
        console.log(`📡 Socket event "new_website_lead" emitted for campaign "${config.sourceName}"`);
      }
    } catch (socketErr) {
      console.warn("⚠️  Socket emit failed (non-fatal):", socketErr.message);
    }
  } catch (err) {
    console.error("❌ WEBSITE WEBHOOK ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveWebsiteWebhook };
