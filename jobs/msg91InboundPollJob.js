// jobs/msg91InboundPollJob.js
// ─────────────────────────────────────────────────────────────────────────────
// PULL-based inbound for MSG91 WhatsApp.
//
// MSG91 is NOT firing its inbound webhook so customer replies never get POSTed
// to our server. This job periodically PULLS message logs from MSG91's API,
// picks out inbound ones (lead replies), and feeds each through
// processMSG91Payload with forceInbound.
//
// PERFORMANCE (v4 — eliminates DB storm):
//   • In-memory seenMessageIds Set  — tracks ALL message IDs we've ever seen
//     in this process lifetime. Once a row appears and is processed (new OR
//     already-in-DB), its ID goes into the Set. Next cycle: zero DB queries
//     for rows already in the Set — skipped entirely before the batch check.
//   • Cursor (lastSeenTs) advances on ALL rows processed, not just new ones —
//     further reduces candidates each cycle to only rows newer than last seen.
//   • Result: after the first cold-start cycle, subsequent cycles do 0 DB
//     queries for the backlog and only check truly new message IDs.
//
// LONG-TERM FIX (eliminates polling entirely — <1s delay):
//   Set Inbound Webhook in MSG91 dashboard:
//     MSG91 → WhatsApp → Integrated Numbers → your number → Settings
//     → Response Webhook → paste: https://your-backend.onrender.com/msg91-webhook
//
// CONFIG (Render → Environment):
//   MSG91_LOGS_API_URL      (required)  Logs endpoint URL.
//   MSG91_LOGS_API_METHOD   (optional)  "GET" or "POST". Default "POST".
//   MSG91_LOGS_API_BODY     (optional)  JSON string for POST body.
//   MSG91_POLL_SECONDS      (optional)  Poll interval in seconds. Default 2.
//   MSG91_LOGS_LOOKBACK_MIN (optional)  Ignore rows older than N minutes. Default 60.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const WhatsAppConfig  = require("../models/WhatsAppConfig");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const { processMSG91Payload } = require("../controllers/msg91WebhookController");

const POLL_SECONDS    = parseInt(process.env.MSG91_POLL_SECONDS || "2", 10);
const LOOKBACK_MIN    = parseInt(process.env.MSG91_LOGS_LOOKBACK_MIN || "60", 10);
const LOGS_API_URL    = process.env.MSG91_LOGS_API_URL || "";
const LOGS_API_METHOD = (process.env.MSG91_LOGS_API_METHOD || "POST").toUpperCase();

// ── Per-config in-memory state ────────────────────────────────────────────────
// lastSeenTs  : Map<configId, Date>  — timestamp of most recent row we processed
// seenMsgIds  : Map<configId, Set>   — all message IDs seen this process lifetime
//               Once an ID is in here we NEVER hit the DB for it again.
const lastSeenTs  = new Map();
const seenMsgIds  = new Map();

