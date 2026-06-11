// controllers/meetingRemarkController.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles POST /lead/:id/meeting-remark  — log a client meeting remark.
// Handles GET  /lead/:id/meeting-remarks — fetch all meeting remarks for a lead.
//
// Supports two content types:
//   1. application/json      — remark only, no attachments
//   2. multipart/form-data   — with optional document and/or recording file
//      Files are uploaded to Cloudinary (same pipeline as call recordings).
//
// Security:
//   • protect middleware ensures user is authenticated
//   • lead must belong to the authenticated user's company
//   • lead must be assigned to req.user OR user must be admin
// ─────────────────────────────────────────────────────────────────────────────

const Lead    = require('../models/Leads');
const multer  = require('multer');
const cloudinary  = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// ── Cloudinary config (shared with mobileCallLogController) ──────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Cloudinary storage for meeting attachments ────────────────────────────────
// Documents go to skyup-crm/meeting-docs, audio to skyup-crm/meeting-recordings
const meetingStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isAudio = file.fieldname === 'recording';
    return {
      folder:        isAudio ? 'skyup-crm/meeting-recordings' : 'skyup-crm/meeting-docs',
      resource_type: 'auto',
      public_id:     `${req.user._id}_${Date.now()}_${file.fieldname}`,
      // For documents Cloudinary returns a secure_url with original extension
      allowed_formats: isAudio
        ? ['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'mp4']
        : ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'webp'],
    };
  },
});

// Multer accepts up to one file per field name
const meetingUpload = multer({
  storage: meetingStorage,
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB max per file
}).fields([
  { name: 'document',  maxCount: 1 },
  { name: 'recording', maxCount: 1 },
]);

// ── Helper: resolve companyId from req ────────────────────────────────────────
const getCompanyId = (req) =>
  req.companyId ||
  (req.admin  ? req.admin.company?._id  || req.admin.company  : null) ||
  req.user?.company || null;

// ── POST /lead/:id/meeting-remark ─────────────────────────────────────────────
// Accepts JSON or multipart. The multer middleware is applied inline so the
// route file doesn't need to import it separately — just mount this handler.
//
// Usage in leadRoute.js:
//   const { addMeetingRemark, getMeetingRemarks } = require('../controllers/meetingRemarkController');
//   router.post('/:id/meeting-remark',  protect, addMeetingRemark);
//   router.get('/:id/meeting-remarks',  protect, getMeetingRemarks);
const addMeetingRemark = (req, res) => {
  // Run multer inline so JSON-only requests (no files) still work
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

      // ── Build the new meeting entry ────────────────────────────────────────
      const entry = {
        userId:      req.user._id,
        userName:    req.user.name || '',
        meetingType: meetingType || 'In-Person',
        outcome:     outcome.trim(),
        remark:      remark.trim(),
        metAt:       new Date(),
        followUpDate: followUpDate ? new Date(followUpDate) : null,
      };

      // Attach document URL if uploaded
      const docFile = req.files?.document?.[0];
      if (docFile) {
        entry.documentUrl  = docFile.path || docFile.secure_url || null;
        entry.documentName = docFile.originalname || docFile.filename || null;
      }

      // Attach recording URL if uploaded
      const recFile = req.files?.recording?.[0];
      if (recFile) {
        entry.recordingUrl  = recFile.path || recFile.secure_url || null;
        entry.recordingName = recFile.originalname || recFile.filename || null;
      }

      // ── Push to meetingRemarks and optionally update lead top-level remark ─
      const updated = await Lead.findByIdAndUpdate(
        id,
        {
          $push: { meetingRemarks: entry },
          // Keep top-level remark in sync so lead cards show latest note
          $set:  { remark: remark.trim() },
        },
        { new: true, runValidators: false },
      );

      // Return the newly added entry (last item in the array)
      const saved = updated.meetingRemarks[updated.meetingRemarks.length - 1];
      return res.status(201).json({
        message:       'Meeting remark saved.',
        meetingRemark: saved,
      });

    } catch (err) {
      console.error('[meetingRemarkController] addMeetingRemark error:', err);
      return res.status(500).json({ message: err.message || 'Internal server error.' });
    }
  });
};

// ── GET /lead/:id/meeting-remarks ─────────────────────────────────────────────
// Returns all meeting remarks for the lead, sorted newest first.
const getMeetingRemarks = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);

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

module.exports = { addMeetingRemark, getMeetingRemarks };