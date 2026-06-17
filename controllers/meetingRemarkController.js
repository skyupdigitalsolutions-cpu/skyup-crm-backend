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
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Format time for WhatsApp e.g. "11:00 AM" ─────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
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
      return res.status(201).json({ message: 'Meeting remark saved.', meetingRemark: saved });

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

    console.log('[meetingWhatsApp] companyId resolved:', companyId);
    console.log('[meetingWhatsApp] req.user:', JSON.stringify(req.user));

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Could not resolve company. Please re-login.' });
    }

    // ── 1. Load lead ──────────────────────────────────────────────────────────
    const lead = await Lead.findOne({ _id: id, company: companyId }).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    // Lead model uses `mobile` as the primary phone field (not `phone`)
    const rawPhone    = lead.mobile || lead.primaryPhone || lead.phone;
    const clientPhone = waPhone(rawPhone);
    console.log('[meetingWhatsApp] clientPhone:', clientPhone, '| raw:', rawPhone);

    if (!clientPhone || clientPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'Lead has no valid phone number.' });
    }

    // ── 2. Load WhatsApp config ───────────────────────────────────────────────
    // Try isActive:true first; fall back to any config for this company
    let config = await WhatsAppConfig.findOne({ company: companyId, isActive: true });
    if (!config) {
      config = await WhatsAppConfig.findOne({ company: companyId });
    }

    console.log('[meetingWhatsApp] config found:', !!config, config?._id);

    const authKey      = config?.msg91AuthKey          || process.env.MSG91_AUTH_KEY;
    const senderNumber = config?.msg91IntegratedNumber || process.env.MSG91_INTEGRATED_NUMBER;

    console.log('[meetingWhatsApp] authKey present:', !!authKey, '| senderNumber:', senderNumber);

    if (!authKey || !senderNumber) {
      return res.status(500).json({
        success: false,
        message: 'MSG91 WhatsApp credentials are not configured. Please set them in Settings → WhatsApp.',
      });
    }

    // ── 3. Load company name ──────────────────────────────────────────────────
    const company     = await Company.findById(companyId).select('name').lean();
    const companyName = company?.name || 'SkyUp Digital Solutions';

    // ── 4. Build template variables ───────────────────────────────────────────
    const { meetingDate, meetingTime, meetingMode, agentName } = req.body;

    const clientName = lead.name  || 'there';
    const dateStr    = meetingDate ? fmtDate(meetingDate) : fmtDate(new Date());
    const timeStr    = meetingTime ? fmtTime(meetingTime) : fmtTime(new Date());
    const modeStr    = meetingMode || 'In-Person';
    const agentStr   = agentName   || getUserName(req) || 'Our Team';

    console.log('[meetingWhatsApp] variables:', { clientName, companyName, dateStr, timeStr, modeStr, agentStr });

    // ── 5. Send via MSG91 ─────────────────────────────────────────────────────
    // Template: client_meeting_reminder
    // {{1}}=client name, {{2}}=company name, {{3}}=date,
    // {{4}}=time,        {{5}}=mode,         {{6}}=agent name
    const components = {
      body_1: { type: 'text', value: clientName  },
      body_2: { type: 'text', value: companyName },
      body_3: { type: 'text', value: dateStr     },
      body_4: { type: 'text', value: timeStr     },
      body_5: { type: 'text', value: modeStr     },
      body_6: { type: 'text', value: agentStr    },
    };

    let waMessageId;
    try {
      const payload = {
        integrated_number: senderNumber,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name: 'client_meeting_reminder',
            language: { code: 'en', policy: 'deterministic' },
            to_and_components: [
              { to: [clientPhone], components },
            ],
          },
        },
      };
      console.log('[meetingWhatsApp] MSG91 payload:', JSON.stringify(payload));

      const resp = await axios.post(
        'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        payload,
        { headers: { authkey: authKey, 'Content-Type': 'application/json' } },
      );

      console.log('[meetingWhatsApp] MSG91 response:', JSON.stringify(resp.data));

      waMessageId =
        resp.data?.data?.[0]?.id ||
        resp.data?.requestId     ||
        `mtg_${Date.now()}_${crypto.randomUUID()}`;
    } catch (apiErr) {
      const errBody = apiErr?.response?.data;
      const errMsg  = errBody?.message || errBody?.error?.message || apiErr?.message || 'MSG91 API error';
      console.error('[meetingWhatsApp] MSG91 error:', JSON.stringify(errBody || apiErr?.message));
      return res.status(502).json({ success: false, message: errMsg });
    }

    // ── 6. Save to WhatsApp conversation log (non-fatal) ─────────────────────
    try {
      let conversation = await WhatsAppConversation.findOne({ waPhone: clientPhone, company: companyId });
      if (!conversation) {
        conversation = await WhatsAppConversation.create({
          waPhone:       clientPhone,
          contactName:   lead.name || '',
          company:       companyId,
          lead:          lead._id,
          status:        'waiting',
          lastMessage:   '[Template: client_meeting_reminder]',
          lastMessageAt: new Date(),
        });
      } else {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
          lastMessage:   '[Template: client_meeting_reminder]',
          lastMessageAt: new Date(),
          status:        'waiting',
        });
      }
      await WhatsAppMessage.create({
        conversation:  conversation._id,
        direction:     'outbound',
        body:          '[Template: client_meeting_reminder]',
        messageType:   'template',
        waMessageId,
        sentBy:        getUserId(req),
        status:        'sent',
        waTimestamp:   new Date(),
        isTemplate:    true,
        templateName:  'client_meeting_reminder',
      });
    } catch (logErr) {
      console.error('[meetingWhatsApp] conversation log error:', logErr.message);
    }

    return res.json({
      success:    true,
      message:    `Meeting confirmation WhatsApp sent to ${lead.name || clientPhone}.`,
      waMessageId,
    });

  } catch (err) {
    console.error('[meetingRemarkController] sendMeetingWhatsApp error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
  }
};

module.exports = { addMeetingRemark, getMeetingRemarks, sendMeetingWhatsApp };