function getSeenSet(configId) {
  if (!seenMsgIds.has(configId)) seenMsgIds.set(configId, new Set());
  return seenMsgIds.get(configId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function firstVal(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function decodePhoneFromWamid(uuid) {
  if (!uuid || !uuid.startsWith("wamid.")) return null;
  try {
    const inner   = uuid.replace("wamid.", "");
    const decoded = Buffer.from(inner, "base64").toString("binary");
    const match   = decoded.match(/\d{10,14}/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function unmaskedCustomerNumber(row) {
  const raw = row.customerNumber || "";
  if (!/[xX]/.test(raw)) return raw;
  const fromWamid = decodePhoneFromWamid(row.uuid || row.CRQID || "");
  if (fromWamid) return fromWamid;
  console.warn(`⚠️  Skipping masked customerNumber "${raw}" — wamid decode failed`);
  return null;
}

function flattenRow(row) {
  if (!row || typeof row !== "object") return row;
  const flat = {};
  for (const [k, v] of Object.entries(row)) {
    flat[k] = (v && typeof v === "object" && "value" in v && !Array.isArray(v) && Object.keys(v).length <= 2)
      ? v.value
      : v;
  }
  return flat;
}

function extractRows(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp.map(flattenRow);
  const candidates = [
    resp.data, resp.logs, resp.messages, resp.result, resp.results, resp.records,
    resp.data?.logs, resp.data?.data, resp.data?.records, resp.data?.messages,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c.map(flattenRow);
  return [];
}

function isInboundRow(row) {
  const dirRaw = firstVal(row, "direction", "Direction");
  if (dirRaw != null && dirRaw !== "") {
    const d = String(dirRaw).trim().toUpperCase();
    if (d === "INBOUND" || d === "1")             return true;
    if (d === "OUTBOUND" || d === "0")            return false;
    if (d.includes("IN"))                         return true;
    if (d.includes("OUT"))                        return false;
  }
  const origin  = String(firstVal(row, "origin", "Origin", "messageOrigin") || "").toLowerCase();
  if (origin.includes("user") || origin.includes("inbound") || origin.includes("incoming")) return true;
  if (origin.includes("marketing") || origin.includes("utility") || origin.includes("authentication")) return false;
  const msgType = String(firstVal(row, "messageType", "message_type", "type") || "").toLowerCase();
  if (msgType === "template") return false;
  if (firstVal(row, "campaign", "Campaign", "campaignName")) return false;
  if (firstVal(row, "template", "Template", "templateName")) return false;
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

// ── MSG91 Logs API fetch ───────────────────────────────────────────────────────
async function fetchLogsApi(config) {
  if (!LOGS_API_URL) return [];
  const authKey         = config.msg91AuthKey || process.env.MSG91_AUTH_KEY || "";
  const integratedNumber = config.msg91IntegratedNumber || "";
  if (!authKey) return [];

  const headers   = { authkey: authKey, "Content-Type": "application/json" };
  const now       = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);
  const today     = istNow.toISOString().slice(0, 10);
  const yesterday = new Date(istNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let resp;
  if (LOGS_API_METHOD === "GET") {
    resp = await axios.get(LOGS_API_URL, { headers, timeout: 15000 });
  } else {
    let body = {};
    if (process.env.MSG91_LOGS_API_BODY) {
      try {
        body = JSON.parse(
          process.env.MSG91_LOGS_API_BODY.replace(/\{\{integrated_number\}\}/g, integratedNumber)
        );
      } catch {}
    } else {
      body = { integratedNumber };
    }
    // Remove filters that block inbound messages:
    // • direction — filter locally, not server-side
    // • status    — inbound rows have no delivery status; this filter excludes them
    // • origin    — inbound rows have origin=null/empty; whitelist excludes them
    delete body.direction;
    delete body.status;
    delete body.origin;

    body.startDate = yesterday;
    body.endDate   = today;
    body.limit     = body.limit || 100;
    body.offset    = body.offset || 0;

    resp = await axios.post(LOGS_API_URL, body, { headers, timeout: 15000 });
  }
  return extractRows(resp.data).filter(isInboundRow);
}

// ── Process inbound rows for one config ───────────────────────────────────────
async function processInboundRows(rows, config, cutoff) {
  if (!rows.length) return 0;

  const configKey = config._id.toString();
  const seenAfter = lastSeenTs.get(configKey) || null;
  const seenIds   = getSeenSet(configKey);

  // Sort oldest-first
  rows.sort((a, b) => {
    const ta = rowTimestamp(a), tb = rowTimestamp(b);
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta.getTime() - tb.getTime();
  });

  // ── Stage 1: fast in-memory filter ───────────────────────────────────────
  // Skip rows that are: too old, older than cursor, or already seen this session.
  const candidates = [];
  let   latestTs   = seenAfter;   // track latest ts across ALL rows (new + old)

  for (const row of rows) {
    const ts    = rowTimestamp(row);
    const msgId = rowMessageId(row);

    // Update latest timestamp even for rows we skip — so cursor advances
    if (ts && (!latestTs || ts.getTime() > latestTs.getTime())) {
      latestTs = ts;
    }

    if (ts && ts.getTime() < cutoff)                               continue; // too old
    if (seenAfter && ts && ts.getTime() <= seenAfter.getTime())   continue; // behind cursor
    if (msgId && seenIds.has(msgId))                              continue; // seen this session

    candidates.push(row);
  }

  // Advance cursor to the latest ts we saw across ALL rows
  // (even ones we skipped due to seenIds) so next cycle filters more aggressively
  if (latestTs && (!seenAfter || latestTs.getTime() > seenAfter.getTime())) {
    lastSeenTs.set(configKey, latestTs);
  }

  if (!candidates.length) return 0;

  // ── Stage 2: batch DB dedup — only for genuinely new candidates ──────────
  const msgIds = candidates.map(r => rowMessageId(r)).filter(Boolean);
  const existingIds = new Set(
    (await WhatsAppMessage.find({ waMessageId: { $in: msgIds } }, { waMessageId: 1 }).lean())
      .map(m => m.waMessageId)
  );

  // Mark ALL candidates as seen (both existing and new) so we never check them again
  for (const id of msgIds) seenIds.add(id);

  // ── Stage 3: ingest truly new messages ────────────────────────────────────
  let ingested = 0;
  for (const row of candidates) {
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
    } catch (err) {
      console.error("❌ MSG91 inbound ingest error:", err.message);
    }
  }
  return ingested;
}

// ── Main poll cycle ────────────────────────────────────────────────────────────
async function pollOnce() {
  if (!LOGS_API_URL) return;

  const configs = await WhatsAppConfig.find({ isActive: true })
    .select("msg91AuthKey msg91IntegratedNumber company provider")
    .lean();

  const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;

  for (const config of configs) {
    let inboundRows = [];
    try {
      inboundRows = await fetchLogsApi(config);
    } catch (err) {
      console.error(`❌ MSG91 logs fetch failed: ${err.response?.status || ""} ${err.message}`);
      continue;
    }

    if (inboundRows.length) {
      console.log(`🔎 MSG91 poll: ${inboundRows.length} inbound candidate(s) for ${config.msg91IntegratedNumber}`);
    }

    const ingested = await processInboundRows(inboundRows, config, cutoff);
    if (ingested) {
      console.log(`📥 MSG91 inbound poll: ingested ${ingested} new message(s)`);
    }
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
    try { await pollOnce(); }
    catch (e) { console.error("MSG91 inbound poll uncaught:", e.message); }
    finally { isRunning = false; }
  }, everyN * 1000);
  console.log(`🔄 MSG91 inbound poll job started — every ${everyN}s → ${LOGS_API_URL}`);
}

module.exports = { startMsg91InboundPollJob, pollOnce };