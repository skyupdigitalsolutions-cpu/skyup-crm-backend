// controllers/meetingRemarkController.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles POST /lead/:id/meeting-remark  — log a client meeting remark.
// Handles GET  /lead/:id/meeting-remarks — fetch all meeting remarks for a lead.
// Handles POST /lead/:id/meeting-whatsapp — send WhatsApp meeting confirmation
//
// WhatsApp Integration:
//   Sends the MSG91 `client_meeting_reminder` approved template.
//   Variables: {{1}} client name, {{2}} company name, {{3}} date,
//              {{4}} time, {{5}} mode, {{6}} agent name
// ─────────────────────────────────────────────────────────────────────────────

const Lead           = require('../models/Leads');
const multer         = require('multer');
const cloudinary     = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const axios          = require('axios');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const WhatsAppConversation = require('../models/WhatsAppConversation');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const Company        = require('../models/Company');
const crypto         = require('crypto');
const { normalizePhone: _sharedNormalizePhone } = require('../utils/normalizePhone');
const { resolveCanonicalConversation } = require('../utils/conversationMerge');
const { sendSmartEmail } = require('../services/autoTemplateService');

// ── Cloudinary config ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const meetingStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isAudio = file.fieldname === 'recording';
    return {
      folder:        isAudio ? 'skyup-crm/meeting-recordings' : 'skyup-crm/meeting-docs',
      resource_type: 'auto',
      public_id:     `${req.user._id || req.user.userId}_${Date.now()}_${file.fieldname}`,
      allowed_formats: isAudio
        ? ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'mp4']
        : ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'webp'],
    };
  },
});

const meetingUpload = multer({
  storage: meetingStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
}).fields([
  { name: 'document',  maxCount: 1 },
  { name: 'recording', maxCount: 1 },
]);

// ── Helper: resolve companyId from req — covers ALL role patterns ─────────────
// authMiddleware sets:
//   • employee (protect):   req.user.companyId  AND  req.user.company
//   • admin (protectAdmin): req.admin.company   AND  req.user.companyId (normalized)
const getCompanyId = (req) =>
  req.user?.companyId  ||
  req.user?.company?._id ||
  req.user?.company    ||
  req.admin?.company?._id ||
  req.admin?.company   ||
  req.companyId        ||
  null;

// ── Helper: resolve user name from req ───────────────────────────────────────
const getUserName = (req) => req.user?.name || req.admin?.name || '';
const getUserId   = (req) => req.user?._id  || req.user?.userId || req.admin?._id || null;

// ── WhatsApp phone normalizer — converts to 12-digit Indian E.164 ─────────────
function waPhone(raw) {
  if (!raw) return '';
  const ten = _sharedNormalizePhone(raw);
  if (ten) return '91' + ten;
  const digits = String(raw).replace(/\D/g, '');
  return digits;
}

