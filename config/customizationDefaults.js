// config/customizationDefaults.js
// ─────────────────────────────────────────────────────────────────────────────
// PER-COMPANY CUSTOMIZATION — DEFAULTS + CATALOG
//
// Every value below reproduces the behaviour the CRM had BEFORE customization
// existed (the old hardcoded lists / timings / flows). A company that never
// opens the "Customize CRM" screen therefore behaves exactly as before — the
// customization layer only changes anything once an admin edits it.
//
// Stored per company in models/CompanyCustomization.js. Resolved (defaults +
// stored overrides, deep-merged) by services/customizationService.js.
//
// IMPORTANT DESIGN RULES
//   • Lead statuses / outcomes are stored on leads by their `key`. Renaming
//     changes only the `label`, so a rename never needs a data migration.
//   • Built-in ("system") statuses and outcomes power workflows (NI / Cold /
//     Invalid verification, Interested blast, meeting reminders …). They can
//     be renamed, recoloured, reordered, hidden from employees or deactivated
//     — but not deleted, so historical data always resolves.
//   • Workflow code never compares against literal status names any more; it
//     asks the service for "the won statuses", "the verification status" etc.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

// ── Colour palette ───────────────────────────────────────────────────────────
// Statuses / outcomes / temperatures pick a palette KEY (not free hex) so the
// web app can render them with pre-compiled Tailwind classes in light + dark.
const PALETTE = {
  blue:    "#2563EB",
  sky:     "#0284C7",
  cyan:    "#0891B2",
  teal:    "#0D9488",
  emerald: "#059669",
  green:   "#16A34A",
  lime:    "#65A30D",
  yellow:  "#CA8A04",
  amber:   "#D97706",
  orange:  "#EA580C",
  red:     "#DC2626",
  rose:    "#E11D48",
  pink:    "#DB2777",
  purple:  "#7C3AED",
  violet:  "#8B5CF6",
  indigo:  "#4F46E5",
  slate:   "#475569",
  gray:    "#6B7280",
};

// ── Status categories (what a status MEANS to the system) ────────────────────
//   new          — entry status for fresh leads (exactly one should be default)
//   open         — being worked
//   interested   — positive intent (triggers the Interested blast)
//   verification — parked with a second agent during NI / Cold / Invalid checks
//   won          — converted / closed-won (counted as conversions everywhere)
//   lost         — closed-lost (excluded from active work, alerts, reminders)
const STATUS_CATEGORIES = ["new", "open", "interested", "verification", "won", "lost"];

// ── Outcome behaviours (what picking an outcome DOES) ────────────────────────
//   none          — just logs the call
//   interested    — fires the Interested blast (once per lead)
//   notInterested — runs the Not-Interested verification flow
//   invalid       — runs the Invalid verification / close flow
//   cold          — runs the Cold verification flow
//   clientMeeting — opens the client-meeting logger (meeting reminders handle messaging)
const OUTCOME_BEHAVIOURS = ["none", "interested", "notInterested", "invalid", "cold", "clientMeeting"];

// Follow-up rule when an outcome is logged:
//   none     — never schedule
//   optional — schedule only if the agent picks a date
//   required — agent MUST pick a date
//   auto     — schedule automatically (autoFollowUpDays later at default hour) unless a date is picked
const FOLLOWUP_RULES = ["none", "optional", "required", "auto"];

// Outcome group — used by the mobile app's two-sector picker and reports.
const OUTCOME_GROUPS = ["answered", "notAnswered", "other"];

const CUSTOM_FIELD_TYPES = ["text", "textarea", "number", "date", "datetime", "select", "multiselect", "checkbox", "email", "phone", "url"];

