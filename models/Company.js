// models/Company.js — UPDATED
// Adds: subscriptionStatus "suspended"|"paused"|"trial_pending", plan "trial",
//       maxAdmins, maxWebsites, maxMetaCampaigns, maxGoogleAccounts, maxStorage,
//       devOverrides, aiProviderMode, customerOpenAiKey, customerGeminiKey,
//       demoCreditGranted, and Razorpay mandate/auto-billing fields
//       (razorpayCustomerId, razorpayTokenId, paymentMethodProvided, trialPlan,
//        trialStartedAt, trialExpiredEmailSent, pendingPlanId, pendingBilling).
// All existing fields are UNCHANGED.

const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

// ── Client-side encryption key fields ─────────────────────────────────────────
// Each company has a unique 32-byte AES-256 key used by the FRONTEND to
// encrypt/decrypt lead PII (mobile, remark, callHistory remarks).
// The backend stores ONLY the SYSTEM_MASTER_KEY-encrypted version of this key.
// At login, the backend decrypts it and sends the plaintext key to the frontend
// over HTTPS — it is held in Redux memory only, never persisted client-side.
//
// encryptedCompanyKey — AES-256-GCM(companyKey, SYSTEM_MASTER_KEY). The only
//   copy of the key the backend stores. select:false so it is NEVER returned
//   in any API response accidentally.
// recoveryKeyHash     — HMAC-SHA256(companyKey, SYSTEM_MASTER_KEY) so the
//   backend can verify a recovery key entered by the admin without storing
//   the plaintext key.

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },

    // ── Plan — extended to include "trial" ────────────────────────────────────
    plan: {
      type:    String,
      enum:    ["trial", "basic", "pro", "advance", "enterprise"],
      default: "trial",
    },

    isActive: { type: Boolean, default: true },

    encryptionKeyHash: {
      type:    String,
      default: null,
    },

    // ── Subscription & Expiry ─────────────────────────────────────────────────
    subscriptionExpiry: {
      type:    Date,
      default: null,
    },

    // Extended enum — adds "suspended", "paused" and "trial_pending".
    // "trial_pending" = company created but the customer has NOT yet added a
    // payment method. The entitlement engine treats any status other than
    // "active"/"trial" as read-only, so a trial_pending company is locked until
    // a card/UPI mandate is registered (see controllers/trialController.js).
    subscriptionStatus: {
      type:    String,
      enum:    ["active", "expired", "trial", "trial_pending", "cancelled", "suspended", "paused"],
      default: "trial_pending",
    },

    // trialEndsAt is null until the customer adds a payment method. The 7-day
    // trial clock starts at the moment the mandate is registered, NOT at
    // company creation, so customers get a full 7 days of usage.
    trialEndsAt: {
      type:    Date,
      default: null,
    },

    // ── Trial & Auto-billing (Razorpay mandate / saved token) ─────────────────
    // razorpayCustomerId  — Razorpay customer the mandate token belongs to.
    // razorpayTokenId     — saved card/UPI mandate token used for server-side
    //                       recurring charges (auto-billing after the trial).
    // paymentMethodProvided — true once a mandate has been registered.
    // trialPlan           — which plan the free trial grants (default "pro").
    // trialStartedAt      — when the customer added payment + the trial began.
    // trialExpiredEmailSent — guard so the "trial expired" email fires only once.
    // pendingPlanId / pendingBilling — plan the customer chose to auto-bill into.
    razorpayCustomerId:    { type: String,  default: null },
    razorpayTokenId:       { type: String,  default: null, select: false },

    // ── Client-side encryption — per-company key ───────────────────────────────
    // Generated once at company creation. Encrypted with SYSTEM_MASTER_KEY.
    // select:false ensures it is never accidentally included in API responses.
    encryptedCompanyKey: { type: String, default: null, select: false },
    // HMAC of the raw companyKey — used to verify a recovery key without
    // decrypting it. select:false — internal use only.
    recoveryKeyHash:     { type: String, default: null, select: false },
    paymentMethodProvided: { type: Boolean, default: false },
    trialPlan:             { type: String,  default: "pro" },
    trialStartedAt:        { type: Date,    default: null },
    trialExpiredEmailSent: { type: Boolean, default: false },
    pendingPlanId:         { type: String,  default: null },
    pendingBilling:        { type: String,  default: "monthly" },

    // ── Data Privacy Settings ─────────────────────────────────────────────────
    dataEncryptionEnabled: {
      type:    Boolean,
      default: false,
    },

    // ── FIX 4D: Atomic round-robin index ─────────────────────────────────────
    roundRobinIndex: {
      type:    Number,
      default: 0,
    },

    // ── Company Branding (set by SuperAdmin) ──────────────────────────────────
    brandName:    { type: String, default: "", trim: true },
    brandLogoUrl: { type: String, default: "", trim: true },

    // ── Header Bar Branding (set by Developer per-company) ────────────────────
    headerName:    { type: String, default: "", trim: true },
    headerLogoUrl: { type: String, default: "", trim: true },

    // ── Extended Branding & Media ─────────────────────────────────────────────
    logo:    { type: String, default: "" },
    favicon: { type: String, default: "" },
    website: { type: String, default: "" },
    address: { type: String, default: "" },

    // ── Theme Colors ──────────────────────────────────────────────────────────
    companyPrimaryColor:   { type: String, default: "#2563EB" },
    companySecondaryColor: { type: String, default: "#1E40AF" },
    stickyHeaderEnabled:   { type: Boolean, default: true },

    // ── Tenant Limits (base — may be overridden by addons/benefits/devOverrides) ──
    maxUsers:  { type: Number, default: 10 },
    maxLeads:  { type: Number, default: 1000 },

    // ── NEW: Extended Tenant Limits ───────────────────────────────────────────
    maxAdmins:          { type: Number, default: 1 },
    maxWebsites:        { type: Number, default: 1 },
    maxMetaCampaigns:   { type: Number, default: 1 },
    maxGoogleAccounts:  { type: Number, default: 1 },
    maxStorage:         { type: Number, default: 100 }, // MB

    // ── NEW: Developer Override Block ─────────────────────────────────────────
    // Highest-priority override — set by developer per-company.
    // Numeric keys override plan+addon+benefit limits.
    // featureToggles is a Map<String, Boolean> keyed by feature key.
    devOverrides: {
      admins:         { type: Number, default: null },
      users:          { type: Number, default: null },
      leads:          { type: Number, default: null },
      websites:       { type: Number, default: null },
      metaCampaigns:  { type: Number, default: null },
      googleAccounts: { type: Number, default: null },
      storageMB:      { type: Number, default: null },

      // NEW: per-company AI / feature LIMIT overrides (null = inherit from plan+addons).
      // These let the developer set an ABSOLUTE monthly cap for a single company,
      // independent of the plan, without touching any other company.
      transcriptionsLimit: { type: Number,  default: null },
      summariesLimit:      { type: Number,  default: null },
      voiceBotLimit:       { type: Number,  default: null },
      recordingEnabled:    { type: Boolean, default: null },

      featureToggles: {
        type: Map,
        of:   Boolean,
        default: {},
      },

      // NEW: per-field metadata for priced/time-limited limit overrides.
      // Keyed by the same numeric override key (e.g. "leads", "storageMB").
      // Each entry: { expiresAt: Date|null, price: Number, currency: String,
      //               grantedAt: Date }. The flat numeric value above remains
      //   the source of truth the entitlement engine reads; this map only
      //   carries the expiry + billing metadata so it can auto-revert and be
      //   shown in the UI. Stored as a free-form object map for flexibility.
      limitMeta: {
        type:    Map,
        of:      mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    // ── NEW: AI Provider Mode ─────────────────────────────────────────────────
    aiProviderMode: {
      type:    String,
      enum:    ["platform_ai", "customer_openai", "customer_gemini"],
      default: "platform_ai",
    },

    // Customer-supplied keys — never returned in normal queries
    customerOpenAiKey: { type: String, select: false },
    customerGeminiKey: { type: String, select: false },

    // ── NEW: Demo Credit Grant Flag ───────────────────────────────────────────
    // Set to true after first-activation demo credits have been granted.
    // Prevents double-granting on re-activations.
    demoCreditGranted: { type: Boolean, default: false },

    // ── Plan feature overrides (set by Developer per-company) ─────────────────
    planFeatures: {
      type:    [{ key: String, enabled: Boolean }],
      default: [],
    },

    // ── Audit — which Developer account created this company ──────────────────
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Developer",
      default: null,
    },

    // ── Brevo (email blast) credentials ──────────────────────────────────────
    brevoApiKey: {
      type:    String,
      default: "",
      trim:    true,
      select:  false,
    },
    brevoSenderEmail: { type: String, default: "", trim: true },
    brevoSenderName:  { type: String, default: "", trim: true },

    // ── MSG91 Email (primary email blast, 5000/day limit → falls back to Brevo) ──
    msg91EmailApiKey: {
      type:    String,
      default: "",
      trim:    true,
      select:  false,
    },
    msg91EmailDomain:      { type: String, default: "", trim: true },
    msg91EmailSenderEmail: { type: String, default: "", trim: true },
    msg91EmailSenderName:  { type: String, default: "", trim: true },
    // Tracks how many emails sent via MSG91 today (resets at midnight UTC)
    msg91EmailDailyCount:  { type: Number, default: 0 },
    msg91EmailCountDate:   { type: String, default: "" }, // "YYYY-MM-DD" UTC


    // ── Telegram Notification Settings ────────────────────────────────────────
    // Campaign-only: only Meta / Google Ads / Website leads trigger notifications.
    telegramBotToken: { type: String, default: null, trim: true },
    telegramChatId:   { type: String, default: null, trim: true },
    telegramEnabled:  { type: Boolean, default: false },

    // ── Clock-in Location Restriction ─────────────────────────────────────────
    // If clockInLocationEnabled=true, employees must be within clockInRadiusMeters
    // of the company coordinates to clock in.
    clockInLocationEnabled: { type: Boolean, default: false },
    clockInLatitude:        { type: Number,  default: null },
    clockInLongitude:       { type: Number,  default: null },
    clockInRadiusMeters:    { type: Number,  default: 100 },

    // ── Client Meeting Location Tracking ─────────────────────────────────────
    // When an employee has clientMeetingPermission active, the app pings GPS
    // every meetingLocationIntervalMinutes and stores it in LiveLocation.
    // Employee must explicitly consent (grant location permission) on device.
    meetingLocationTrackingEnabled: { type: Boolean, default: false },
    meetingLocationIntervalMinutes: { type: Number,  default: 15, min: 5, max: 60 },

    // ── Device Call-Log Sync ─────────────────────────────────────────────────
    callLogSyncEnabled: { type: Boolean, default: true },

    // ── Company-wide Attendance Settings ──────────────────────────────────────
    // These apply to ALL employees in the company (not per-employee).
    attendanceConfig: {
      // Shift / working hours
      shiftStartHour:   { type: Number, default: 9,  min: 0, max: 23 },  // 9:00 AM
      shiftStartMinute: { type: Number, default: 0,  min: 0, max: 59 },
      shiftEndHour:     { type: Number, default: 18, min: 0, max: 23 },  // 6:00 PM
      shiftEndMinute:   { type: Number, default: 0,  min: 0, max: 59 },

      // Late threshold — clock-in after this is marked "Late"
      lateLoginHour:    { type: Number, default: 10, min: 0, max: 23 },  // 10:30 AM
      lateLoginMinute:  { type: Number, default: 30, min: 0, max: 59 },

      // Half-day threshold — working less than this many minutes = half day
      halfDayMinMinutes: { type: Number, default: 240 }, // 4 hours

      // Full-day threshold — working at least this many minutes = present
      fullDayMinMinutes: { type: Number, default: 480 }, // 8 hours

      // Weekly off days — array of weekday numbers (0=Sun, 1=Mon … 6=Sat)
      // Default: Sunday off
      weeklyOffDays: { type: [Number], default: [0] },

      // Specific holiday dates — array of "YYYY-MM-DD" strings
      holidays: [{
        date: { type: String, required: true },   // "2026-01-26"
        name: { type: String, default: "Holiday" }, // "Republic Day"
      }],
    },

        // ── Auto-template settings for new leads ─────────────────────────────────
    autoTemplate: {
      whatsapp: {
        enabled:      { type: Boolean, default: false },
        templateName: { type: String,  default: "crm_followup_leads" },
        languageCode: { type: String,  default: "en" },
      },
      email: {
        enabled:      { type: Boolean, default: false },
        subject:      { type: String,  default: "Welcome! We'll be in touch soon." },
        fromName:     { type: String,  default: "" },
        bodyTemplate: {
          type:    String,
          default: "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out to you shortly.</p><p>Regards,<br/>The Team</p>",
        },
      },
      sms: {
        enabled:    { type: Boolean, default: false },
        message:    { type: String,  default: "Hi {{name}}, thanks for your interest! Our team will contact you soon." },
        templateId: { type: String,  default: "" },
        senderId:   { type: String,  default: "" },
      },
    },

    // ── Auto-blast settings for Interested status leads ───────────────────────
    interestedBlast: {
      whatsapp: {
        enabled:      { type: Boolean, default: false },
        templateName: { type: String,  default: "crm_followup_leads" },
        languageCode: { type: String,  default: "en" },
      },
      email: {
        enabled:      { type: Boolean, default: false },
        subject:      { type: String,  default: "Great news — you're a priority lead!" },
        fromName:     { type: String,  default: "" },
        bodyTemplate: {
          type:    String,
          default: "<p>Hi {{name}},</p><p>We noticed your strong interest and wanted to reach out personally. Our team will connect with you very shortly.</p><p>Regards,<br/>The Team</p>",
        },
      },
      sms: {
        enabled:    { type: Boolean, default: false },
        message:    { type: String,  default: "Hi {{name}}, you're now a priority lead with us! Our team will call you shortly." },
        templateId: { type: String,  default: "" },
        senderId:   { type: String,  default: "" },
      },
    },

    // ── Follow-up reminder settings (WhatsApp + Email to the LEAD) ────────────
    // Powers jobs/followUpReminderJob.js — sends a nudge to the lead twice a
    // day (9:30 AM & 8:30 PM IST) whenever they have a pending, not-yet-done
    // scheduledCalls entry of type "follow-up" that is due today or overdue.
    // No SMS channel here by design (WhatsApp + Email only).
    // Enabled by default so the automation works immediately company-wide;
    // an admin can still disable/customize it later via the same settings
    // endpoints used for autoTemplate / interestedBlast.
    //
    // IMPORTANT: templateName defaults to "crm_followup_reminder" — a NEW
    // WhatsApp template that must be created and approved in the MSG91 panel
    // before this automation can send WhatsApp messages. It is intentionally
    // NOT the same as "crm_followup_leads" (the new-lead welcome template) —
    // reusing that one would send a "thanks for your interest, we'll be in
    // touch" message to a lead who has already been contacted, which reads
    // wrong. See the template spec provided separately for the exact body
    // text / variables to submit for approval.
    followUpReminder: {
      whatsapp: {
        enabled:      { type: Boolean, default: true },
        templateName: { type: String,  default: "crm_followup_reminder" },
        languageCode: { type: String,  default: "en" },
      },
      email: {
        enabled:      { type: Boolean, default: true },
        subject:      { type: String,  default: "Following up on your enquiry, {{name}}" },
        fromName:     { type: String,  default: "" },
        bodyTemplate: {
          type:    String,
          default: "<p>Hi {{name}},</p><p>Just following up on your enquiry — our team hasn't been able to connect with you yet.</p><p>We'll try reaching out again shortly. Feel free to reply to this email or message us on WhatsApp anytime.</p><p>Regards,<br/>The Team</p>",
        },
      },
    },

    // ── Per-call-outcome automation (WhatsApp + Email to the LEAD) ─────────────
    // Powers services/outcomeAutomationService.js, triggered from patchLead
    // whenever an agent logs a call outcome from the mobile "Call Remark" modal
    // (or the web equivalent). One config entry per outcome.
    //
    // IMPORTANT — outcomes intentionally NOT handled here (to avoid double-send):
    //   • "Interested"     → handled by the existing interestedBlast flow.
    //   • "Client Meeting" → handled by the existing meeting-reminder flow
    //                        (client_meeting_reminder template + email).
    //   • "Invalid"        → NO automation (usually a wrong/junk number).
    //
    // Dedupe: each lead receives at most ONE message per outcome per calendar
    // day (IST), tracked via Lead.outcomeAutomationSent — so an agent picking
    // e.g. "Not Answered" three times in a day only triggers one send.
    //
    // WhatsApp templateName values point to templates that must be created and
    // approved in MSG91 before WhatsApp will send (Email works immediately).
    // Not Answered / Busy / Switch Off deliberately SHARE one "crm_call_missed"
    // template since the lead-facing message is identical ("we tried to reach
    // you"). Each entry can still be individually enabled/disabled/customized.
    outcomeAutomation: {
      answered: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_answered" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "Thanks for speaking with us, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>Thank you for taking our call today — it was great speaking with you. If you have any questions, just reply to this email or message us on WhatsApp anytime.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      notAnswered: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_missed" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We tried reaching you, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>We tried reaching you over a call but couldn't connect. We'll try again soon — or feel free to reply with a convenient time to talk.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      busy: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_missed" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We tried reaching you, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>We tried reaching you over a call but couldn't connect. We'll try again soon — or feel free to reply with a convenient time to talk.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      switchOff: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_missed" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We tried reaching you, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>We tried reaching you over a call but couldn't connect. We'll try again soon — or feel free to reply with a convenient time to talk.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      callBackLater: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_back_later" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We'll call you back, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>As discussed, we'll call you back shortly. If your availability changes, just reply and let us know a better time.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      notInterested: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_lead_not_interested" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "Thank you for your time, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>Thank you for your time. If your needs change in the future, we'd be glad to help — feel free to reach out anytime.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },

      // ── Web "Update Lead" panel outcomes ──────────────────────────────────
      // Call Back / Not Reachable reuse the existing approved templates
      // (crm_call_back_later / crm_call_missed) since the lead-facing message
      // is identical. Meeting Scheduled / Demo Done / Converted use their own
      // NEW templates that must be created + approved in MSG91.
      callBack: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_back_later" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We'll call you back, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>As discussed, we'll call you back shortly. If your availability changes, just reply and let us know a better time.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      notReachable: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_call_missed" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "We tried reaching you, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>We tried reaching you over a call but couldn't connect. We'll try again soon — or feel free to reply with a convenient time to talk.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      meetingScheduled: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_meeting_scheduled" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "Your meeting is scheduled, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>Your meeting with our team has been scheduled. We're looking forward to speaking with you — we'll share the details shortly.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      demoDone: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_demo_done" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "Thanks for attending the demo, {{name}}" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>Thank you for taking the time to see our demo. If you have any questions, just reply here — we're happy to help you take the next step.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
      converted: {
        whatsapp: {
          enabled:      { type: Boolean, default: true },
          templateName: { type: String,  default: "crm_converted" },
          languageCode: { type: String,  default: "en" },
        },
        email: {
          enabled:      { type: Boolean, default: true },
          subject:      { type: String,  default: "Welcome aboard, {{name}}!" },
          fromName:     { type: String,  default: "" },
          bodyTemplate: {
            type:    String,
            default: "<p>Hi {{name}},</p><p>Welcome aboard, and thank you for choosing us! Our team will be in touch with the next steps. We're excited to work with you.</p><p>Regards,<br/>The Team</p>",
          },
        },
      },
    },


    // ── Per-company Cloudinary (media storage isolation) ──────────────────────
    // When enabled + filled, this company's media (call recordings, meeting
    // attachments) uploads to ITS OWN Cloudinary account instead of the shared
    // global one. Leave disabled/empty to use the platform's global Cloudinary
    // (CLOUDINARY_* env vars). apiSecret is sensitive — never return it to the
    // client (the controller selects it out).
    cloudinaryConfig: {
      enabled:   { type: Boolean, default: false },
      cloudName: { type: String,  default: "", trim: true },
      apiKey:    { type: String,  default: "", trim: true },
      apiSecret: { type: String,  default: "", trim: true },
    },
  },
  { timestamps: true }
);

const Company = mongoose.model("Company", companySchema);

companySchema.plugin(encryptedFieldsPlugin, {
  fields: ["brevoApiKey", "msg91EmailApiKey", "razorpayTokenId", "cloudinaryConfig.apiKey", "cloudinaryConfig.apiSecret"],
});

module.exports = Company;