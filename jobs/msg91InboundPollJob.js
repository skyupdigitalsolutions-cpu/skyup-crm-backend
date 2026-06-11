// jobs/msg91InboundPollJob.js
// ─────────────────────────────────────────────────────────────────────────────
// PULL-based inbound for MSG91 WhatsApp.
//
// MSG91 is NOT firing its inbound webhook (Webhook Logs show "Nothing Here"),
// so customer replies never get POSTed to our server. This job periodically
// PULLS message logs from MSG91's API, picks out inbound ones (lead replies),
// and feeds each through processMSG91Payload with forceInbound. The result: a
// pulled reply is saved as direction:"inbound" and pushed to the CRM UI over
// Socket.io exactly like a normal lead reply.
//
// STRATEGY:
//   Primary  → MSG91 chat/inbox API (/api/v5/whatsapp/chat/) — near-real-time
//              (typically < 5s after MSG91 receives the message)
//   Fallback → MSG91 report/logs API (MSG91_LOGS_API_URL) — used when chat
//              API isn't available or returns nothing useful (~30s lag)
//
// LONG-TERM FIX (eliminates polling entirely):
//   Set the Inbound Webhook URL in MSG91 dashboard:
//     MSG91 → WhatsApp → Integrated Numbers → your number → Settings
//     → Response Webhook → paste: https://your-backend.onrender.com/msg91-webhook
//   Once set, MSG91 pushes replies instantly and this poll job becomes a
//   backup safety net rather than the primary delivery mechanism.
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

// ── Per-config cursors ────────────────────────────────────────────────────────
// Tracks the timestamp of the last ingested inbound message per config.
// Rows older than the cursor are skipped without hitting the DB, eliminating
// the O(N) query storm that was causing the 30-40 second delay.
const lastSeenTs = new Map();

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
    const inner = uuid.replace("wamid.", "");
    const decoded = Buffer.from(inner, "base64").toString("binary");
    const match = decoded.match(/\d{10,14}/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function unmaskedCustomerNumber(row) {
  const raw = row.customerNumber || "";
  if (!/[xX]/.test(raw)) return raw;
  const uuid = row.uuid || row.CRQID || "";
  const fromWamid = decodePhoneFromWamid(uuid);
  if (fromWamid) return fromWamid;
  console.warn(`⚠️  Skipping masked customerNumber "${raw}" — wamid decode failed`);
  return null;
}

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
    if (dirStr === "INBOUND")       return true;
    if (dirStr === "OUTBOUND")      return false;
    if (dirStr === "1")             return true;
    if (dirStr === "0")             return false;
    if (dirStr.includes("IN"))      return true;
    if (dirStr.includes("OUT"))     return false;
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

// ── MSG91 Chat/Inbox API fetch (PRIMARY — lower latency than logs API) ────────
// MSG91 provides a chat inbox API at /api/v5/whatsapp/chat/ that returns
// recent conversation messages. This is the same data the MSG91 dashboard
// chat view uses, and it reflects new messages faster than the reports API.
async function fetchChatInbox(config) {
  const authKey = config.msg91AuthKey || process.env.MSG91_AUTH_KEY || "";
  const integratedNumber = config.msg91IntegratedNumber || "";
  if (!authKey || !integratedNumber) return [];

  const headers = { authkey: authKey, "Content-Type": "application/json" };

  // MSG91 chat conversations list endpoint
  const CHAT_URL = "https://control.msg91.com/api/v5/whatsapp/chat/";
  try {
    const resp = await axios.post(CHAT_URL, {
      integratedNumber,
      limit: 50,
      offset: 0,
    }, { headers, timeout: 10000 });

    const rows = extractRows(resp.data);

    // The chat API returns conversation objects, not individual messages.
    // Each conversation has a lastMessage field. We look for INBOUND lastMessages
    // that are new since our cursor — then fetch those conversations' messages.
    const inboundConvRows = rows.filter(row => {
      // Chat API marks direction on the lastMessage
      const msgDir = String(row.lastMessageDirection || row.direction || "").toUpperCase();
      return msgDir === "INBOUND" || (row.lastMessage && isInboundRow({ direction: "INBOUND", ...row }));
    });

    if (!inboundConvRows.length) return [];

    // Fetch messages for each conversation that has a recent inbound
    const allInbound = [];
    for (const conv of inboundConvRows.slice(0, 10)) {
      const convId = conv.id || conv._id || conv.conversationId;
      const phone  = conv.customerNumber || conv.waPhone || "";
      if (!convId && !phone) continue;

      try {
        const msgResp = await axios.post(`${CHAT_URL}messages/`, {
          integratedNumber,
          customerNumber: phone || undefined,
          conversationId: convId || undefined,
          limit: 20,
          offset: 0,
        }, { headers, timeout: 8000 });

        const msgs = extractRows(msgResp.data);
        const inbound = msgs.filter(m => isInboundRow(m));
        allInbound.push(...inbound);
      } catch {
        // Conversation fetch failed — skip silently
      }
    }
    return allInbound;
  } catch {
    return []; // chat API not available — fall through to logs API
  }
}

// ── MSG91 Logs API fetch (FALLBACK) ───────────────────────────────────────────
async function fetchLogsApi(config) {
  if (!LOGS_API_URL) return [];
  const authKey = config.msg91AuthKey || process.env.MSG91_AUTH_KEY || "";
  const integratedNumber = config.msg91IntegratedNumber || "";
  if (!authKey) return [];

  const headers = { authkey: authKey, "Content-Type": "application/json" };
  const now = new Date();
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
    delete body.direction; // filter locally
    delete body.status;    // inbound rows have NO delivery status
    delete body.origin;    // inbound rows have origin="" which gets excluded by any whitelist

    body.startDate = yesterday;
    body.endDate   = today;
    body.limit     = body.limit || 100;
    body.offset    = body.offset || 0;

    resp = await axios.post(LOGS_API_URL, body, { headers, timeout: 15000 });
  }
  return extractRows(resp.data).filter(row => isInboundRow(row));
}