// ── MODULE CATALOG ───────────────────────────────────────────────────────────
// Every feature a company can switch on/off. `key` matches the entitlement key
// used by the plan/addon/developer layer (services/entitlementService.js), so:
//
//   effective access = (plan/addon/developer allows it) AND (company has it ON)
//
// `navOnly` modules had no plan flag before (Dashboard, Campaigns, Call
// Monitoring …) — they were simply always on. They are now ordinary toggles.
const MODULE_CATALOG = [
  // Core
  { key: "dashboard",            group: "Core",          label: "Dashboard",                 navOnly: true },
  { key: "leadManagement",       group: "Core",          label: "Leads" },
  { key: "contacts",             group: "Core",          label: "Contacts" },
  { key: "campaigns",            group: "Core",          label: "Campaigns",                 navOnly: true },
  { key: "callMonitoring",       group: "Core",          label: "Call Monitoring",           navOnly: true },
  { key: "pipelineBoard",        group: "Core",          label: "Pipeline Board",            navOnly: true },
  { key: "clientMeetings",       group: "Core",          label: "Client Meetings",           navOnly: true },
  { key: "projects",             group: "Core",          label: "Projects" },
  { key: "tasks",                group: "Core",          label: "Tasks" },
  // Reporting
  { key: "basicReports",         group: "Reports",       label: "Report Page" },
  { key: "dailyReport",          group: "Reports",       label: "Daily Report" },
  { key: "customReports",        group: "Reports",       label: "Custom Reports" },
  { key: "leadIntelligence",     group: "Reports",       label: "Lead Intelligence" },
  { key: "callOutcomesReport",   group: "Reports",       label: "Call Outcomes Report" },
  // People
  { key: "attendance",           group: "People",        label: "Attendance" },
  { key: "payroll",              group: "People",        label: "Payroll" },
  { key: "teamLeads",            group: "People",        label: "Team Leads (My Team)",      navOnly: true },
  // Communication
  { key: "communications",       group: "Communication", label: "Communications",            navOnly: true },
  { key: "whatsappBlast",        group: "Communication", label: "WhatsApp Blast" },
  { key: "smsBlast",             group: "Communication", label: "SMS Blast" },
  { key: "emailBlast",           group: "Communication", label: "Email Blast" },
  { key: "whatsappAutomation",   group: "Communication", label: "WhatsApp Automation" },
  // defaultOff: hidden for every company unless the Developer panel turns it ON for that company.
  { key: "festivalCampaigns",    group: "Communication", label: "Festival Campaigns",        navOnly: true, defaultOff: true },
  { key: "marketingDashboard",   group: "Communication", label: "Digital Marketing Dashboard", navOnly: true, defaultOff: true },
  { key: "leadNurtureSequence",  group: "Communication", label: "Lead Nurture" },
  { key: "telegramNotification", group: "Communication", label: "Telegram Notifications" },
  { key: "whatsappScreenshots",  group: "Communication", label: "WhatsApp Screenshot Proof", navOnly: true },
  // Calling & AI
  { key: "callRecording",        group: "Calling & AI",  label: "Call Recording" },
  { key: "callTranscription",    group: "Calling & AI",  label: "Call Transcription" },
  { key: "aiSummary",            group: "Calling & AI",  label: "AI Summary" },
  { key: "voiceBot",             group: "Calling & AI",  label: "Voice Bot" },
  // Integrations
  { key: "metaAds",              group: "Integrations",  label: "Meta Ads" },
  { key: "googleAds",            group: "Integrations",  label: "Google Ads" },
  { key: "linkedInAds",          group: "Integrations",  label: "LinkedIn Ads" },
  { key: "websiteTracking",      group: "Integrations",  label: "Website Forms" },
  { key: "metaConversionSync",   group: "Integrations",  label: "Meta Conversion Sync" },
  { key: "apiAccess",            group: "Integrations",  label: "API Access" },
  { key: "webhookAccess",        group: "Integrations",  label: "Webhooks" },
  // Branding
  { key: "customBranding",       group: "Branding",      label: "Custom Branding" },
  { key: "whiteLabel",           group: "Branding",      label: "White Label" },
  { key: "customDomain",         group: "Branding",      label: "Custom Domain" },
];

// Keys whose availability the PLAN controls (entitlement layer). navOnly keys
// are not plan-gated — the company toggle alone decides.
const NAV_ONLY_MODULE_KEYS = MODULE_CATALOG.filter((m) => m.navOnly).map((m) => m.key);

