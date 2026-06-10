// jobs/msg91InboundPollJob.js
// ─────────────────────────────────────────────────────────────────────────────
// PULL-based inbound for MSG91 WhatsApp.
//
// MSG91 is NOT firing its inbound webhook (Webhook Logs show "Nothing Here"),
// so customer replies never get POSTed to our server. As a workaround, this job
// periodically PULLS the message logs from MSG91's API, picks out the inbound
// ones (the lead's replies), and feeds each through the SAME ingestion code the
// webhook uses (processMSG91Payload with forceInbound). The result: a pulled
// reply is saved as a direction:"inbound" message and pushed to the CRM UI over
// Socket.io exactly like a normal lead reply. Dedup is by waMessageId, so the
// same reply is never inserted twice no matter how often we poll.
//
// CONFIG (Render → Environment):
//   MSG91_LOGS_API_URL      (required)  Endpoint that returns WhatsApp logs/messages.
//                                       This is the API the MSG91 "Logs" page calls.
//   MSG91_LOGS_API_METHOD   (optional)  "GET" or "POST". Default "POST".
//   MSG91_LOGS_API_BODY     (optional)  JSON string sent as the POST body (filters).
//                                       Use {{integrated_number}} as a placeholder.
//   MSG91_POLL_SECONDS      (optional)  Poll interval in seconds. Default 30.
//   MSG91_LOGS_LOOKBACK_MIN (optional)  Ignore rows older than this many minutes. Default 60.
//
// Auth uses each company's stored msg91AuthKey (same key used for sending) — no
// new secret needed.
// ─────────────────────────────────────────────────────────────────────────────

const cron = require("node-cron");
const axios = require("axios");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const { processMSG91Payload } = require("../controllers/msg91WebhookController");

const POLL_SECONDS   = parseInt(process.env.MSG91_POLL_SECONDS || "30", 10);
const LOOKBACK_MIN   = parseInt(process.env.MSG91_LOGS_LOOKBACK_MIN || "60", 10);
const LOGS_API_URL   = process.env.MSG91_LOGS_API_URL || "";
const LOGS_API_METHOD = (process.env.MSG91_LOGS_API_METHOD || "POST").toUpperCase();