// ── Format date for WhatsApp e.g. "20 Jun 2026" ──────────────────────────────
// Always format in IST (Asia/Kolkata). The Render server runs in UTC, so
// without an explicit timeZone toLocaleDateString would render the server's
// UTC date, which can be a day behind for late-night IST meetings.
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// ── Format time for WhatsApp e.g. "11:00 AM" ─────────────────────────────────
// Always format in IST (Asia/Kolkata). Without an explicit timeZone this
// rendered in the server's UTC zone, so a 2:00 PM IST meeting showed as a
// morning time (IST − 5:30). This is the meeting-time bug.
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable core: send the `client_meeting_reminder` WhatsApp template.
// Used by BOTH the manual endpoint (sendMeetingWhatsApp) and the automatic
// blast fired when a meeting is scheduled (addMeetingRemark).
// Returns { success, waMessageId?, message? } and never throws.
// ─────────────────────────────────────────────────────────────────────────────
async function _sendClientMeetingWhatsApp({ lead, companyId, meetingDate, meetingTime, meetingMode, agentName, sentByUserId }) {
  try {
    const rawPhone    = lead.mobile || lead.primaryPhone || lead.phone;
    const clientPhone = waPhone(rawPhone);
    if (!clientPhone || clientPhone.length < 10) {
      return { success: false, message: 'Lead has no valid phone number.' };
    }

    let config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) config = await WhatsAppConfig.findOne({ company: companyId });

    const authKey      = config?.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = waPhone(config?.msg91IntegratedNumber || process.env.MSG91_INTEGRATED_NUMBER);
    if (!authKey || !senderNumber) {
      return { success: false, message: 'MSG91 WhatsApp credentials are not configured.' };
    }

    const company     = await Company.findById(companyId).select('name').lean();
    const companyName = company?.name || 'SkyUp Digital Solutions';

    const clientName = lead.name || 'there';
    const dateStr    = meetingDate ? fmtDate(meetingDate) : fmtDate(new Date());
    const timeStr    = meetingTime ? fmtTime(meetingTime) : fmtTime(new Date());
    const modeStr    = meetingMode || 'In-Person';
    const agentStr   = agentName   || 'Our Team';

    const components = {
      body_1: { type: 'text', value: clientName  },
      body_2: { type: 'text', value: companyName },
      body_3: { type: 'text', value: dateStr     },
      body_4: { type: 'text', value: timeStr     },
      body_5: { type: 'text', value: modeStr     },
      body_6: { type: 'text', value: agentStr    },
    };

    let waMessageId;
    const payload = {
      integrated_number: senderNumber,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'client_meeting_reminder',
          language: { code: 'en', policy: 'deterministic' },
          to_and_components: [{ to: [clientPhone], components }],
        },
      },
    };
    const resp = await axios.post(
      'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
      payload,
      { headers: { authkey: authKey, 'Content-Type': 'application/json' } },
    );
    waMessageId =
      resp.data?.data?.[0]?.id || resp.data?.requestId || `mtg_${Date.now()}_${crypto.randomUUID()}`;

    // Log to the WhatsApp conversation (non-fatal)
    try {
      let conversation = await resolveCanonicalConversation({
        leadId: lead._id || null,
        phoneVariants: [clientPhone],
        companyId,
      });
      if (!conversation) {
        conversation = await WhatsAppConversation.create({
          waPhone: clientPhone, contactName: lead.name || '', company: companyId,
          lead: lead._id, status: 'waiting',
          lastMessage: '[Template: client_meeting_reminder]', lastMessageAt: new Date(),
        });
      } else {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
          lastMessage: '[Template: client_meeting_reminder]', lastMessageAt: new Date(), status: 'waiting',
        });
      }
      await WhatsAppMessage.create({
        conversation: conversation._id, direction: 'outbound',
        body: '[Template: client_meeting_reminder]', messageType: 'template',
        waMessageId, sentBy: sentByUserId || null, status: 'sent',
        waTimestamp: new Date(), isTemplate: true, templateName: 'client_meeting_reminder',
      });
    } catch (logErr) {
      console.error('[meetingWhatsApp] conversation log error:', logErr.message);
    }

    // Record in the lead's template history (shown in the Update Lead popup).
    // Content is reconstructed from the actual meeting variables we just sent
    // (client_meeting_reminder isn't always cached in WhatsAppTemplate, so we
    // build a readable equivalent rather than showing nothing).
    try {
      if (lead?._id) {
        const content = `Hi ${clientName}, this is a reminder from ${companyName} for your ${modeStr} meeting on ${dateStr} at ${timeStr} with ${agentStr}.`;
        await Lead.updateOne(
          { _id: lead._id },
          { $push: { templateHistory: { templateName: 'client_meeting_reminder', sentAt: new Date(), channel: 'whatsapp', status: 'sent', content } } }
        );
      }
    } catch (histErr) {
      console.error('[meetingWhatsApp] templateHistory record error:', histErr.message);
    }

    return { success: true, waMessageId };
  } catch (apiErr) {
    const errBody = apiErr?.response?.data;
    const errMsg  = errBody?.message || errBody?.error?.message || apiErr?.message || 'MSG91 API error';
    console.error('[meetingWhatsApp] send error:', JSON.stringify(errBody || apiErr?.message));
    return { success: false, message: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable core: send the meeting-confirmation EMAIL (MSG91 → Brevo fallback).
// Returns { success, provider?, message? } and never throws.
// ─────────────────────────────────────────────────────────────────────────────
async function _sendClientMeetingEmail({ lead, companyId, meetingDate, meetingTime, meetingMode, agentName }) {
  try {
    if (!lead.email || !String(lead.email).trim()) {
      return { success: false, message: 'Lead has no email address.' };
    }

    const company     = await Company.findById(companyId).select('name').lean();
    const companyName = company?.name || 'SkyUp Digital Solutions';

    const clientName = lead.name || 'there';
    const dateStr    = meetingDate ? fmtDate(meetingDate) : fmtDate(new Date());
    const timeStr    = meetingTime ? fmtTime(meetingTime) : fmtTime(new Date());
    const modeStr    = meetingMode || 'In-Person';
    const agentStr   = agentName   || 'Our Team';

    const subject = `Meeting confirmed with ${companyName} — ${dateStr}, ${timeStr}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
        <h2 style="color:#2563EB;margin-bottom:4px">Your meeting is scheduled ✅</h2>
        <p>Hi ${clientName},</p>
        <p>Thank you for scheduling a meeting with <strong>${companyName}</strong>. Here are the details:</p>
        <table style="border-collapse:collapse;margin:16px 0;width:100%">
          <tr><td style="padding:8px 12px;background:#f3f6ff;font-weight:bold;width:140px">📅 Date</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${dateStr}</td></tr>
          <tr><td style="padding:8px 12px;background:#f3f6ff;font-weight:bold">⏰ Time</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${timeStr}</td></tr>
          <tr><td style="padding:8px 12px;background:#f3f6ff;font-weight:bold">📍 Mode</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${modeStr}</td></tr>
          <tr><td style="padding:8px 12px;background:#f3f6ff;font-weight:bold">👤 Meeting with</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${agentStr}</td></tr>
        </table>
        <p>We look forward to speaking with you. If you need to reschedule, simply reply to this email or the WhatsApp message we sent you.</p>
        <p style="margin-top:24px;color:#666;font-size:13px">Regards,<br/>${agentStr}<br/>${companyName}</p>
      </div>`;

    const provider = await sendSmartEmail({
      to:        String(lead.email).trim(),
      toName:    clientName,
      subject,
      html,
      fromName:  companyName,
      companyId,
    });
    return { success: true, provider };
  } catch (err) {
    console.error('[meetingEmail] send error:', err.message);
    return { success: false, message: err.message };
  }
}

// ── POST /lead/:id/meeting-remark ─────────────────────────────────────────────
const addMeetingRemark = (req, res) => {
  meetingUpload(req, res, async (multerErr) => {
    if (multerErr) {
      return res.status(400).json({ message: `File upload error: ${multerErr.message}` });
    }
    try {
      const { id } = req.params;
      const companyId = getCompanyId(req);

      const lead = await Lead.findOne({ _id: id, company: companyId });
      if (!lead) return res.status(404).json({ message: 'Lead not found.' });

      const { meetingType, outcome, remark, followUpDate } = req.body;

      if (!remark || !remark.trim())
        return res.status(400).json({ message: 'Meeting remark / notes are required.' });
      if (!outcome || !outcome.trim())
        return res.status(400).json({ message: 'Meeting outcome is required.' });

      const entry = {
        userId:       getUserId(req),
        userName:     getUserName(req),
        meetingType:  meetingType || 'In-Person',
        outcome:      outcome.trim(),
        remark:       remark.trim(),
        metAt:        new Date(),
        followUpDate: followUpDate ? new Date(followUpDate) : null,
      };

      const docFile = req.files?.document?.[0];
      if (docFile) {
        entry.documentUrl  = docFile.path || docFile.secure_url || null;
        entry.documentName = docFile.originalname || docFile.filename || null;
      }

      const recFile = req.files?.recording?.[0];
      if (recFile) {
        entry.recordingUrl  = recFile.path || recFile.secure_url || null;
        entry.recordingName = recFile.originalname || recFile.filename || null;
      }

      const updated = await Lead.findByIdAndUpdate(
        id,
        {
          $push: { meetingRemarks: entry },
          $set:  { remark: remark.trim() },
        },
        { new: true, runValidators: false },
      );

      const saved = updated.meetingRemarks[updated.meetingRemarks.length - 1];

      // ── Auto-blast: when a meeting is SCHEDULED (a meeting date/time was set),
      //    automatically send the lead the WhatsApp reminder + a confirmation
      //    email. Fire-and-forget so the API responds immediately; failures are
      //    logged but never block saving the remark.
      const meetingWhen = entry.followUpDate;
      if (meetingWhen) {
        const blastArgs = {
          lead,
          companyId,
          meetingDate: meetingWhen,
          meetingTime: meetingWhen,
          meetingMode: entry.meetingType,
          agentName:   entry.userName || getUserName(req) || 'Our Team',
          sentByUserId: getUserId(req),
        };
        setImmediate(async () => {
          try {
            const wa = await _sendClientMeetingWhatsApp(blastArgs);
            console.log(`[meetingBlast] WhatsApp → lead ${lead._id}:`, wa.success ? `sent (${wa.waMessageId})` : `skipped (${wa.message})`);
          } catch (e) { console.error('[meetingBlast] WhatsApp error:', e.message); }
          try {
            const em = await _sendClientMeetingEmail(blastArgs);
            console.log(`[meetingBlast] Email → lead ${lead._id}:`, em.success ? `sent via ${em.provider}` : `skipped (${em.message})`);
          } catch (e) { console.error('[meetingBlast] Email error:', e.message); }
        });

        // Mark the immediate "scheduled" reminder as sent so the cron job
        // (day-before + meeting-day reminders) doesn't re-send it today.
        try {
          await Lead.updateOne(
            { _id: id, "meetingRemarks._id": saved._id },
            { $set: { "meetingRemarks.$.reminders.scheduledAt": new Date() } },
          );
        } catch (e) { console.error('[meetingBlast] mark scheduledAt error:', e.message); }
      }

      return res.status(201).json({
        message: 'Meeting remark saved.',
        meetingRemark: saved,
        blastTriggered: !!meetingWhen,
      });

    } catch (err) {
      console.error('[meetingRemarkController] addMeetingRemark error:', err);
      return res.status(500).json({ message: err.message || 'Internal server error.' });
    }
  });
};

// ── GET /lead/:id/meeting-remarks ─────────────────────────────────────────────
const getMeetingRemarks = async (req, res) => {
  try {
    const { id }      = req.params;
    const companyId   = getCompanyId(req);

    const lead = await Lead.findOne(
      { _id: id, company: companyId },
      { meetingRemarks: 1 },
    ).lean();

    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const sorted = [...(lead.meetingRemarks || [])].sort(
      (a, b) => new Date(b.metAt) - new Date(a.metAt),
    );

    return res.json({ meetingRemarks: sorted });
  } catch (err) {
    console.error('[meetingRemarkController] getMeetingRemarks error:', err);
    return res.status(500).json({ message: err.message || 'Internal server error.' });
  }
};

// ── POST /lead/:id/meeting-whatsapp ───────────────────────────────────────────
// Sends the `client_meeting_reminder` WhatsApp template to the lead's phone.
// Body: { meetingDate, meetingTime, meetingMode, agentName }
const sendMeetingWhatsApp = async (req, res) => {
  try {
    const { id }    = req.params;
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Could not resolve company. Please re-login.' });
    }

    const lead = await Lead.findOne({ _id: id, company: companyId }).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    const { meetingDate, meetingTime, meetingMode, agentName } = req.body;

    const result = await _sendClientMeetingWhatsApp({
      lead,
      companyId,
      meetingDate,
      meetingTime,
      meetingMode,
      agentName:    agentName || getUserName(req),
      sentByUserId: getUserId(req),
    });

    if (!result.success) {
      return res.status(502).json({ success: false, message: result.message || 'Failed to send WhatsApp.' });
    }
    return res.json({
      success:     true,
      message:     `Meeting confirmation WhatsApp sent to ${lead.name || lead.mobile}.`,
      waMessageId: result.waMessageId,
    });
  } catch (err) {
    console.error('[meetingRemarkController] sendMeetingWhatsApp error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
  }
};

module.exports = {
  addMeetingRemark,
  getMeetingRemarks,
  sendMeetingWhatsApp,
  // Exposed for the meeting-reminder cron job (jobs/meetingReminderJob.js)
  _sendClientMeetingWhatsApp,
  _sendClientMeetingEmail,
};