function defaultModules() {
  const out = {};
  for (const m of MODULE_CATALOG) {
    out[m.key] = { enabled: true, label: "", admin: true, employee: true };
  }
  // Same visibility the old sidebar had for employees.
  for (const k of ["campaigns", "callMonitoring", "basicReports", "customReports", "leadIntelligence",
    "leadNurtureSequence", "attendance", "payroll", "festivalCampaigns", "pipelineBoard", "marketingDashboard"]) {
    out[k].employee = false;
  }
  return out;
}

// ── Lead statuses ────────────────────────────────────────────────────────────
const DEFAULT_STATUSES = [
  { key: "New",            label: "New",            color: "blue",    category: "new",          order: 1, active: true, isDefault: true,  employeeSelectable: true,  showInPipeline: true,  metaEvent: "Lead",     aliases: [],           system: true },
  { key: "In Progress",    label: "In Progress",    color: "amber",   category: "open",         order: 2, active: true, isDefault: false, employeeSelectable: true,  showInPipeline: true,  metaEvent: "Contact",  aliases: [],           system: true },
  { key: "Interested",     label: "Interested",     color: "emerald", category: "interested",   order: 3, active: true, isDefault: false, employeeSelectable: false, showInPipeline: false, metaEvent: "Schedule", aliases: ["Interest"], system: true },
  { key: "Verification",   label: "Verification",   color: "purple",  category: "verification", order: 4, active: true, isDefault: false, employeeSelectable: false, showInPipeline: true,  metaEvent: "",         aliases: [],           system: true },
  { key: "Converted",      label: "Converted",      color: "emerald", category: "won",          order: 5, active: true, isDefault: false, employeeSelectable: true,  showInPipeline: true,  metaEvent: "Purchase", aliases: ["Won"],      system: true },
  { key: "Not Interested", label: "Not Interested", color: "red",     category: "lost",         order: 6, active: true, isDefault: false, employeeSelectable: true,  showInPipeline: false, metaEvent: "",         aliases: [],           system: true },
];

// ── Call outcomes ────────────────────────────────────────────────────────────
// automationKey → Company.outcomeAutomation.<key> (existing WhatsApp/Email
// config). An outcome may instead carry its own `automation` block (set from
// the Customize CRM → Automations tab), which takes precedence.
function outcome(key, extra) {
  return {
    key, label: key, color: "gray", group: "answered", order: 0, active: true, system: true,
    behavior: "none", followUp: "optional", autoFollowUpDays: 1, autoStatus: "",
    automationKey: "", allowForManualLeads: false, countsAsConnected: true,
    automation: null,
    ...extra,
  };
}
const DEFAULT_OUTCOMES = [
  outcome("Answered",        { color: "emerald", group: "answered",    order: 1,  automationKey: "answered", allowForManualLeads: true, autoStatus: "In Progress" }),
  outcome("Not Answered",    { color: "slate",   group: "notAnswered", order: 2,  automationKey: "notAnswered", countsAsConnected: false }),
  outcome("Busy",            { color: "amber",   group: "notAnswered", order: 3,  automationKey: "busy",        countsAsConnected: false }),
  outcome("Switch Off",      { color: "gray",    group: "notAnswered", order: 4,  automationKey: "switchOff",   countsAsConnected: false }),
  outcome("Call Back Later", { color: "sky",     group: "answered",    order: 5,  automationKey: "callBackLater", autoStatus: "In Progress" }),
  outcome("Interested",      { color: "emerald", group: "answered",    order: 6,  behavior: "interested", autoStatus: "Interested" }),
  outcome("Not Interested",  { color: "red",     group: "answered",    order: 7,  behavior: "notInterested", followUp: "none", automationKey: "notInterested" }),
  outcome("Invalid",         { color: "rose",    group: "other",       order: 8,  behavior: "invalid", followUp: "none", countsAsConnected: false }),
  outcome("Client Meeting",  { color: "purple",  group: "answered",    order: 9,  behavior: "clientMeeting", autoStatus: "Interested" }),
  outcome("Proposal Sent",   { color: "indigo",  group: "answered",    order: 10, autoStatus: "Interested" }),
  // Outcomes the backend already had automation templates for (web "Update
  // Lead" panel). Off by default to keep today's dropdowns identical — a
  // company can switch them on from Customize CRM → Call Outcomes.
  outcome("Call Back",         { color: "sky",     group: "answered",    order: 11, active: false, automationKey: "callBack", followUp: "auto" }),
  outcome("Not Reachable",     { color: "gray",    group: "notAnswered", order: 12, active: false, automationKey: "notReachable", countsAsConnected: false }),
  outcome("Meeting Scheduled", { color: "purple",  group: "answered",    order: 13, active: false, automationKey: "meetingScheduled" }),
  outcome("Demo Done",         { color: "teal",    group: "answered",    order: 14, active: false, automationKey: "demoDone" }),
  outcome("Converted",         { color: "emerald", group: "answered",    order: 15, active: false, automationKey: "converted", autoStatus: "Converted" }),
];