// ── helpers ───────────────────────────────────────────────────────────────────
function firstVal(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// MSG91 logs API wraps every field as { value: "...", metaData: null }.
// This unwraps the entire row so downstream code sees plain strings/numbers.
// Example input:  { customerNumber: { value: "919876543210", metaData: null } }
// Example output: { customerNumber: "919876543210" }
function flattenRow(row) {
  if (!row || typeof row !== "object") return row;
  const flat = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && "value" in v && !Array.isArray(v) && Object.keys(v).length <= 2) {
      flat[k] = v.value; // unwrap { value: "...", metaData: null }
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

// Find the array of log rows wherever MSG91 nests it.
function extractRows(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp.map(flattenRow);
  const candidates = [
    resp.data, resp.logs, resp.messages, resp.result, resp.results, resp.records,
    resp.data && resp.data.logs, resp.data && resp.data.data,
    resp.data && resp.data.records, resp.data && resp.data.messages,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c.map(flattenRow);
  return [];
}

// Decide whether a log row is an inbound message from the customer (the lead).
// MSG91 logs API returns direction as "INBOUND" or "OUTBOUND" text (after flattenRow unwraps it).
// Also handles numeric "1"/"0" for robustness.
function isInboundRow(row, integratedNumber) {
  const dirRaw = firstVal(row, "direction", "Direction");
  if (dirRaw !== undefined && dirRaw !== null && dirRaw !== "") {
    const dirStr = String(dirRaw).trim().toUpperCase();
    // Text values from MSG91 logs UI
    if (dirStr === "INBOUND") return true;
    if (dirStr === "OUTBOUND") return false;
    // Numeric values (some API variants)
    if (dirStr === "1") return true;
    if (dirStr === "0") return false;
    // Partial match
    if (dirStr.includes("IN")) return true;
    if (dirStr.includes("OUT")) return false;
  }

  // Origin field fallback
  const origin = String(firstVal(row, "origin", "Origin", "messageOrigin") || "").toLowerCase();
  if (origin.includes("user") || origin.includes("inbound") || origin.includes("incoming")) return true;
  if (origin.includes("marketing") || origin.includes("utility") || origin.includes("authentication")) return false;

  // Message type fallback — "template" means we sent it (outbound)
  const msgType = String(firstVal(row, "messageType", "message_type", "type") || "").toLowerCase();
  if (msgType === "template") return false;

  // Heuristic: inbound rows have no campaign/template name
  const campaign = firstVal(row, "campaign", "Campaign", "campaignName");
  const template = firstVal(row, "template", "Template", "templateName");
  if (campaign || template) return false; // outbound blast

  return false;
}

function rowTimestamp(row) {
  // MSG91 logs use "requestedAt" for the message timestamp (after flattenRow unwrap)
  const t = firstVal(row, "requestedAt", "sentTime", "ts", "timestamp", "receivedAt", "received_at", "date", "createdAt", "created_at");
  if (!t) return null;
  // MSG91 format: "2026-06-10 14:40:46" — needs parsing
  const d = new Date(isNaN(t) ? t.replace(" ", "T") + "+05:30" : Number(t) * (String(t).length <= 10 ? 1000 : 1));
  return isNaN(d.getTime()) ? null : d;
}

async function fetchLogs(config) {
  const authKey = config.msg91AuthKey;
  const integratedNumber = config.msg91IntegratedNumber;
  if (!authKey) return [];

  const headers = { authkey: authKey, "Content-Type": "application/json" };
  let resp;

  // Build date range: today in IST (MSG91 uses IST dates)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const today = istNow.toISOString().slice(0, 10); // "YYYY-MM-DD"

  if (LOGS_API_METHOD === "GET") {
    resp = await axios.get(LOGS_API_URL, { headers, timeout: 15000 });
  } else {
    let body = {};
    if (process.env.MSG91_LOGS_API_BODY) {
      try {
        body = JSON.parse(
          process.env.MSG91_LOGS_API_BODY.replace(/\{\{integrated_number\}\}/g, integratedNumber || "")
        );
      } catch (e) {
        console.warn("⚠️  MSG91_LOGS_API_BODY is not valid JSON:", e.message);
      }
    } else {
      body = { integratedNumber: integratedNumber };
    }
    // Always set today's date range to limit results.
    // Do NOT filter by direction here — let isInboundRow() handle it locally.
    // MSG91's direction filter causes 0 results; fetch all and filter ourselves.
    delete body.direction;
    body.startDate = today;
    body.endDate = today;
    body.limit = body.limit || 100;
    body.offset = body.offset || 0;

    resp = await axios.post(LOGS_API_URL, body, { headers, timeout: 15000 });
  }
  return extractRows(resp.data);
}

async function pollOnce() {
  if (!LOGS_API_URL) {
    console.warn("⏸  MSG91 inbound poll skipped — set MSG91_LOGS_API_URL to enable it.");
    return;
  }

  // Find active configs by isActive (not a strict provider filter — the provider
  // field may be unset on older records). fetchLogs() skips any without an authkey.
  const configs = await WhatsAppConfig.find({ isActive: true })
    .select("+msg91AuthKey msg91IntegratedNumber company")
    .lean();

  const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;
  let ingested = 0;

  for (const config of configs) {
    let rows = [];
    try {
      rows = await fetchLogs(config);
    } catch (err) {
      console.error(`❌ MSG91 logs fetch failed: ${err.response?.status || ""} ${err.message}`);
      continue;
    }

    console.log(`🔎 MSG91 poll: fetched ${rows.length} rows for ${config.msg91IntegratedNumber}`);
    if (rows.length > 0) {
      // Log first row structure to help debug field mapping
      const sample = rows[0];
      console.log(`   Sample row fields: direction="${sample.direction}" customerNumber="${sample.customerNumber}" text="${String(sample.text||"").slice(0,30)}" requestedAt="${sample.requestedAt}"`);
    }

    for (const row of rows) {
      const isInbound = isInboundRow(row, config.msg91IntegratedNumber);
      console.log(`   Row: direction="${row.direction}" inbound=${isInbound} customer="${row.customerNumber}" text="${String(row.text||row.content||"").slice(0,20)}"`);
      if (!isInbound) continue;

      const ts = rowTimestamp(row);
      if (ts && ts.getTime() < cutoff) continue; // too old — skip

      // Make sure the recipient (our number) is present so config resolution in
      // processMSG91Payload matches the right company.
      if (!firstVal(row, "integratedNumber", "integrated_number", "to")) {
        row.integratedNumber = config.msg91IntegratedNumber;
      }

      try {
        // forceInbound: a log row may carry a read/delivered status for the
        // lead's own message — we must treat it as inbound, not a status report.
        await processMSG91Payload(row, { forceInbound: true });
        ingested++;
      } catch (err) {
        console.error("❌ MSG91 inbound ingest error:", err.message);
      }
    }
  }

  if (ingested) console.log(`📥 MSG91 inbound poll: ingested ${ingested} candidate row(s) (dedup applied)`);
  else console.log(`🔍 MSG91 poll: no new inbound rows found`);
}

function startMsg91InboundPollJob() {
  if (!LOGS_API_URL) {
    console.warn("⏸  MSG91 inbound poll job not started — MSG91_LOGS_API_URL is not set.");
    return;
  }
  // node-cron uses 6-field syntax with seconds when 6 fields are given.
  const everyN = Math.max(10, POLL_SECONDS); // floor at 10s to be gentle
  const expr = `*/${everyN} * * * * *`;
  cron.schedule(expr, () => {
    pollOnce().catch((e) => console.error("MSG91 inbound poll uncaught:", e.message));
  });
  console.log(`🔄 MSG91 inbound poll job started — every ${everyN}s → ${LOGS_API_URL}`);
}

module.exports = { startMsg91InboundPollJob, pollOnce };