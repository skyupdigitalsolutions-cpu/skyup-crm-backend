// utils/msg91Mailer.js
// Sends transactional/bulk emails via MSG91 Email API.
// MSG91 Email API docs: https://docs.msg91.com/email
// Daily limit per company: MSG91_EMAIL_DAILY_LIMIT (default 5000).
// When the limit is reached, the caller should fall back to Brevo.

const axios = require("axios");
const Company = require("../models/Company");

const MSG91_EMAIL_DAILY_LIMIT = 5000;

/**
 * Get today's UTC date string "YYYY-MM-DD"
 */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if this company has reached the MSG91 daily email limit.
 * Resets the counter automatically if the stored date is not today.
 *
 * @param {ObjectId|string} companyId
 * @returns {{ remaining: number, company: Object }}
 */
async function getRemainingQuota(companyId) {
  const company = await Company.findById(companyId)
    .select("+msg91EmailApiKey msg91EmailDomain msg91EmailSenderEmail msg91EmailSenderName msg91EmailDailyCount msg91EmailCountDate")
    .lean();

  if (!company) throw new Error("Company not found");

  const today = todayUTC();
  let count = company.msg91EmailDailyCount || 0;

  // Auto-reset counter if last record was a different day
  if (company.msg91EmailCountDate !== today) {
    count = 0;
    // We'll persist the reset when we actually send
  }

  const remaining = Math.max(0, MSG91_EMAIL_DAILY_LIMIT - count);
  return { remaining, company, countedToday: count, today };
}

/**
 * Increment the MSG91 daily send counter for this company.
 *
 * @param {ObjectId|string} companyId
 * @param {number} sentCount   number of emails just sent
 * @param {string} today       "YYYY-MM-DD" UTC string
 * @param {number} currentCount  the count before this batch
 */
async function incrementQuota(companyId, sentCount, today, currentCount) {
  const newCount = currentCount + sentCount;
  await Company.findByIdAndUpdate(companyId, {
    msg91EmailDailyCount: newCount,
    msg91EmailCountDate:  today,
  });
}

/**
 * Send a single transactional email via MSG91.
 *
 * MSG91 Email uses a different API than Brevo — it is essentially a
 * reseller of AWS SES / SparkPost under the hood and has its own REST API.
 *
 * Required company fields:
 *   msg91EmailApiKey, msg91EmailDomain, msg91EmailSenderEmail
 *
 * @param {{ to, toName, subject, html, fromName, companyId }} params
 * @throws if MSG91 is not configured for the company
 */
async function sendViaMsg91Email({ to, toName, subject, html, fromName, company }) {
  const apiKey      = company.msg91EmailApiKey;
  const domain      = company.msg91EmailDomain;
  const fromEmail   = company.msg91EmailSenderEmail;
  const dbFromName  = fromName || company.msg91EmailSenderName || "CRM";

  if (!apiKey || !fromEmail || !domain) {
    throw new Error(
      "MSG91 Email is not fully configured. Please set Auth Key, domain, and sender email in Integrations → Email."
    );
  }

  // MSG91 Email API endpoint
  // POST https://api.msg91.com/api/v5/email/send
  // Headers: authkey: <API_KEY>
  // Body (JSON):
  // {
  //   "to":      [{ "email": "recipient@example.com", "name": "Name" }],
  //   "from":    { "email": "sender@yourdomain.com", "name": "SkyUp CRM" },
  //   "domain":  "yourdomain.com",
  //   "subject": "Hello World",
  //   "bodyHtml":"<p>...</p>"
  // }

  await axios.post(
    "https://api.msg91.com/api/v5/email/send",
    {
      to:       [{ email: to, name: toName || to }],
      from:     { email: fromEmail, name: dbFromName },
      domain:   domain,
      subject,
      bodyHtml: html,
    },
    {
      headers: {
        authkey:        apiKey,
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Check whether MSG91 Email is configured and has remaining quota.
 *
 * @param {ObjectId|string} companyId
 * @returns {{ configured: boolean, remaining: number, company: Object }}
 */
async function checkMsg91EmailStatus(companyId) {
  try {
    const { remaining, company, countedToday, today } = await getRemainingQuota(companyId);
    const configured = !!(company.msg91EmailApiKey && company.msg91EmailSenderEmail && company.msg91EmailDomain);
    return { configured, remaining, company, countedToday, today };
  } catch {
    return { configured: false, remaining: 0, company: null, countedToday: 0, today: todayUTC() };
  }
}

module.exports = {
  sendViaMsg91Email,
  checkMsg91EmailStatus,
  incrementQuota,
  getRemainingQuota,
  MSG91_EMAIL_DAILY_LIMIT,
};