// ── Temperatures / lead quality ──────────────────────────────────────────────
// `triggersColdFlow` — picking it runs the Cold verification/reassign flow.
const DEFAULT_TEMPERATURES = [
  { key: "Hot",  label: "Hot",  color: "red",   order: 1, active: true, system: true, triggersColdFlow: false },
  { key: "Warm", label: "Warm", color: "amber", order: 2, active: true, system: true, triggersColdFlow: false },
  { key: "Cold", label: "Cold", color: "blue",  order: 3, active: true, system: true, triggersColdFlow: true },
];

// ── Simple dropdown lists ────────────────────────────────────────────────────
const DEFAULT_LISTS = {
  // Sources selectable when adding / filtering leads. Integration sources
  // (Meta, Google Ads, Website, WhatsApp, LinkedIn) still set their own value.
  sources: ["Manual", "Google Ads", "Campaign", "Facebook Ads", "Web Form", "Referral", "CSV Import", "Channel Partner", "Other"],
  meetingTypes: ["In-Person", "Video Call", "Phone Call", "Site Visit", "Demo"],
  meetingOutcomes: ["Interested", "Not Interested", "Converted", "Follow-Up Required", "Pending Decision", "No Show"],
  closeReasons: ["Wrong entry", "Duplicate", "Fake lead", "Wrong number", "Test lead"],
  notInterestedReasons: ["Price too high", "Not the decision maker", "Already using a competitor", "No requirement now", "Budget issue", "Other"],
  industries: [
    "Healthcare", "Education", "Real Estate", "Logistics", "Finance",
    "IT Solutions", "Digital Marketing", "Construction", "Local Business",
    "Interior Designers", "Professional Services",
  ],
  services: [
    "SEO", "Paid Ads", "Website Design & Development", "AI Automation",
    "CRM", "Video Editing", "Graphic Design", "Social Media Marketing",
    "AI Voice Agent", "Custom Software", "WhatsApp Automation & Chatbots", "ERP Systems",
    "Mobile Applications", "Branding",
  ],
  languages: ["English", "Hindi", "Kannada", "Tamil", "Telugu", "Malayalam", "Marathi", "Bengali", "Gujarati"],
};

// ── Built-in lead field visibility / requirement ────────────────────────────
const DEFAULT_LEAD_FIELDS = {
  email:          { visible: true,  required: false, label: "Email" },
  secondaryPhone: { visible: true,  required: false, label: "Additional Number" },
  source:         { visible: true,  required: false, label: "Source" },
  campaign:       { visible: true,  required: false, label: "Campaign" },
  temperature:    { visible: true,  required: false, label: "Lead Quality" },
  // allowOther → pickers show "Other" with a free-text box (value stored as typed).
  industry:       { visible: true,  required: false, label: "Industry", allowOther: true },
  // multiple → a lead can carry several services (Lead.services[]; Lead.service = first one).
  service:        { visible: true,  required: false, label: "Service", multiple: true, allowOther: false },
  businessName:   { visible: true,  required: false, label: "Business Name" },
  language:       { visible: true,  required: false, label: "Language" },
  remark:         { visible: true,  required: true,  label: "Remark" },
};

