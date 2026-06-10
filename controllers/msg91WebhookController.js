// controllers/msg91WebhookController.js
// Handles ALL incoming WhatsApp events from MSG91
//
// ACTUAL MSG91 flat payload (confirmed from production logs 2026-05-23):
// {
//   "customerNumber":  "919538281101",   ← sender (lead's phone)
//   "integratedNumber":"919591327778",   ← your WA number
//   "customerName":    "SJSJASSS",
//   "contentType":     "text",
//   "text":            "Hello",          ← message text (flat, NOT nested)
//   "uuid":            "wamid.xxx",      ← message ID
//   "ts":              "2026-05-23T...", ← timestamp
//   "messageType":     "text"
// }
//
// Delivery/status updates have a "status" field: "delivered", "read", etc.

const WhatsAppConfig       = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const Lead                 = require("../models/Leads");
const User                 = require("../models/Users");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

function parseTimestamp(ts) {
  if (!ts) return new Date();
  // ISO string (e.g. "2026-05-23T14:43:32+05:30")
  const d = new Date(ts);
  if (!isNaN(d.getTime())) return d;
  // Unix epoch seconds
  const unix = parseInt(ts);
  if (!isNaN(unix) && unix > 1_000_000_000) return new Date(unix * 1000);
  return new Date();
}

// ─────────────────────────────────────────────────────────────────────────────
// pick — return the first non-empty value among several possible key names.
// Lets every extractor accept camelCase AND snake_case variants in one shot.
// ─────────────────────────────────────────────────────────────────────────────
function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract the core item — unwraps data[] / data{} / messages[] / message{}
// envelopes so the field extractors see the object that actually holds the
// message fields. Only descends into a wrapper that looks message-shaped.
// ─────────────────────────────────────────────────────────────────────────────
function looksMessageShaped(o) {
  return !!(o && typeof o === "object" && (
    o.customerNumber || o.customer_number || o.from || o.mobile || o.sender ||
    o.text || o.content || o.contentType || o.content_type || o.messageType ||
    o.message_type || o.uuid || o.message_uuid || o.status
  ));
}

