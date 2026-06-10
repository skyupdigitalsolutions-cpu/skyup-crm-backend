// utils/msg91Probe.js
// ─────────────────────────────────────────────────────────────────────────────
// One-off discovery helper. Runs ON your server (which can reach MSG91 and holds
// the authkey) and tries to find an MSG91 API that returns WhatsApp message logs
// using the transactional authkey. Lets us discover the correct logs endpoint
// without fishing in the browser Network tab.
//
// Usage (gated by WEBHOOK_DEBUG_KEY):
//   /msg91-webhook/_probe/logs?key=KEY
//     → tries a set of candidate endpoints, returns status + sample for each.
//   /msg91-webhook/_probe/logs?key=KEY&url=<ENCODED_URL>&method=GET
//     → tests one specific endpoint you got from MSG91 support / Network tab,
//       so you can confirm it works WITHOUT a redeploy.
//
// Whatever endpoint returns the rows containing {"text":"..."} is the one to put
// in MSG91_LOGS_API_URL for the poll job.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const WhatsAppConfig = require("../models/WhatsAppConfig");

function sample(data) {
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return s.length > 1200 ? s.slice(0, 1200) + "…(truncated)" : s;
  } catch {
    return String(data);
  }
}

async function tryRequest(method, url, headers, body) {
  const started = Date.now();
  try {
    const resp =
      method === "GET"
        ? await axios.get(url, { headers, timeout: 15000, validateStatus: () => true })
        : await axios.post(url, body, { headers, timeout: 15000, validateStatus: () => true });
    return {
      method,
      url,
      status: resp.status,
      ms: Date.now() - started,
      looksLikeLogs: /"text"\s*:/.test(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || "")),
      sample: sample(resp.data),
    };
  } catch (err) {
    return { method, url, status: "ERROR", ms: Date.now() - started, error: err.message };
  }
}

async function probeLogsApi({ overrideUrl, overrideMethod } = {}) {
  const config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true })
    .select("+msg91AuthKey msg91IntegratedNumber")
    .lean();

  if (!config || !config.msg91AuthKey) {
    return { error: "No active MSG91 config with an authkey found." };
  }

  const authkey = config.msg91AuthKey;
  const num = config.msg91IntegratedNumber;
  const headers = { authkey, "Content-Type": "application/json" };
  const results = [];

  // 1) If you pass an explicit URL, test ONLY that (fast confirm path).
  if (overrideUrl) {
    const method = (overrideMethod || "GET").toUpperCase();
    results.push(await tryRequest(method, overrideUrl, headers, { integrated_number: num }));
    return { integratedNumber: num, tested: results };
  }

  // 2) Otherwise try a set of best-guess MSG91 WhatsApp report/log endpoints.
  //    These are guesses — the goal is to find which (if any) returns the rows.
  const candidates = [
    ["POST", "https://control.msg91.com/api/v5/whatsapp/report/", { integrated_number: num }],
    ["GET",  `https://control.msg91.com/api/v5/whatsapp/report/?integrated_number=${num}`],
    ["POST", "https://control.msg91.com/api/v5/whatsapp/getReport/", { integrated_number: num }],
    ["POST", "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/report/", { integrated_number: num }],
    ["GET",  `https://control.msg91.com/api/v5/whatsapp/logs/?integrated_number=${num}`],
    ["POST", "https://control.msg91.com/api/v5/report/", { integrated_number: num, type: "whatsapp" }],
  ];

  for (const [method, url, body] of candidates) {
    results.push(await tryRequest(method, url, headers, body));
  }

  return {
    integratedNumber: num,
    note: "Look for an entry with looksLikeLogs:true — that URL goes in MSG91_LOGS_API_URL. If none, ask MSG91 for their 'fetch WhatsApp message logs by authkey' API, then re-test with ?url=...",
    tested: results,
  };
}

module.exports = { probeLogsApi };