// ── Workflows ────────────────────────────────────────────────────────────────
const DEFAULT_WORKFLOWS = {
  // Generic lead-update rules
  leadUpdate: {
    remarkRequired: true,              // remark mandatory on every update
    preventPastFollowUp: true,         // follow-up date can't be in the past
    defaultFollowUpDays: 1,            // "auto" follow-ups land N days later …
    defaultFollowUpHour: 9,            // … at this hour (company local time)
    defaultOutcomeWhenMissing: "Call Back", // label stored if a call is logged with no outcome
    hideInterestedOnceInterested: true, // hide the Interested outcome once already interested
    autoAdvanceStatusFromOutcome: true, // apply outcome.autoStatus (never downgrades)
    completeOldestPendingOnUpdate: true, // each update ticks off the oldest pending follow-up
  },

  // New lead defaults
  leadCreation: {
    defaultSource: "Web Form",
    defaultImportSource: "Excel Import",
    defaultRemark: "Manually added",
    defaultImportRemark: "Imported via Excel",
    autoTemperature: true,             // compute Hot/Warm/Cold from form completeness
  },

  // Assignment of new / reassigned leads
  assignment: {
    strategy: "least_loaded",          // least_loaded | round_robin | manual
    importStrategy: "round_robin",     // admin imports: round_robin | least_loaded | unassigned
  },

  notInterested: {
    enabled: true,                     // false → just set the lost status, no reassignment
    verification: true,                // send to another agent for verification first
    verificationStatus: "Verification",
    finalStatus: "Not Interested",
    resetStatus: "New",
    // Who verifies: "round_robin" (another employee, as before) or
    // "team_lead" (the employee's Team Lead; falls back to round robin when
    // the employee has no Team Lead).
    verifier: "round_robin",
    followUps: [
      { type: "follow-up",    days: 3,  note: "Auto follow-up after Not Interested" },
      { type: "verification", days: 7,  note: "7-day verification call" },
      { type: "verification", days: 30, note: "1-month verification call" },
    ],
  },

  cold: {
    enabled: true,
    verification: true,
    verificationStatus: "Verification",
    returnStatus: "New",
    followUps: [
      { type: "follow-up",    days: 3,  note: "Auto follow-up after Cold reassignment" },
      { type: "verification", days: 7,  note: "7-day verification call" },
      { type: "verification", days: 30, note: "1-month verification call" },
    ],
  },

  invalid: {
    enabled: true,
    verification: true,                // false → close immediately
    verificationStatus: "Verification",
    closedStatus: "Not Interested",
    resetStatus: "New",
  },

  closeByEmployee: {
    enabled: true,
    closedStatus: "Not Interested",
    requirePhone: true,
  },
};

// ── Employee permissions (enforced on the backend) ───────────────────────────
const DEFAULT_PERMISSIONS = {
  employee: {
    canAddLeads: true,
    canImportLeads: true,
    canEditLeadDetails: true,
    canEditPhoneNumbers: true,
    canCloseLeads: true,
    canMarkInvalid: true,
    canMarkNotInterested: true,
    canMarkCold: true,
    canMergeLeads: true,
    canRevealContact: true,
    canChangeTemperature: true,
    canScheduleFollowUps: true,
    canExportLeads: true,
    canLogClientMeetings: true,
  },
  // Team Lead = an employee flagged isTeamLead. Everything an employee can do
  // (above) PLUS these, limited to their own team.
  teamLead: {
    canViewTeamLeads: true,       // see team members' leads
    canEditTeamLeads: true,       // update / log calls on team members' leads
    canCallTeamLeads: true,       // call team members' leads (number revealed for the call)
    canReassignLeads: true,       // move leads between own team members
    canRevealTeamContact: false,  // see unmasked phone / email of team leads
    canViewTeamCalls: true,       // team call logs & recordings
    canViewTeamAttendance: true,  // team attendance today / history
    canVerifyNotInterested: true, // act as NI verifier when workflow says so
  },
  // Call recordings: who may DOWNLOAD the audio file (everyone can still play
  // it inside the CRM). Off by default = the old "no download" behaviour.
  recordings: {
    superAdminCanDownload: false,
    adminCanDownload: false,
    teamLeadCanDownload: false,
    employeeCanDownload: false,
  },
  // Lead deletion has been removed for every role — close or merge instead.
  admin: {
    canImportLeads: true,
    canExportLeads: true,
    canReassignLeads: true,
  },
};

