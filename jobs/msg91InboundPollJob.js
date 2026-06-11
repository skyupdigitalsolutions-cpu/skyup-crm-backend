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
// Socket.io exactly like a normal lead reply.
//
// PERFORMANCE FIXES (v2):
//   1. Per-config lastSeenTs cursor  — skips rows already processed, so the
//      per-row waMessageId DB query runs ONLY for rows newer than last seen.
//      Previously every poll re-checked all 66 rows → ~40 DB queries wasted.
//   2. Batch dedup check             — one WhatsAppMessage.find({ waMessageId: {$in: [...]} })
//      instead of N individual findOne calls.
//   3. origin filter removed         — inbound messages have origin="" which
//      is not in the allowed-origins string, causing them to be silently dropped.
//   4. Reduced log noise             — only logs inbound candidates, not all rows.
//
// CONFIG (Render → Environment):
//   MSG91_LOGS_API_URL      (required)  Endpoint that returns WhatsApp logs/messages.
//   MSG91_LOGS_API_METHOD   (optional)  "GET" or "POST". Default "POST".
//   MSG91_LOGS_API_BODY     (optional)  JSON string sent as POST body (filters).
//                                       Use {{integrated_number}} as placeholder.
//   MSG91_POLL_SECONDS      (optional)  Poll interval in seconds. Default 2.
//   MSG91_LOGS_LOOKBACK_MIN (optional)  Ignore rows older than this many minutes. Default 60.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const WhatsAppConfig  = require("../models/WhatsAppConfig");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const { processMSG91Payload } = require("../controllers/msg91WebhookController");

const POLL_SECONDS    = parseInt(process.env.MSG91_POLL_SECONDS || "2", 10);
const LOOKBACK_MIN    = parseInt(process.env.MSG91_LOGS_LOOKBACK_MIN || "60", 10);
const LOGS_API_URL    = process.env.MSG91_LOGS_API_URL || "";
const LOGS_API_METHOD = (process.env.MSG91_LOGS_API_METHOD || "POST").toUpperCase();

