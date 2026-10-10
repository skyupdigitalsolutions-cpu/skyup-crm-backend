// services/marketing/dictionary.js
// Single source of truth for every metric shown on the Performance Marketing
// dashboard. Served to the frontend (tooltips) via GET /v2/dictionary and fed
// to the AI analysis so marketers, developers and the AI use ONE definition.
//
// kind: "optimization" — decides where money goes
//       "diagnostic"   — explains WHY performance changed
//       "volume"       — counts
// better: "up" | "down" | "neutral" — which direction is good (drives colour)

const DICTIONARY = {
  spend:        { label: "Spend", kind: "volume", better: "neutral", format: "inr", definition: "Ad spend reported by the ad platforms (Meta + Google) for the selected period.", formula: "Σ platform spend" },
  leads:        { label: "Leads", kind: "volume", better: "up", format: "num", definition: "Unique CRM leads created in the period (merged duplicates excluded). Lead date = record creation time (IST).", formula: "count(CRM leads)" },
  paidLeads:    { label: "Paid Leads", kind: "volume", better: "up", format: "num", definition: "CRM leads attributed to a paid channel (Meta, Google, LinkedIn).", formula: "count(leads where channel is paid)" },
  platformLeads:{ label: "Platform Leads", kind: "diagnostic", better: "up", format: "num", definition: "Leads/conversions as reported by the ad platform itself. Can differ from CRM leads (duplicates, test leads, tracking gaps).", formula: "Meta 'lead' action / Google conversions" },
  contacted:    { label: "Contacted", kind: "volume", better: "up", format: "num", definition: "Leads where a salesperson actually connected (a call outcome that counts as connected, a meeting, or a later stage).", formula: "count(stage ≥ Contacted)" },
  qualified:    { label: "Qualified Leads", kind: "optimization", better: "up", format: "num", definition: "Sales confirmed requirement + fit: marked Hot / Interested / Qualified, or progressed to Meeting, Proposal or Won.", formula: "count(stage ≥ Qualified)" },
  opportunities:{ label: "Opportunities", kind: "optimization", better: "up", format: "num", definition: "Genuine sales opportunity: a discovery meeting/demo happened (or a proposal / win).", formula: "count(stage ≥ Meeting)" },
  won:          { label: "Won Customers", kind: "optimization", better: "up", format: "num", definition: "Commercial agreement / purchase confirmed (status in a 'won' category). Not the same as a marketing 'conversion'.", formula: "count(stage = Won)" },
  revenue:      { label: "Revenue", kind: "optimization", better: "up", format: "inr", definition: "Deal value of won leads. Uses the lead's recorded deal value; when missing, the configured default/average deal value is used and marked 'estimated'.", formula: "Σ dealValue (won)" },
  roas:         { label: "ROAS", kind: "optimization", better: "up", format: "x", definition: "Return on ad spend.", formula: "Attributed Revenue ÷ Ad Spend" },
  cpl:          { label: "CPL", kind: "diagnostic", better: "down", format: "inr", definition: "Cost per lead. On Overview: paid spend ÷ leads from paid channels (organic leads excluded from the denominator).", formula: "Ad Spend ÷ Paid CRM Leads" },
  cpql:         { label: "CPQL", kind: "optimization", better: "down", format: "inr", definition: "Cost per qualified lead.", formula: "Ad Spend ÷ Qualified Leads" },
  costPerOpp:   { label: "Cost / Opportunity", kind: "optimization", better: "down", format: "inr", definition: "Cost per genuine sales opportunity.", formula: "Ad Spend ÷ Opportunities" },
  cac:          { label: "CAC", kind: "optimization", better: "down", format: "inr", definition: "Customer acquisition cost (ad spend only).", formula: "Ad Spend ÷ Won Customers" },
  qualRate:     { label: "Lead → Qualified", kind: "optimization", better: "up", format: "pct", definition: "Share of leads that became qualified.", formula: "Qualified ÷ Leads" },
  oppRate:      { label: "Opportunity %", kind: "optimization", better: "up", format: "pct", definition: "Share of qualified leads that became opportunities.", formula: "Opportunities ÷ Qualified" },
  qualToWon:    { label: "Qualified → Sale", kind: "optimization", better: "up", format: "pct", definition: "Share of qualified leads that were won.", formula: "Won ÷ Qualified" },
  leadToWon:    { label: "Lead → Sale", kind: "optimization", better: "up", format: "pct", definition: "Share of all leads that were won.", formula: "Won ÷ Leads" },
  leadValue:    { label: "Lead Value", kind: "optimization", better: "up", format: "inr", definition: "Average revenue generated per lead.", formula: "Revenue ÷ Leads" },
  qualLeadValue:{ label: "Qualified Lead Value", kind: "optimization", better: "up", format: "inr", definition: "Average revenue per qualified lead.", formula: "Revenue ÷ Qualified Leads" },
  impressions:  { label: "Impressions", kind: "diagnostic", better: "neutral", format: "num", definition: "Times ads were shown.", formula: "platform impressions" },
  reach:        { label: "Reach", kind: "diagnostic", better: "neutral", format: "num", definition: "Unique people who saw the ads (Meta).", formula: "platform reach" },
  frequency:    { label: "Frequency", kind: "diagnostic", better: "down", format: "dec", definition: "Average times each person saw the ad. Rising frequency with falling CTR suggests creative fatigue.", formula: "Impressions ÷ Reach" },
  cpm:          { label: "CPM", kind: "diagnostic", better: "down", format: "inr", definition: "Cost per 1,000 impressions.", formula: "Spend ÷ Impressions × 1000" },
  linkClicks:   { label: "Link Clicks", kind: "diagnostic", better: "up", format: "num", definition: "Clicks that went to the destination (website / form). Excludes likes, profile clicks, etc.", formula: "inline link clicks" },
  ctr:          { label: "CTR (all)", kind: "diagnostic", better: "up", format: "pct", definition: "All clicks ÷ impressions — includes non-website interactions on Meta. Prefer Link CTR.", formula: "Clicks ÷ Impressions" },
  linkCtr:      { label: "Link CTR", kind: "diagnostic", better: "up", format: "pct", definition: "Link clicks ÷ impressions. Low = creative / message problem.", formula: "Link Clicks ÷ Impressions" },
  cpc:          { label: "CPC", kind: "diagnostic", better: "down", format: "inr", definition: "Cost per link click (Meta) / per click (Google).", formula: "Spend ÷ Link Clicks" },
  lpv:          { label: "Landing Page Views", kind: "diagnostic", better: "up", format: "num", definition: "Link clicks where the landing page actually loaded (Meta pixel). Low LPV ÷ clicks = slow site or broken tracking.", formula: "Meta landing_page_view" },
  lpvRate:      { label: "Click → Landing Page", kind: "diagnostic", better: "up", format: "pct", definition: "Share of link clicks that loaded the landing page.", formula: "LPV ÷ Link Clicks" },
  lpvToLead:    { label: "Landing Page → Lead", kind: "diagnostic", better: "up", format: "pct", definition: "Landing-page conversion rate. Low = landing page / offer problem.", formula: "Leads ÷ LPV" },
  responseTime: { label: "Response Time", kind: "diagnostic", better: "down", format: "min", definition: "Time from lead creation to the first real contact attempt by a salesperson.", formula: "first call − lead created" },
};