function extractItem(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return rawBody || {};
  let item = rawBody;
  // Walk down at most a few wrapper levels.
  for (let depth = 0; depth < 4; depth++) {
    let next = null;
    for (const key of ["data", "messages", "message", "entry"]) {
      const v = item[key];
      if (Array.isArray(v) && v.length && looksMessageShaped(v[0])) { next = v[0]; break; }
      if (v && typeof v === "object" && !Array.isArray(v) && looksMessageShaped(v)) { next = v; break; }
    }
    if (!next || next === item) break;
    item = next;
  }
  return item;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract sender phone — covers camelCase, snake_case, and nested contact.
// ─────────────────────────────────────────────────────────────────────────────
function extractSenderPhone(item, rawBody = {}) {
  return String(
    pick(item, "customerNumber", "customer_number", "from", "mobile", "sender", "waId", "wa_id", "msisdn") ||
    pick(item.contact || {}, "wa_id", "waId", "number") ||
    pick(rawBody, "customerNumber", "customer_number", "from", "mobile", "sender") ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract recipient (your integrated number)
// ─────────────────────────────────────────────────────────────────────────────
function extractRecipientNumber(item, rawBody) {
  return String(
    pick(item, "integratedNumber", "integrated_number", "to", "recipient", "receiver") ||
    pick(rawBody, "integratedNumber", "integrated_number", "to") ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract message text — handles flat strings, nested objects ({"text":"Hi"}),
// `content` (object or string), `payload`, and interactive/button replies.
// ─────────────────────────────────────────────────────────────────────────────
function valToText(v) {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    return String(v.text || v.body || v.caption || v.title || v.url || "").trim();
  }
  return "";
}

function extractText(item) {
  let t = valToText(item.text);          // string OR { text: "..." }
  if (t) return t;
  // MSG91 logs API returns content as a JSON string: '{"text":"Hello"}'
  // valToText handles plain strings and objects, but NOT a JSON-stringified object.
  // Try parsing it first before falling through.
  if (item.content) {
    if (typeof item.content === "string") {
      // May be plain text ("Hello") or a JSON string ('{"text":"Hello"}')
      const trimmed = item.content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          t = valToText(parsed);
          if (t) return t;
        } catch {}
      }
      t = trimmed;
      if (t) return t;
    } else {
      t = valToText(item.content);
      if (t) return t;
    }
  }
  if (item.payload && typeof item.payload === "object") {
    t = item.payload.text || item.payload.caption || item.payload.body || item.payload.url || "";
    if (t) return String(t).trim();
  }
  t = valToText(item.message) || valToText(item.body) || valToText(item.caption) ||
      valToText(item.button) || valToText(item.interactive) || valToText(item.button_reply) ||
      valToText(item.list_reply);
  return t || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract content type — camelCase + snake_case
// ─────────────────────────────────────────────────────────────────────────────
function extractContentType(item) {
  const raw = String(
    pick(item, "contentType", "content_type", "type", "messageType", "message_type") || "text"
  ).toLowerCase();
  return raw.replace(/^(inbound|incoming|outbound)[\s_-]*/, "").trim() || "text";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract message ID — camelCase + snake_case + nested content.id
// ─────────────────────────────────────────────────────────────────────────────
function extractMessageId(item, rawBody, waPhone) {
  return (
    pick(item, "uuid", "id", "messageId", "message_id", "message_uuid", "requestId", "request_id", "wamid") ||
    pick(item.content || {}, "id") ||
    pick(rawBody, "uuid", "requestId", "request_id", "message_uuid") ||
    `msg91_${Date.now()}_${waPhone}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract contact name — camelCase + snake_case + nested contact.profile.name
// ─────────────────────────────────────────────────────────────────────────────
function extractContactName(item) {
  return (
    pick(item, "customerName", "customer_name", "name", "senderName", "sender_name") ||
    pick((item.contact && item.contact.profile) || {}, "name") ||
    ""
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract timestamp — camelCase + snake_case
// ─────────────────────────────────────────────────────────────────────────────
function extractTimestamp(item, rawBody) {
  return parseTimestamp(
    pick(item, "ts", "timestamp", "message_timestamp", "messageTimestamp", "time", "date") ||
    pick(rawBody, "ts", "timestamp", "requestedAt", "requested_at") ||
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Is this a delivery/status report?
//
// MSG91 inbound messages CAN carry a "status" field like "read" or "delivered"
// that refers to the read-state of the lead's own message — NOT a delivery
// report for an outbound message. We must NOT treat those as delivery reports.
//
// Rule: only treat as a delivery report when:
//   1. An explicit delivery status field is set  AND
//   2. There is NO sender phone (customerNumber) on the payload
//      — a genuine inbound reply always carries the sender's phone.
//
// The forceInbound flag (set by the poll job) short-circuits this entirely.
// ─────────────────────────────────────────────────────────────────────────────
const DELIVERY_STATUSES = new Set(["sent", "delivered", "read", "failed", "outbound"]);

function isDeliveryReport(rawBody, item) {
  const candidates = [
    rawBody.status, item.status,
    rawBody.report_status, item.report_status,
    rawBody.delivery_status, item.delivery_status,
    rawBody.event, item.event,
  ].map((v) => String(v || "").toLowerCase());

  const hasDeliveryStatus = candidates.some((v) => DELIVERY_STATUSES.has(v));
  if (!hasDeliveryStatus) return false;

  // If the payload also has a sender phone it's an inbound message that
  // happens to include a status field — do NOT treat it as a delivery report.
  const senderPhone = extractSenderPhone(item, rawBody);
  if (senderPhone && senderPhone.replace(/\D/g, "").length >= 10) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /msg91-webhook/   or   POST /msg91-webhook/msg91
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  res.sendStatus(200); // ACK immediately

  const body = req.body;
  // If the payload clearly contains a sender phone AND message content,
  // treat it as inbound even if it also carries a status field.
  // This prevents the isDeliveryReport() check from swallowing lead replies
  // that include a "status":"read" field on the inbound message itself.
  const item = extractItem(body || {});
  const senderPhone = extractSenderPhone(item, body || {});
  const hasText = !!extractText(item);
  const forceInbound = !!(senderPhone && senderPhone.replace(/\D/g, "").length >= 10 && hasText);

  await processMSG91Payload(body, { forceInbound });
};

// ─────────────────────────────────────────────────────────────────────────────
// Core processing — split out from the HTTP handler so it can be reused.
// The Meta webhook endpoint (/wa-webhook) also calls this when it receives an
// MSG91-shaped payload, so lead replies are processed no matter which of the
// two webhook URLs MSG91 is pointed at in the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
async function processMSG91Payload(rawBody, opts = {}) {
  const forceInbound = !!opts.forceInbound; // poller sets this for known-inbound log rows
  try {
    // Some senders POST JSON with a non-JSON Content-Type (text/plain, or none),
    // in which case Express leaves req.body as a raw string. Try to parse it so
    // we don't silently drop the message.
    if (typeof rawBody === "string") {
      const s = rawBody.trim();
      try {
        rawBody = JSON.parse(s);
      } catch {
        // Or a urlencoded "payload={...}" / "data={...}" style body
        const m = s.match(/(?:payload|data|body)=(\{.*\}|\[.*\])/s);
        if (m) { try { rawBody = JSON.parse(decodeURIComponent(m[1])); } catch {} }
      }
    }
    console.log("📲 MSG91 inbound payload:", JSON.stringify(rawBody, null, 2));

    if (!rawBody || typeof rawBody !== "object") {
      console.warn("⚠️  MSG91 webhook: empty or non-JSON body");
      return;
    }

    const item = extractItem(rawBody);

    // ── Delivery status update ────────────────────────────────────────────────
    // Skipped when forceInbound is set: a log row for an inbound message can
    // legitimately carry a "read"/"delivered" status (the read state of the
    // lead's own message), and we must NOT treat that as a delivery report.
    if (!forceInbound && isDeliveryReport(rawBody, item)) {
      const msgId     = item.uuid || item.id || item.requestId || rawBody.uuid || rawBody.requestId;
      const rawStatus = (item.status || rawBody.status || "").toLowerCase();
      const statusMap = { sent: "sent", delivered: "delivered", read: "read", failed: "failed", outbound: "sent" };
      const newStatus = statusMap[rawStatus] || "sent";

      console.log(`📬 MSG91 delivery report: status="${rawStatus}" msgId="${msgId}"`);

      if (msgId) {
        const updated = await WhatsAppMessage.findOneAndUpdate(
          { waMessageId: msgId },
          { status: newStatus },
          { new: true }
        );
        if (updated) {
          const io = global._io;
          if (io) {
            io.to("wa_admin").emit("wa_message_status", {
              waMessageId:    msgId,
              status:         newStatus,
              conversationId: updated.conversation?.toString(),
            });
          }
          console.log(`✅ Updated message ${msgId} → ${newStatus}`);
        }
      }
      return;
    }

    // ── Inbound message ───────────────────────────────────────────────────────
    const rawPhone = extractSenderPhone(item, rawBody);
    if (!rawPhone) {
      console.warn("⚠️  MSG91 inbound: no sender phone — rawBody keys:", Object.keys(rawBody).join(", "));
      return;
    }

    const waPhone     = normalizePhone(rawPhone);
    const toRaw       = extractRecipientNumber(item, rawBody);
    const toNumber    = normalizePhone(toRaw);
    const contactName = extractContactName(item);
    const msgText     = extractText(item);
    const contentType = extractContentType(item);
    const waMessageId = extractMessageId(item, rawBody, waPhone);
    const timestamp   = extractTimestamp(item, rawBody);

    console.log(`📩 MSG91 inbound: from=${waPhone} to=${toNumber} type=${contentType} text="${msgText}" id=${waMessageId}`);

    if (waPhone.length < 10) {
      console.warn("⚠️  MSG91 inbound: invalid phone after normalise:", waPhone);
      return;
    }

    // ── Dedup ─────────────────────────────────────────────────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      // If the message was previously saved as outbound (due to a bug) but we now
      // know it's inbound (forceInbound from poll job), correct the direction.
      if (exists.direction === "outbound" && forceInbound) {
        await WhatsAppMessage.findByIdAndUpdate(exists._id, { direction: "inbound", sentBy: null });
        console.log(`🔁 Corrected direction: outbound→inbound for ${waMessageId}`);
        // Also return here — conversation/socket update not needed for old messages
      } else {
        console.log(`⏭  Dedup: already saved ${waMessageId}`);
      }
      return;
    }

    // ── Find company config ───────────────────────────────────────────────────
    let config = null;
    if (toNumber) {
      config = await WhatsAppConfig.findOne({
        provider: "msg91",
        $or: [
          { msg91IntegratedNumber: toNumber },
          { msg91IntegratedNumber: "+" + toNumber },
          { msg91IntegratedNumber: toNumber.replace(/^\+/, "") },
        ],
        isActive: true,
      });
    }
    if (!config) config = await WhatsAppConfig.findOne({ provider: "msg91", isActive: true });
    if (!config) config = await WhatsAppConfig.findOne({ isActive: true });

    if (!config) {
      console.error("❌ MSG91 inbound: no active WhatsApp config found");
      return;
    }

    // ── Find conversation — deduplicate if multiple exist for same phone ───────
    // FIX: When there are duplicate conversations for the same waPhone (which
    // can happen if the admin started one via startConversation and the webhook
    // created another), always pick the MOST RECENTLY ACTIVE one so both the
    // admin's sent messages and the lead's reply live in the same conversation.
    const allConversations = await WhatsAppConversation.find({
      waPhone,
      company: config.company,
    }).sort({ lastMessageAt: -1, createdAt: -1 });

    let conversation = allConversations[0] || null;

    // If multiple conversations exist for this phone, merge duplicates:
    // keep the most recent one, delete the rest (they were empty/stale)
    if (allConversations.length > 1) {
      console.warn(`⚠️  Found ${allConversations.length} conversations for ${waPhone} — using most recent: ${conversation._id}`);
      const staleIds = allConversations.slice(1).map(c => c._id);
      // Only delete truly empty ones (no messages) to avoid data loss
      for (const staleId of staleIds) {
        const msgCount = await WhatsAppMessage.countDocuments({ conversation: staleId });
        if (msgCount === 0) {
          await WhatsAppConversation.findByIdAndDelete(staleId);
          console.log(`🗑  Deleted empty duplicate conversation ${staleId}`);
        }
      }
    }

    // ── Resolve lead + owners — find ALL leads with this phone in this company.
    // findLeadByPhone returns only one; if duplicates exist (same phone owned
    // by multiple employees), we want every owner to receive the inbound on
    // their socket. Collect all distinct user IDs across all matching leads.
    const matchingLeads = await findLeadsByPhone(waPhone, config.company);
    const leadOwnerIds = [...new Set(
      matchingLeads
        .map((l) => l.user?.toString())
        .filter(Boolean)
    )];
    // Primary lead — preferred for the conversation's `lead` ref. If we have
    // multiple, pick the most recently updated.
    const lead = matchingLeads
      .slice()
      .sort((a, b) => (new Date(b.updatedAt || 0)) - (new Date(a.updatedAt || 0)))[0] || null;
    const leadOwnerId = lead?.user ? lead.user.toString() : null;

    if (!conversation) {
      // Prefer the primary lead's assigned user as the agent; fall back to
      // load-balanced picker only when there is no lead.
      let assignedAgentId = leadOwnerId;
      if (!assignedAgentId) {
        const fallback = await getAvailableAgent(config.company);
        assignedAgentId = fallback?._id?.toString() || null;
      }

      conversation = await WhatsAppConversation.create({
        waPhone,
        contactName,
        lead:          lead?._id || null,
        assignedAgent: assignedAgentId,
        company:       config.company,
        status:        "open",
      });
      console.log(`🆕 New WA conversation: ${waPhone} → ${conversation._id} (agent=${assignedAgentId})`);
    } else {
      // Existing conversation — backfill lead ref if missing. Do NOT
      // aggressively realign assignedAgent: if the current value is one of
      // the lead owners (or it was set by an admin via startConversation),
      // leave it alone. Only realign when it points at someone who isn't
      // among the lead owners (stale round-robin assignment).
      const patch = {};
      if (!conversation.lead && lead?._id) patch.lead = lead._id;

      const currentAgentId = conversation.assignedAgent?.toString() || null;
      const currentIsValid = currentAgentId && leadOwnerIds.includes(currentAgentId);

      if (!currentIsValid && leadOwnerId) {
        patch.assignedAgent = leadOwnerId;
        console.log(`🔁 Realigning conv ${conversation._id} assignedAgent ${currentAgentId || "null"} → ${leadOwnerId} (primary lead owner)`);
      }

      if (Object.keys(patch).length) {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
        const plain = typeof conversation.toObject === "function" ? conversation.toObject() : conversation;
        conversation = { ...plain, ...patch };
      }
    }

    // ── Build message body ────────────────────────────────────────────────────
    let msgBody     = "";
    let messageType = "text";
    let mediaId     = null;
    let mediaCaption = null;

    if (["text", "inbound", "incoming"].includes(contentType)) {
      msgBody     = msgText || "";
      messageType = "text";
    } else if (["image", "document", "audio", "video", "sticker"].includes(contentType)) {
      messageType  = contentType;
      mediaCaption = item.caption || item.payload?.caption || null;
      mediaId      = item.url || item.payload?.url || item.payload?.id || null;
      msgBody      = mediaCaption || mediaId || `[${contentType}]`;
    } else if (contentType === "location") {
      messageType = "location";
      const lat = item.latitude  || item.payload?.latitude  || "?";
      const lng = item.longitude || item.payload?.longitude || "?";
      msgBody = `📍 Location: ${lat}, ${lng}`;
    } else if (["button", "interactive", "list_reply", "button_reply"].includes(contentType)) {
      messageType = "text";
      msgBody = item.button || item.payload?.title || item.payload?.text || msgText || `[${contentType} reply]`;
    } else {
      messageType = "text";
      msgBody = msgText || `[${contentType}]`;
    }

    if (!msgBody) {
      msgBody = `[${contentType}]`;
      console.warn(`⚠️  Empty message body for type "${contentType}" — saved as placeholder`);
    }

    // ── Save message ──────────────────────────────────────────────────────────
    const savedMsg = await WhatsAppMessage.create({
      conversation: conversation._id,
      direction:    "inbound",
      body:         msgBody,
      messageType,
      waMessageId,
      mediaId,
      mediaCaption,
      sentBy:       null,
      status:       "delivered",
      waTimestamp:  timestamp,
    });

    // ── Update conversation — reset 24h session window ────────────────────────
    const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      msgBody,
      lastMessageAt:    timestamp,
      status:           "waiting",
      contactName:      contactName || conversation.contactName,
      sessionExpiresAt: sessionExpiry,
      $inc:             { unreadCount: 1 },
    });

    // ── Socket push ───────────────────────────────────────────────────────────
    const io = global._io;
    if (io) {
      // FIX: Re-fetch the conversation fresh from DB to get the latest assignedAgent.
      // The in-memory `conversation` object may be stale — startConversation() could have
      // set assignedAgent AFTER this webhook fetched the conversation, causing assignedAgent
      // to appear null and the wa_agent_ socket emit to be skipped entirely.
      const freshConv = await WhatsAppConversation.findById(conversation._id).lean();
      const assignedAgentId = freshConv?.assignedAgent?.toString() || conversation.assignedAgent?.toString();

      // Build the set of agent rooms to notify. Include:
      //   • the conversation's current assignedAgent
      //   • every distinct owner across ALL leads sharing this phone
      // Whoever is logged in and watching this contact gets the message,
      // even if there are duplicate leads owned by different employees.
      const agentRooms = new Set();
      if (assignedAgentId) agentRooms.add(assignedAgentId);
      leadOwnerIds.forEach((id) => agentRooms.add(id));

      if (agentRooms.size) {
        console.log(`📡 Socket: notifying ${[...agentRooms].map(id => `wa_agent_${id}`).join(", ")} for conv ${conversation._id}`);
      } else {
        console.warn(`⚠️  No assignedAgent or leadOwner on conv ${conversation._id} — only emitting to wa_admin + wa_company`);
      }

      const socketPayload = {
        type:             "wa_new_message",
        conversationId:   conversation._id.toString(),
        sessionExpiresAt: sessionExpiry.toISOString(),
        message: {
          _id:         savedMsg._id.toString(),
          direction:   "inbound",
          body:        msgBody,
          messageType,
          waTimestamp: timestamp,
          status:      "delivered",
        },
        waPhone,
        contactName:   contactName || conversation.contactName,
        companyId:     config.company.toString(),
        assignedAgent: assignedAgentId,
        leadOwners:    leadOwnerIds,
      };

      // Per-agent rooms (legacy targeted delivery — kept for compatibility)
      agentRooms.forEach(agentId => {
        io.to(`wa_agent_${agentId}`).emit("wa_message", socketPayload);
      });
      // Admin firehose (every admin in the system)
      io.to("wa_admin").emit("wa_message", socketPayload);

      // Company firehose — collect ALL company IDs that should receive this event.
      // FIX: The WhatsAppConfig.company may differ from the lead owner's user.company
      // (e.g. if the config was created under a super-admin company while employees
      // belong to a sub-company). We emit to BOTH so the message always arrives.
      const companyRooms = new Set([config.company.toString()]);

      // Add each lead owner's own company to the broadcast set
      if (leadOwnerIds.length > 0) {
        const ownerDocs = await User.find(
          { _id: { $in: leadOwnerIds } },
          { company: 1 }
        ).lean();
        ownerDocs.forEach(u => {
          if (u.company) companyRooms.add(u.company.toString());
        });
      }

      // Also add the assigned agent's company (covers non-lead conversations)
      if (assignedAgentId) {
        const agentDoc = await User.findById(assignedAgentId, { company: 1 }).lean();
        if (agentDoc?.company) companyRooms.add(agentDoc.company.toString());
      }

      companyRooms.forEach(cid => {
        io.to(`wa_company_${cid}`).emit("wa_message", socketPayload);
      });

      console.log(`✅ Socket emitted wa_message → wa_admin + wa_company_[${[...companyRooms].join(",")}] + ${agentRooms.size} agent room(s) for conv ${conversation._id}`);
      console.log(`   sessionExpiresAt reset to: ${sessionExpiry.toISOString()}`);
    } else {
      console.warn("⚠️  global._io not set — socket not emitted");
    }

    console.log(`✅ Inbound saved: ${waPhone} → "${msgBody.substring(0, 80)}" [${messageType}]`);

  } catch (err) {
    console.error("❌ MSG91 webhook error:", err.message);
    console.error(err.stack);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
async function findLeadByPhone(waPhone, companyId) {
  const lastTen = waPhone.slice(-10);
  return Lead.findOne({
    company: companyId,
    $or: [
      { mobile: waPhone },
      { mobile: lastTen },
      { mobile: `+${waPhone}` },
    ],
  });
}

// Plural variant — returns EVERY matching lead so the webhook can collect
// all the distinct `user` IDs across duplicates. Without this, if the same
// phone is saved under two leads (e.g. one assigned to divzz, one to another
// employee), the webhook only notifies one of them and the other never sees
// the inbound reply.
async function findLeadsByPhone(waPhone, companyId) {
  if (!waPhone) return [];
  const lastTen = waPhone.slice(-10);
  return Lead.find({
    company: companyId,
    $or: [
      { mobile: waPhone },
      { mobile: lastTen },
      { mobile: `+${waPhone}` },
    ],
  }).select("user mobile name updatedAt").lean();
}

async function getAvailableAgent(companyId) {
  const agents = await User.find({ company: companyId, role: "user" }).lean();
  if (!agents.length) return null;

  const counts = await WhatsAppConversation.aggregate([
    { $match: { company: companyId, status: { $in: ["open", "waiting"] } } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  counts.forEach(c => { countMap[c._id?.toString()] = c.count; });
  agents.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));
  return agents[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic: does this payload look like an MSG91 WhatsApp event (not Meta)?
// Used by the Meta webhook endpoint to forward misrouted MSG91 payloads here
// instead of silently dropping them.
// ─────────────────────────────────────────────────────────────────────────────
function looksLikeMsg91Payload(body) {
  if (!body || typeof body !== "object") return false;
  if (body.object === "whatsapp_business_account") return false; // that's Meta
  const item = extractItem(body);
  return !!(
    item.customerNumber || item.integratedNumber ||
    body.customerNumber || body.integratedNumber ||
    item.uuid || item.contentType
  );
}

module.exports = { receiveMSG91Webhook, processMSG91Payload, looksLikeMsg91Payload };