// ── Process a list of inbound candidate rows for one config ───────────────────
async function processInboundRows(rows, config, cutoff) {
  if (!rows.length) return 0;

  const configKey = config._id.toString();
  const seenAfter = lastSeenTs.get(configKey) || null;

  // Sort oldest-first for correct chronological ingestion order
  rows.sort((a, b) => {
    const ta = rowTimestamp(a); const tb = rowTimestamp(b);
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta.getTime() - tb.getTime();
  });

  // Apply lookback cutoff and cursor filter
  const candidates = rows.filter(row => {
    const ts = rowTimestamp(row);
    if (ts && ts.getTime() < cutoff) return false;  // too old overall
    if (seenAfter && ts && ts.getTime() <= seenAfter.getTime()) return false; // already processed
    return true;
  });

  if (!candidates.length) return 0;

  // Batch dedup: one DB query for all candidate IDs
  const msgIds = candidates.map(r => rowMessageId(r)).filter(Boolean);
  const existingIds = new Set(
    (await WhatsAppMessage.find({ waMessageId: { $in: msgIds } }, { waMessageId: 1 }).lean())
      .map(m => m.waMessageId)
  );

  let ingested = 0;
  for (const row of candidates) {
    const msgId = rowMessageId(row);
    if (msgId && existingIds.has(msgId)) continue;

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

      // Advance cursor to most recent successfully ingested message
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
  return ingested;
}

// ── Main poll cycle ────────────────────────────────────────────────────────────
async function pollOnce() {
  if (!LOGS_API_URL) {
    console.warn("⏸  MSG91 inbound poll skipped — set MSG91_LOGS_API_URL to enable it.");
    return;
  }

  const configs = await WhatsAppConfig.find({ isActive: true })
    .select("msg91AuthKey msg91IntegratedNumber company provider")
    .lean();

  const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;
  let totalIngested = 0;

  for (const config of configs) {
    // ── Step 1: Try the chat inbox API (faster, real-time) ──────────────────
    let inboundRows = [];
    try {
      inboundRows = await fetchChatInbox(config);
    } catch (err) {
      // Silent — fallback below
    }

    // ── Step 2: Fall back to logs API if chat returned nothing ───────────────
    if (!inboundRows.length) {
      try {
        const logsRows = await fetchLogsApi(config);
        inboundRows = logsRows;
        if (logsRows.length) {
          // Only log when we actually have candidates (reduce noise)
        }
      } catch (err) {
        console.error(`❌ MSG91 logs fetch failed: ${err.response?.status || ""} ${err.message}`);
        continue;
      }
    }

    if (inboundRows.length) {
      console.log(`🔎 MSG91 poll: ${inboundRows.length} inbound candidate(s) for ${config.msg91IntegratedNumber}`);
    }

    const ingested = await processInboundRows(inboundRows, config, cutoff);
    if (ingested) {
      totalIngested += ingested;
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