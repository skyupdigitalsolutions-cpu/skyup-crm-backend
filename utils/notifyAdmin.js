// utils/notifyAdmin.js
// Sends a WhatsApp message to admin's real WhatsApp number
// whenever a new lead is created — from ANY source.
//
// Uses whatsapp-web.js which connects via WhatsApp Web (QR scan).
// One-time QR scan → stays logged in permanently via saved session.

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

let client = null;
let isReady = false;
let isInitializing = false;

// ── Initialize WhatsApp client ────────────────────────────────────────────────
// Called once when server starts (from server.js).
// The session is saved to .wwebjs_auth/ folder automatically.
// After first QR scan it never asks again — even after server restarts.
const initWhatsApp = () => {
  if (isInitializing || isReady) return;
  isInitializing = true;

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: ".wwebjs_auth", // session saved here — don't delete this folder
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  });

  // ── QR Code — scan this ONCE with your WhatsApp ───────────────────────────
  client.on("qr", (qr) => {
    console.log("\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📱  WHATSAPP SETUP — SCAN QR CODE BELOW");
    console.log("    Open WhatsApp → Linked Devices → Link a Device");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    qrcode.generate(qr, { small: true });
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("⚠️   Scan within 20 seconds. This only happens ONCE.");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  });

  // ── Ready ─────────────────────────────────────────────────────────────────
  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    console.log("✅ WhatsApp client ready — lead notifications active!");
  });

  // ── Session restored (no QR needed on restart) ────────────────────────────
  client.on("authenticated", () => {
    console.log("🔐 WhatsApp session restored from saved auth");
  });

  // ── Disconnected ──────────────────────────────────────────────────────────
  client.on("disconnected", (reason) => {
    console.warn("⚠️  WhatsApp disconnected:", reason);
    isReady = false;
    isInitializing = false;
    // Auto-reconnect after 10 seconds
    console.log("🔄 Reconnecting WhatsApp in 10 seconds...");
    setTimeout(() => initWhatsApp(), 10000);
  });

  client.initialize().catch((err) => {
    console.error("❌ WhatsApp init error:", err.message);
    isInitializing = false;
  });
};

// ── Send WhatsApp notification to admin ───────────────────────────────────────
// Call this after every Lead.create() in any controller/webhook.
//
//   notifyAdmin(lead, "Meta Campaign")
//   notifyAdmin(lead, "Google Ads")
//   notifyAdmin(lead, "Website Form")
//   notifyAdmin(lead, "Manual")
//
const notifyAdmin = async (lead, source = "") => {
  try {
    // Silently skip if WhatsApp not configured
    const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER;
    if (!adminNumber) {
      console.warn("⚠️  ADMIN_WHATSAPP_NUMBER not set in .env — skipping WhatsApp notify");
      return;
    }

    if (!isReady || !client) {
      console.warn("⚠️  WhatsApp not ready yet — lead notify skipped for:", lead.name);
      return;
    }

    // Format: 91XXXXXXXXXX@c.us  (country code + number, no +, no spaces)
    const chatId = `${adminNumber}@c.us`;

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day:    "2-digit",
      month:  "short",
      year:   "numeric",
      hour:   "2-digit",
      minute: "2-digit",
    });

    const message =
      `🔔 *New Lead Alert!*\n\n` +
      `👤 *Name:*     ${lead.name}\n` +
      `📱 *Mobile:*   ${lead.mobile}\n` +
      `📧 *Email:*    ${lead.email || "N/A"}\n` +
      `📢 *Campaign:* ${lead.campaign || source || "N/A"}\n` +
      `🌐 *Source:*   ${lead.source || source || "N/A"}\n` +
      `🕐 *Time:*     ${time}`;

    await client.sendMessage(chatId, message);
    console.log(`✅ WhatsApp alert sent to admin for lead: "${lead.name}" (${lead.mobile})`);
  } catch (err) {
    // NEVER crash the server — just log
    console.error("❌ WhatsApp notify failed (non-fatal):", err.message);
  }
};

module.exports = { initWhatsApp, notifyAdmin };
