// scripts/seedTermsAndConditions.js
// ─────────────────────────────────────────────────────────────────────────────
// Publishes version 1 of the SkyUp CRM Terms & Conditions.
//
// Run:  node scripts/seedTermsAndConditions.js
//
// Idempotent: if version 1 already exists it does nothing. To publish an UPDATE,
// don't edit this script — use the developer endpoint POST /api/terms/admin/publish
// (or add a new script) so the version auto-increments and users are re-prompted.
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const TermsAndConditions = require("../models/TermsAndConditions");

const INTRO =
  "These Terms & Conditions ('Agreement') govern the use of SkyUp CRM provided by SkyUp Digital Solutions. " +
  "By creating an account, subscribing to the Platform, or using any SkyUp CRM services, the Customer agrees to these Terms & Conditions.";

const SECTIONS = [
  { heading: "1. Acceptance of Terms", body: "By accessing or using SkyUp CRM, the Customer confirms that they have read, understood and agreed to these Terms. If using the Platform on behalf of an organization, the user represents that they have authority to bind that organization." },
  { heading: "2. Subscription and Billing", body: "Subscriptions are billed in advance. Fees are generally non-refundable unless required by law or agreed otherwise. Plans may renew automatically unless cancelled. SkyUp may revise pricing with prior notice. Failure to pay may result in suspension or termination." },
  { heading: "3. Customer Data Ownership", body: "All customer business data remains the property of the Customer. SkyUp does not claim ownership of Customer Data." },
  { heading: "4. Customer Responsibilities", body: "Customers are responsible for lawful data collection, obtaining required consents, protecting credentials, assigning permissions, and complying with applicable laws." },
  { heading: "5. Data Privacy and Legal Compliance", body: "Customers shall comply with applicable privacy, consumer protection, telemarketing and electronic communication laws." },
  { heading: "6. Call Recording Consent", body: "Customers are responsible for obtaining legally required consent before recording calls." },
  { heading: "7. AI Processing", body: "AI may transcribe, summarize, analyse communications and automate workflows. AI outputs should be reviewed before business decisions." },
  { heading: "8. Voice Bot and AI Calling", body: "Customers must comply with laws governing automated communications and provide disclosures where legally required." },
  { heading: "9. WhatsApp, SMS and Communication Compliance", body: "Customers are responsible for complying with WhatsApp Business Policies, Meta Policies, TRAI regulations, anti-spam laws, DND regulations and consent requirements." },
  { heading: "10. Third-Party Integrations", body: "Integrations with Meta, Google, WhatsApp, MSG91, Brevo, Razorpay, Cloudinary, AI providers and others are governed by their own terms. SkyUp is not responsible for third-party outages or policy changes." },
  { heading: "11. Employee Responsibilities", body: "Employees shall use the Platform only for authorized business purposes, maintain confidentiality and protect credentials." },
  { heading: "12. User Accounts and Password Security", body: "Each user should have an individual account. Credential sharing is prohibited." },
  { heading: "13. Access Control", body: "Access is restricted according to assigned roles." },
  { heading: "14. Employee Monitoring", body: "The Platform may log login history, IPs, devices, GPS, call activity, exports and administrative actions where enabled. Customers must inform employees as required by law." },
  { heading: "15. Mobile Permissions", body: "The app may request phone, contacts, call logs, storage, camera, microphone, notifications and location permissions only for enabled features." },
  { heading: "16. GPS Tracking", body: "Customers are responsible for notifying employees when GPS attendance or live tracking is enabled." },
  { heading: "17. Audit Logs", body: "Audit logs may be maintained for security, compliance and troubleshooting." },
  { heading: "18. Data Security", body: "SkyUp implements commercially reasonable safeguards but cannot guarantee absolute security." },
  { heading: "19. Data Backup", body: "Reasonable backups may be performed. Customers should maintain their own backups of critical data." },
  { heading: "20. Data Retention", body: "Retention depends on the subscribed plan and configured policies." },
  { heading: "21. Data Export", body: "Customers may export available data during subscription and for up to 30 days after termination, after which data may be deleted." },
  { heading: "22. Confidentiality", body: "Both parties shall maintain confidentiality of proprietary and customer information." },
  { heading: "23. Intellectual Property", body: "All software, source code, branding and documentation remain the property of SkyUp Digital Solutions." },
  { heading: "24. Acceptable Use Policy", body: "Customers shall not reverse engineer, distribute malware, send spam, conduct phishing, misuse AI features or perform unlawful activities." },
  { heading: "25. API Usage", body: "APIs, where available, must be used in accordance with SkyUp documentation and applicable rate limits." },
  { heading: "26. Beta Features", body: "Beta features are provided 'as is' and may change or be withdrawn." },
  { heading: "27. Service Availability", body: "Availability may be affected by maintenance, cloud issues, internet failures or third-party outages. No SLA applies unless separately agreed." },
  { heading: "28. Support Services", body: "Support is provided according to the subscribed support plan." },
  { heading: "29. Security Incident Notification", body: "SkyUp will use commercially reasonable efforts to notify customers of confirmed security incidents affecting Customer Data." },
  { heading: "30. Force Majeure", body: "SkyUp is not liable for delays caused by events beyond reasonable control." },
  { heading: "31. Suspension and Termination", body: "Accounts may be suspended for non-payment, security risks, illegal activities or Terms violations." },
  { heading: "32. Limitation of Liability", body: "SkyUp is not liable for indirect damages, unlawful recordings, consent failures, customer misuse, AI inaccuracies or third-party outages. Liability is limited to fees paid during the preceding 12 months, to the extent permitted by law." },
  { heading: "33. Indemnification", body: "Customers agree to indemnify SkyUp against claims arising from unlawful use, legal violations or misuse of the Platform." },
  { heading: "34. Privacy Policy", body: "Use of the Platform is also governed by the SkyUp CRM Privacy Policy." },
  { heading: "35. Cookies and Analytics", body: "Cookies and analytics may be used for authentication, security and service improvements." },
  { heading: "36. Amendments", body: "SkyUp may update these Terms. Continued use constitutes acceptance of revised Terms." },
  { heading: "37. Governing Law and Jurisdiction", body: "These Terms are governed by the laws of India. Courts at Bengaluru, Karnataka shall have exclusive jurisdiction." },
  { heading: "38. Employee Compliance Acknowledgement", body: "Customers should ensure employees are informed about applicable monitoring, call recording, AI summaries, GPS tracking, audit logs and confidentiality obligations." },
  { heading: "39. Entire Agreement", body: "These Terms, the Privacy Policy, subscription order and any executed service agreement constitute the entire agreement." },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await TermsAndConditions.findOne({ version: 1 });
  if (existing) {
    console.log("✅ Terms version 1 already exists — nothing to do.");
    process.exit(0);
  }

  // Deactivate any active version (defensive — there shouldn't be one yet).
  await TermsAndConditions.updateMany({ isActive: true }, { $set: { isActive: false } });

  await TermsAndConditions.create({
    version:       1,
    title:         "SkyUp CRM – Terms & Conditions",
    effectiveDate: "", // fill in the effective date here when finalised
    intro:         INTRO,
    sections:      SECTIONS,
    isActive:      true,
    publishedAt:   new Date(),
  });

  console.log("✅ Published Terms & Conditions version 1 (active).");
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