// ── Per-config cursor: track the timestamp of the last ingested inbound row.
// Key: config._id.toString()  →  Value: Date object (last ingested message time)
// This lets us skip the waMessageId DB query for rows that are older than
// the most recent message we already processed — eliminating the O(N) query
// storm that caused the 1-minute delay.
const lastSeenTs = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────
function firstVal(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// MSG91 logs API MASKS the customerNumber field with literal "XXX" characters
// e.g. "919538281XXX1" instead of "919538281101".
// Fix: detect XXX-masked numbers and reconstruct the correct number from the
// uuid field, which contains the real number base64-encoded in the wamid.
function decodePhoneFromWamid(uuid) {
  if (!uuid || !uuid.startsWith("wamid.")) return null;
  try {
    const inner = uuid.replace("wamid.", "");
    const decoded = Buffer.from(inner, "base64").toString("binary");
    const match = decoded.match(/\d{10,14}/);
    if (match) return match[0];
    return null;
  } catch {
    return null;
  }
}

function unmaskedCustomerNumber(row) {
  const raw = row.customerNumber || "";
  if (!/[xX]/.test(raw)) return raw; // no masking, use as-is
  const uuid = row.uuid || row.CRQID || "";
  const fromWamid = decodePhoneFromWamid(uuid);
  if (fromWamid) {
    console.log(`🔧 Unmasked ${raw} → ${fromWamid} (from wamid)`);
    return fromWamid;
  }
  console.warn(`⚠️  Skipping row with masked customerNumber "${raw}" and no recoverable uuid`);
  return null;
}

// MSG91 logs API wraps every field as { value: "...", metaData: null }.
function flattenRow(row) {
  if (!row || typeof row !== "object") return row;
  const flat = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && "value" in v && !Array.isArray(v) && Object.keys(v).length <= 2) {
      flat[k] = v.value;
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

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

function isInboundRow(row) {
  const dirRaw = firstVal(row, "direction", "Direction");
  if (dirRaw !== undefined && dirRaw !== null && dirRaw !== "") {
    const dirStr = String(dirRaw).trim().toUpperCase();
    if (dirStr === "INBOUND")  return true;
    if (dirStr === "OUTBOUND") return false;
    if (dirStr === "1")        return true;
    if (dirStr === "0")        return false;
    if (dirStr.includes("IN"))  return true;
    if (dirStr.includes("OUT")) return false;
  }
  const origin = String(firstVal(row, "origin", "Origin", "messageOrigin") || "").toLowerCase();
  if (origin.includes("user") || origin.includes("inbound") || origin.includes("incoming")) return true;
  if (origin.includes("marketing") || origin.includes("utility") || origin.includes("authentication")) return false;

  const msgType = String(firstVal(row, "messageType", "message_type", "type") || "").toLowerCase();
  if (msgType === "template") return false;

  const campaign = firstVal(row, "campaign", "Campaign", "campaignName");
  const template = firstVal(row, "template", "Template", "templateName");
  if (campaign || template) return false;

  return false;
}

function rowTimestamp(row) {
  const t = firstVal(row, "requestedAt", "sentTime", "ts", "timestamp", "receivedAt", "received_at", "date", "createdAt", "created_at");
  if (!t) return null;
  const d = new Date(isNaN(t) ? t.replace(" ", "T") + "+05:30" : Number(t) * (String(t).length <= 10 ? 1000 : 1));
  return isNaN(d.getTime()) ? null : d;
}

function rowMessageId(row) {
  return firstVal(row, "uuid", "id", "messageId", "message_id", "message_uuid", "requestId", "request_id", "wamid") || null;
}

async function fetchLogs(config) {
  const authKey = config.msg91AuthKey || process.env.MSG91_AUTH_KEY || process.env.MSG91_AUTHKEY || "";
  const integratedNumber = config.msg91IntegratedNumber || "";
  if (!authKey) {
    console.warn("⚠️  fetchLogs: no authKey found in DB or env — skipping");
    return [];
  }

  const headers = { authkey: authKey, "Content-Type": "application/json" };
  let resp;

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const today     = istNow.toISOString().slice(0, 10);
  const yesterday = new Date(istNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
      body = { integratedNumber };
    }

    // Remove filters that block inbound messages:
    delete body.direction; // fetch all; filter locally
    delete body.status;    // inbound rows have NO delivery status — this filter excludes them
    // ── CRITICAL: Do NOT send an origin filter ──────────────────────────────
    // Inbound messages have origin="" (empty/blank). The previous code set
    // origin="marketing,utility,user_initiated,..." which does NOT include ""
    // so MSG91 silently filtered out all inbound rows — they never appeared
    // in the response at all. Removing the filter returns everything.
    delete body.origin;

    body.startDate = yesterday;
    body.endDate   = today;
    body.limit     = body.limit || 100;
    body.offset    = body.offset || 0;

    resp = await axios.post(LOGS_API_URL, body, { headers, timeout: 15000 });
  }
  return extractRows(resp.data);
}

async function pollOnce() {
  if (!LOGS_API_URL) {
    console.warn("⏸  MSG91 inbound poll skipped — set MSG91_LOGS_API_URL to enable it.");
    return;
  }

  const configs = await WhatsAppConfig.find({ isActive: true })
    .select("msg91AuthKey msg91IntegratedNumber company provider")
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

    if (!rows.length) continue;

    // ── Filter to inbound rows only before any DB work ────────────────────────
    const inboundRows = rows.filter(row => {
      if (!isInboundRow(row)) return false;
      const ts = rowTimestamp(row);
      if (ts && ts.getTime() < cutoff) return false; // too old
      return true;
    });

    if (!inboundRows.length) continue; // nothing to do for this config

    console.log(`🔎 MSG91 poll: ${rows.length} total rows, ${inboundRows.length} inbound candidate(s) for ${config.msg91IntegratedNumber}`);

    // ── Sort oldest-first so we process in chronological order ───────────────
    inboundRows.sort((a, b) => {
      const ta = rowTimestamp(a); const tb = rowTimestamp(b);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta.getTime() - tb.getTime();
    });

    // ── Skip rows we've already seen using in-memory cursor ──────────────────
    const configKey = config._id.toString();
    const seenAfter = lastSeenTs.get(configKey) || null;

    const newRows = seenAfter
      ? inboundRows.filter(row => {
          const ts = rowTimestamp(row);
          return ts && ts.getTime() > seenAfter.getTime();
        })
      : inboundRows;

    if (!newRows.length) {
      // All inbound rows are older than our cursor — already processed
      continue;
    }

    // ── Batch dedup: one DB query instead of N findOne calls ─────────────────
    const msgIds = newRows.map(r => rowMessageId(r)).filter(Boolean);
    const existingIds = new Set(
      (await WhatsAppMessage.find({ waMessageId: { $in: msgIds } }, { waMessageId: 1 }).lean())
        .map(m => m.waMessageId)
    );

    // ── Process only truly new rows ───────────────────────────────────────────
    for (const row of newRows) {
      const msgId = rowMessageId(row);
      if (msgId && existingIds.has(msgId)) continue; // already in DB

      const unmasked = unmaskedCustomerNumber(row);
      if (!unmasked) continue;
      row.customerNumber = unmasked;

      if (!firstVal(row, "integratedNumber", "integrated_number", "to")) {
        row.integratedNumber = config.msg91IntegratedNumber;
      }

      const ts = rowTimestamp(row);
      console.log(`📩 Ingesting inbound: customer=${unmasked} text="${String(row.text || row.content || "").slice(0, 40)}" ts=${ts?.toISOString()}`);

      try {
        await processMSG91Payload(row, { forceInbound: true });
        ingested++;

        // Advance cursor to the most recent successfully ingested message
        if (ts) {
          const current = lastSeenTs.get(configKey);
          if (!current || ts.getTime() > current.getTime()) {
            lastSeenTs.set(configKey, ts);
          }
        }
      } catch (err) {
        console.error("❌ MSG91 inbound ingest error:", err.message);
      }
    }
  }

  if (ingested) {
    console.log(`📥 MSG91 inbound poll: ingested ${ingested} new message(s)`);
  }
}

function startMsg91InboundPollJob() {
  if (!LOGS_API_URL) {
    console.warn("⏸  MSG91 inbound poll job not started — MSG91_LOGS_API_URL is not set.");
    return;
  }
  const everyN = Math.max(2, POLL_SECONDS);
  let isRunning = false;
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await pollOnce();
    } catch (e) {
      console.error("MSG91 inbound poll uncaught:", e.message);
    } finally {
      isRunning = false;
    }
  }, everyN * 1000);
  console.log(`🔄 MSG91 inbound poll job started — every ${everyN}s → ${LOGS_API_URL}`);
}

module.exports = { startMsg91InboundPollJob, pollOnce };