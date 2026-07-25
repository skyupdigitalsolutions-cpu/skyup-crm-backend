// controllers/websiteWebhookController.js
const WebsiteConfig      = require("../models/WebsiteConfig");
const Lead               = require("../models/Leads");
const User               = require("../models/Users");
const { normalizePhone } = require("../utils/normalizePhone");
const { autoSendTemplates } = require("../services/autoTemplateService");
const { notifyCampaignLead, notifyAllAdminsCampaignLead } = require("../services/telegramService");
const { sendNewLeadNotification } = require("../services/fcmService");

async function getNextAssignedUser(config) {
  // Round-robin only among the OWNING admin's employees (config.createdBy).
  // Never assign to another admin's staff — that would make the lead invisible
  // to the config's owning admin under the per-admin lead scope.
  const userFilter = { company: config.company, isActive: { $ne: false } };
  if (config.createdBy) userFilter.createdBy = config.createdBy;

  const users = await User.find(userFilter).select("_id").lean();

  if (!users || users.length === 0) {
    console.warn(`⚠️  No eligible users for website config ${config._id} (owner ${config.createdBy}) — lead left unassigned`);
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
    // Accept multiple field name variants — different form builders and landing
    // pages send phone as "phone", "mobile", "contact", "whatsapp" etc.
    const webhook_secret = req.body.webhook_secret || req.body.secret || req.body.key;
    const name   = req.body.name   || req.body.full_name || req.body.fullName  || req.body.customer_name || req.body.form_name || "";
    const mobile = req.body.mobile || req.body.phone     || req.body.whatsapp  || req.body.contact       || req.body.form_mobile || req.body.phoneNumber || req.body.phone_number || "";
    const email  = req.body.email  || req.body.email_id  || req.body.form_email || "";
    const message = req.body.message || req.body.query || req.body.remarks || req.body.form_message || req.body.description || "";

    if (!webhook_secret) return console.warn("⚠️  No webhook_secret in payload. Body keys:", Object.keys(req.body).join(", "));

    console.log(`[WebhookDebug] secret=****${String(webhook_secret).slice(-4)} name="${name}" mobile="${mobile}" email="${email}"`);

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
        normalizedPhone: cleanMobile,
        secondaryPhone:  null,
        normalizedSecondaryPhone: null,
        email:           (email || "").trim(),
        source:       "Website",
        campaign:     config.sourceName,
        status:       config.defaultStatus,
        date:         new Date(),
        remark:       message ? `${config.defaultRemark} — ${message}` : config.defaultRemark,
        user:         assignedUserId,
        assignedAdmin: config.createdBy || null,
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
    // FIX (telegram notifications): wire up the previously-dead
    // notifyAllAdminsCampaignLead so admins who configured a personal
    // chat ID actually get notified for website leads too.
    notifyAllAdminsCampaignLead(newLead, config.company).catch(e =>
      console.error("[Telegram] Website lead admin-notify error:", e.message)
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

    // FIX: notify the ASSIGNED employee specifically. The block above emits a
    // company-wide "new_website_lead" (dashboard refresh), but the employee's
    // bell/badge on web AND the mobile app's in-app handler both listen for
    // `new_lead_assigned` on the agent:<userId> room, and the mobile push comes
    // from sendNewLeadNotification. Neither fired for website leads before, so an
    // employee whose leads arrive via the website form got no notification.
    // Mirrors leadController.adminCreateLead so every source behaves the same.
    if (assignedUserId) {
      if (global._io) {
        global._io.to(`agent:${assignedUserId}`).emit("new_lead_assigned", {
          leadId:    String(newLead._id),
          leadName:  newLead.name,
          source:    newLead.source || "Website",
          eventType: "new",
        });
      }
      sendNewLeadNotification(assignedUserId, newLead).catch(e =>
        console.error("[FCM] Website lead push error:", e.message)
      );
    }
  } catch (err) {
    console.error("❌ WEBSITE WEBHOOK ERROR:", err.message);
    console.error(err.stack);
  }
};

module.exports = { receiveWebsiteWebhook };
