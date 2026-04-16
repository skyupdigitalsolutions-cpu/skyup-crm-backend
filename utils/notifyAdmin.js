const axios = require("axios");

const notifyAdmin = async (lead, source = "") => {
  try {
    const token    = process.env.WHATSAPP_TOKEN;
    const phoneId  = process.env.WHATSAPP_PHONE_ID;
    const toNumber = process.env.ADMIN_WHATSAPP_NUMBER;

    if (!token || !phoneId || !toNumber) {
      console.warn("⚠️ WhatsApp env vars missing — skipping notify");
      return;
    }

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

    const message =
      `🔔 *New Lead Alert!*\n\n` +
      `👤 *Name:*     ${lead.name}\n` +
      `📱 *Mobile:*   ${lead.mobile}\n` +
      `📧 *Email:*    ${lead.email || "N/A"}\n` +
      `📢 *Campaign:* ${lead.campaign || source || "N/A"}\n` +
      `🌐 *Source:*   ${lead.source || source || "N/A"}\n` +
      `🕐 *Time:*     ${time}`;

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: toNumber,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ WhatsApp alert sent for lead: "${lead.name}" (${lead.mobile})`);
  } catch (err) {
    console.error("❌ WhatsApp notify failed (non-fatal):", err.response?.data || err.message);
  }
};

// No init needed — just export notifyAdmin
module.exports = { notifyAdmin };