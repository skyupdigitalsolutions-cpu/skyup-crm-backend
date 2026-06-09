#!/usr/bin/env node
/**
 * wa-template-diagnose.js  (no dependencies — uses built-in fetch, Node 18+)
 * ------------------------------------------------------------------
 * Fires the EXACT same template request your CRM backend sends, with
 * your real credentials, and prints the raw provider response so you
 * can see precisely why you get a 404.
 *
 * HOW TO RUN:
 *   1. Fill in the CONFIG block below (just type your values between the quotes).
 *   2. Save the file.
 *   3. From the backend folder run:   node scripts\wa-template-diagnose.js
 */

// ════════════════════════ EDIT ME ════════════════════════════════
const CONFIG = {
  provider: "msg91",                  // "msg91" or "meta"

  // recipient + template (both providers)
  to:           "91XXXXXXXXXX",       // <-- the number you tried to re-engage, digits only, with country code
  templateName: "crm_followup_leads",
  lang:         "en",                 // MUST match the approved template exactly (e.g. "en" vs "en_US")

  // ── MSG91 fields (fill these if provider is "msg91") ──
  msg91AuthKey:          "PASTE_YOUR_AUTH_KEY",
  msg91IntegratedNumber: "919876543210",   // your WhatsApp sender number
  msg91Namespace:        "",                // optional — leave blank if you don't have one

  // ── Meta fields (fill these only if provider is "meta") ──
  metaPhoneNumberId: "",
  metaAccessToken:   "",
  metaGraphVersion:  "v21.0",
};
// ══════════════════════════════════════════════════════════════════

const provider = (CONFIG.provider || "msg91").toLowerCase();
const to = String(CONFIG.to || "").replace(/\D/g, "");
const templateName = CONFIG.templateName || "crm_followup_leads";
const lang = CONFIG.lang || "en";

function die(msg) { console.error("\u2717 " + msg); process.exit(1); }

if (typeof fetch !== "function") {
  die("This Node version has no built-in fetch. Use Node 18 or newer (you have v24, so this is fine).");
}
if (!to || to.includes("XXXX")) die("Edit CONFIG.to with the real recipient number (digits only, with country code, e.g. 919876543210).");

async function post(url, headers, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, statusText: res.statusText, contentType: res.headers.get("content-type") || "(none)", raw, parsed };
}

function report(url, result) {
  const ok = result.status >= 200 && result.status < 300;
  console.log("\n-------------- RESULT: " + (ok ? "SUCCESS" : "ERROR") + " --------------");
  console.log("HTTP status :", result.status, result.statusText);
  console.log("Request URL :", url);
  console.log("Content-Type:", result.contentType);
  console.log("Response body:");
  console.log(result.parsed ? JSON.stringify(result.parsed, null, 2) : result.raw.slice(0, 2000));

  if (result.status === 404) {
    const hasJsonMsg = result.parsed && (result.parsed.message || result.parsed.error);
    console.log("\n-> Interpretation:");
    if (!hasJsonMsg) {
      console.log("  404 with a NON-JSON / empty body = the provider gateway rejected the URL PATH.");
      console.log("  Likely: the endpoint changed/was deprecated, or your auth key / account");
      console.log("  isn't provisioned for this route. Confirm the current WhatsApp endpoint in");
      console.log("  the MSG91 dashboard/docs and that the auth key has WhatsApp access.");
    } else {
      console.log("  404 WITH a JSON message usually = template name/language not found for this");
      console.log("  account. Check the message above, and make sure the template + language");
      console.log("  match the APPROVED template EXACTLY (e.g. 'en' vs 'en_US').");
    }
  }
  console.log("------------------------------------------------\n");
}

async function runMsg91() {
  const authKey = CONFIG.msg91AuthKey;
  const senderNumber = CONFIG.msg91IntegratedNumber;
  const namespace = CONFIG.msg91Namespace || "";
  if (!authKey || authKey.includes("PASTE") || !senderNumber) die("Fill CONFIG.msg91AuthKey and CONFIG.msg91IntegratedNumber.");

  const url = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
  const payload = {
    integrated_number: senderNumber,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: templateName,
        language: { code: lang, policy: "deterministic" },
        ...(namespace ? { namespace } : {}),
        to_and_components: [{ to: [to], components: {} }],
      },
    },
  };
  console.log("Provider  : MSG91");
  console.log("Endpoint  :", url);
  console.log("Namespace :", namespace || "(none)");
  console.log("Payload   :", JSON.stringify(payload, null, 2));
  report(url, await post(url, { authkey: authKey, accept: "application/json" }, payload));
}

async function runMeta() {
  const phoneNumberId = CONFIG.metaPhoneNumberId;
  const accessToken = CONFIG.metaAccessToken;
  const version = CONFIG.metaGraphVersion || "v21.0";
  if (!phoneNumberId || !accessToken) die("Fill CONFIG.metaPhoneNumberId and CONFIG.metaAccessToken.");

  const url = "https://graph.facebook.com/" + version + "/" + phoneNumberId + "/messages";
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: templateName, language: { code: lang } },
  };
  console.log("Provider  : Meta Cloud API");
  console.log("Endpoint  :", url);
  console.log("Payload   :", JSON.stringify(payload, null, 2));
  report(url, await post(url, { Authorization: "Bearer " + accessToken }, payload));
}

(async () => {
  console.log("=== WhatsApp template send diagnostic ===");
  console.log("To        :", to);
  console.log("Template  :", templateName);
  console.log("Language  :", lang);
  try {
    if (provider === "meta") await runMeta();
    else await runMsg91();
  } catch (err) {
    console.log("\n-------------- RESULT: NETWORK ERROR --------------");
    console.log("No HTTP response (DNS/timeout/connection). Message:", err.message);
    console.log("---------------------------------------------------\n");
    process.exit(2);
  }
})();