// The diagnostic sequence that drives the dashboard (Impression → Customer).
const DIAGNOSTIC_RULES = [
  { when: "High impressions + low Link CTR", means: "Creative / message problem" },
  { when: "High link clicks + low LPV",      means: "Website speed or tracking issue" },
  { when: "High LPV + low lead conversion",  means: "Landing page / offer problem" },
  { when: "High leads + low qualified rate", means: "Targeting / offer / lead-form quality problem" },
  { when: "High qualified + low sales",      means: "Sales process / pricing / follow-up issue" },
];

const LOST_REASONS = [
  "Budget too low", "Price objection", "Looking for job", "Student/research enquiry", "Wrong service",
  "Spam", "Duplicate", "Unable to contact", "No current requirement", "Competitor selected",
  "Timeline mismatch", "Outside service geography", "Invalid contact", "Other",
];

const STAGES = [
  { key: "new",               label: "New",                order: 0 },
  { key: "contact_attempted", label: "Contact Attempted",  order: 1 },
  { key: "contacted",         label: "Contacted",          order: 2 },
  { key: "qualified",         label: "Qualified",          order: 3 },
  { key: "meeting",           label: "Discovery / Meeting",order: 4 },
  { key: "proposal",          label: "Proposal Sent",      order: 5 },
  { key: "negotiation",       label: "Negotiation",        order: 6 },
  { key: "won",               label: "Won",                order: 7 },
];

module.exports = { DICTIONARY, DIAGNOSTIC_RULES, LOST_REASONS, STAGES };