// ── Alerts & reminders (per company) ────────────────────────────────────────
const DEFAULT_ALERTS = {
  noAction: {
    enabled: true,
    firstAlertHours: 1,
    secondAlertHours: 2,
    escalationHours: 3,
    escalationEnabled: true,
    // Second alert also goes to the employee's Team Lead (if they have one).
    notifyTeamLead: true,
  },
  noFollowUpDate: {
    enabled: true,
    afterHours: 24,
    repeatEveryHours: 24,
  },
  followUpDigest: {
    enabled: true,
    time: "09:30",                     // HH:mm, company timezone
  },
  callReminder: {
    enabled: true,
    minutesBefore: 15,
  },
  leadFollowUpReminder: {              // WhatsApp/Email nudges sent TO the lead
    enabled: true,
    intervalDays: 3,
    morningTime: "09:30",
    eveningTime: "20:30",
    eveningEnabled: true,
  },
};

// ── General / terminology / branding ─────────────────────────────────────────
const DEFAULT_GENERAL = {
  timezone: "Asia/Kolkata",
  currency: "INR",
  dateFormat: "DD MMM YYYY",
  defaultCountryCode: "91",
  appName: "",                         // shown in sidebar/header; blank → company brand / name
  terminology: {
    lead: "Lead",
    leads: "Leads",
    employee: "Employee",
    employees: "Employees",
    admin: "Admin",
    campaign: "Campaign",
    followUp: "Follow-up",
  },
};

// ── Messaging copy that used to be hardcoded to Skyup ───────────────────────
const DEFAULT_MESSAGING = {
  // Used when an SMS automation has no message of its own.
  // {{company}} is replaced with the company's brand/name.
  smsGreeting: "Hi {{name}}, thank you for contacting {{company}}! Our team will connect with you shortly.",
  dailyReportTitle: "{{company}} — DAILY SALES REPORT",
};

// ── Dashboard widgets ───────────────────────────────────────────────────────
const DEFAULT_DASHBOARD = {
  widgets: {
    kpis: true,
    pipeline: true,
    sources: true,
    temperature: true,
    followUps: true,
    employeePerformance: true,
    recentLeads: true,
    campaigns: true,
  },
};

function buildDefaults() {
  // Fresh deep copy every call so callers can mutate safely.
  return JSON.parse(JSON.stringify({
    modules: defaultModules(),
    statuses: DEFAULT_STATUSES,
    outcomes: DEFAULT_OUTCOMES,
    temperatures: DEFAULT_TEMPERATURES,
    lists: DEFAULT_LISTS,
    leadFields: DEFAULT_LEAD_FIELDS,
    customFields: [],
    workflows: DEFAULT_WORKFLOWS,
    permissions: DEFAULT_PERMISSIONS,
    alerts: DEFAULT_ALERTS,
    general: DEFAULT_GENERAL,
    messaging: DEFAULT_MESSAGING,
    dashboard: DEFAULT_DASHBOARD,
  }));
}

// Sections that can be saved independently from the editor.
const SECTIONS = [
  "modules", "statuses", "outcomes", "temperatures", "lists", "leadFields",
  "customFields", "workflows", "permissions", "alerts", "general", "messaging", "dashboard",
];

// Sections stored as ARRAYS (replaced wholesale on save, not deep-merged).
const ARRAY_SECTIONS = new Set(["statuses", "outcomes", "temperatures", "customFields"]);

module.exports = {
  PALETTE,
  STATUS_CATEGORIES,
  OUTCOME_BEHAVIOURS,
  FOLLOWUP_RULES,
  OUTCOME_GROUPS,
  CUSTOM_FIELD_TYPES,
  MODULE_CATALOG,
  NAV_ONLY_MODULE_KEYS,
  SECTIONS,
  ARRAY_SECTIONS,
  buildDefaults,
};
