// services/addonReceiptService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Sends an add-on purchase/activation receipt email to the CUSTOMER (the company
// that bought the add-on), mirroring how plan payments email an invoice.
//
// Recipients:
//   • the company's registered email (Company.email)
//   • every super_admin Admin on that company
// De-duplicated by email. Never throws — a receipt failure must not break the
// purchase/grant flow (the add-on is already active and the Payment row exists).
//
// Used by:
//   • controllers/addonPaymentController.js  (Razorpay self-serve purchase)
//   • controllers/addonController.js          (developer purchase / grant)
// ─────────────────────────────────────────────────────────────────────────────

const Company = require("../models/Company");
const Admin   = require("../models/Admin");
const { sendEmail }        = require("../utils/brevoMailer");
const { addonInvoiceEmail } = require("../utils/emailTemplates");

/**
 * @param {Object} opts
 * @param {string|ObjectId} opts.companyId
 * @param {string}  opts.addonName
 * @param {number} [opts.quantity=1]
 * @param {string} [opts.billing="one_time"]
 * @param {Date|string|null} [opts.expiryDate=null]
 * @param {"purchase"|"grant"} [opts.actionType="purchase"]
 * @param {string|null} [opts.invoiceId=null]
 * @param {number|null} [opts.amount=null]   — INR (0/null = free/granted, no amount block)
 * @param {string|null} [opts.transactionId=null]
 * @param {Date|string|null} [opts.paymentDate=null]
 */
async function sendAddonReceipt(opts = {}) {
  try {
    const {
      companyId,
      addonName     = "Add-on",
      quantity      = 1,
      billing       = "one_time",
      expiryDate    = null,
      actionType    = "purchase",
      invoiceId     = null,
      amount        = null,
      transactionId = null,
      paymentDate   = null,
    } = opts;

    if (!companyId) return;

    const company = await Company.findById(companyId).select("name email").lean();
    if (!company) return;

    const dashboardUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/billing`
      : "https://app.skyupcrm.com/billing";

    // Build the recipient set: company email + its super_admins.
    const recipients = [];
    const seen = new Set();

    const pushRecipient = (email, name) => {
      if (!email) return;
      const key = String(email).trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      recipients.push({ email: String(email).trim(), name: name || "Admin" });
    };

    pushRecipient(company.email, company.name);

    try {
      const admins = await Admin.find({ company: companyId, role: "super_admin" })
        .select("email name")
        .lean();
      for (const a of admins) pushRecipient(a.email, a.name);
    } catch (e) {
      console.error("[addonReceipt] admin lookup failed:", e.message);
    }

    if (recipients.length === 0) return;

    for (const r of recipients) {
      const mail = addonInvoiceEmail({
        recipientName: r.name,
        recipientRole: "customer",
        companyName:   company.name,
        companyEmail:  company.email || "",
        addonName,
        quantity,
        billing,
        expiryDate,
        actionType,
        invoiceId,
        amount,
        transactionId,
        paymentDate,
        dashboardUrl,
      });
      try {
        await sendEmail({ to: r.email, toName: r.name, ...mail });
      } catch (e) {
        console.error(`[addonReceipt] send failed for ${r.email}:`, e.message);
      }
    }

    console.log(`[addonReceipt] Sent ${actionType} receipt for "${addonName}" to ${recipients.length} recipient(s).`);
  } catch (err) {
    console.error("[addonReceipt] unexpected error:", err.message);
  }
}

module.exports = { sendAddonReceipt };
