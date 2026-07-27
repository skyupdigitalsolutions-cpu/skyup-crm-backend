// controllers/msg91WebhookController.js
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for all inbound WhatsApp messages via MSG91.
//
// MSG91 POSTs here the instant a lead replies — no polling, no delay.
// Target latency: message appears in CRM <2s after lead sends it.
//
// MSG91 flat payload (confirmed from production):
// {
//   "customerNumber":  "919538281101",   ← sender (lead's phone)
//   "integratedNumber":"919591327778",   ← your WA number
//   "customerName":    "SJSJASSS",
//   "contentType":     "text",
//   "text":            "Hello",
//   "uuid":            "wamid.xxx",      ← message ID
//   "ts":              "2026-05-23T...", ← timestamp
//   "messageType":     "text"
// }
// ─────────────────────────────────────────────────────────────────────────────

const WhatsAppConfig       = require("../models/WhatsAppConfig");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const Lead                 = require("../models/Leads");
const User                 = require("../models/Users");
const { resolveCanonicalConversation } = require("../utils/conversationMerge");
const { getCloudinaryForCompany } = require("../services/cloudinaryService");

// ─────────────────────────────────────────────────────────────────────────────
// mirrorInboundMedia — make lead-sent media viewable in the CRM.
//
// WhatsApp delivers inbound attachments as a PRIVATE Meta URL
// (lookaside.fbsbx.com/...) that returns 401 "Authentication Error" unless the
// request carries the WhatsApp access token. A browser <img> tag cannot do
// that, so the media never renders. We download it server-side (trying each
// credential we hold) and re-upload it to Cloudinary, producing a public URL
// the UI can display. Runs in the background so the webhook still replies fast.
// ─────────────────────────────────────────────────────────────────────────────
async function mirrorInboundMedia({ rawUrl, companyId, config, messageId, conversationId, contentType }) {
  try {
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return;

    // Meta's webhook media links are SIGNED, time-limited URLs, e.g.
    //   lookaside.fbsbx.com/...?ext=<unixExpiry>&hash=<signature>
    // They are downloadable WITHOUT a token while the signature is valid, and
    // sending an unexpected Authorization header can itself trigger a 401 — so
    // for signed URLs we try unauthenticated FIRST, then fall back to tokens.
    // Once `ext` passes, the link is dead and the media is unrecoverable, which
    // is why mirroring must happen the moment the webhook arrives.
    let isSigned = false;
    let expiresAt = null;
    try {
      const u = new URL(rawUrl);
      const ext = Number(u.searchParams.get("ext"));
      isSigned = !!u.searchParams.get("hash");
      if (Number.isFinite(ext) && ext > 0) {
        expiresAt = new Date(ext * 1000);
        if (expiresAt.getTime() < Date.now()) {
          console.error(
            `[inboundMedia] ❌ link already expired at ${expiresAt.toISOString()} — WhatsApp media links are short-lived and cannot be recovered afterwards.`
          );
          return { ok: false, reason: `WhatsApp's download link expired at ${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` };
        }
      }
    } catch (_) { /* not a parseable URL — carry on */ }

    const noAuth  = { name: "no auth (signed URL)", headers: {} };
    const withMeta  = config?.accessToken  ? { name: "meta bearer",   headers: { Authorization: `Bearer ${config.accessToken}` } } : null;
    const withMsg91 = config?.msg91AuthKey ? { name: "msg91 authkey", headers: { authkey: config.msg91AuthKey } } : null;

    const attempts = (isSigned
      ? [noAuth, withMeta, withMsg91]
      : [withMeta, withMsg91, noAuth]
    ).filter(Boolean);

    let buffer = null;
    let usedName = null;
    const attemptErrors = [];
    for (const a of attempts) {
      try {
        const resp = await axios.get(rawUrl, {
          headers: a.headers,
          responseType: "arraybuffer",
          timeout: 25000,
          maxContentLength: 30 * 1024 * 1024,
        });
        // Meta sometimes returns a JSON auth error with HTTP 200.
        const ct = String(resp.headers?.["content-type"] || "");
        if (ct.includes("application/json")) {
          let body = "";
          try { body = Buffer.from(resp.data).toString("utf8").slice(0, 200); } catch (_) {}
          attemptErrors.push(`${a.name}: ${body || "JSON error body"}`);
          console.warn(`[inboundMedia] "${a.name}" returned JSON (auth error): ${body}`);
          continue;
        }
        buffer = Buffer.from(resp.data);
        usedName = a.name;
        break;
      } catch (e) {
        let body = "";
        try { if (e?.response?.data) body = Buffer.from(e.response.data).toString("utf8").slice(0, 200); } catch (_) {}
        const msg = `${a.name}: HTTP ${e?.response?.status || "?"} ${body || e.message}`;
        attemptErrors.push(msg);
        console.warn(`[inboundMedia] download failed — ${msg}`);
      }
    }

    if (!buffer || !buffer.length) {
      const detail = attemptErrors.join(" | ") || "no attempts made";
      console.error(`[inboundMedia] ❌ could not download media — ${detail}`);
      return { ok: false, reason: detail };
    }

    const { instance } = await getCloudinaryForCompany(companyId);
    const resourceType =
      contentType === "image" ? "image"
      : (contentType === "video" || contentType === "sticker") ? "video"
      : "raw";

    const uploaded = await new Promise((resolve, reject) => {
      const stream = instance.uploader.upload_stream(
        { folder: `skyup-crm/whatsapp-inbound/${companyId}`, resource_type: resourceType },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
      stream.end(buffer);
    });

    const publicUrl = uploaded?.secure_url || uploaded?.url;
    if (!publicUrl) return;

    await WhatsAppMessage.findByIdAndUpdate(messageId, { mediaUrl: publicUrl });
    console.log(`[inboundMedia] ✅ mirrored ${contentType} via "${usedName}" → ${publicUrl}`);

    // Tell any open chat window to swap in the now-viewable URL.
    const io = global._io;
    if (io) {
      const evt = {
        type: "wa_media_ready",
        conversationId: String(conversationId),
        messageId: String(messageId),
        mediaUrl: publicUrl,
      };
      io.to("wa_admin").emit("wa_media_ready", evt);
      io.to(`wa_company_${String(companyId)}`).emit("wa_media_ready", evt);
    }
    return { ok: true, mediaUrl: publicUrl };
  } catch (err) {
    console.error("[inboundMedia] mirror error:", err.message);
    return { ok: false, reason: err.message };
  }
}

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
  const d = new Date(ts);
  if (!isNaN(d.getTime())) return d;
  const unix = parseInt(ts);
  if (!isNaN(unix) && unix > 1_000_000_000) return new Date(unix * 1000);
  return new Date();
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// Unwrap common envelope wrappers (data[], messages[], etc.)
function extractItem(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return rawBody || {};
  let item = rawBody;
  const looksMsg = (o) => !!(o && typeof o === "object" && (
    o.customerNumber || o.customer_number || o.from ||
    o.text || o.content || o.uuid || o.status || o.contentType
  ));
  for (let depth = 0; depth < 4; depth++) {
    let next = null;
    for (const key of ["data", "messages", "message", "entry"]) {
      const v = item[key];
      if (Array.isArray(v) && v.length && looksMsg(v[0])) { next = v[0]; break; }
      if (v && typeof v === "object" && !Array.isArray(v) && looksMsg(v)) { next = v; break; }
    }
    if (!next || next === item) break;
    item = next;
  }
  return item;
}

function extractSenderPhone(item, rawBody) {
  return String(
    pick(item, "customerNumber", "customer_number", "from", "mobile", "sender", "waId", "wa_id", "msisdn") ||
    pick(rawBody, "customerNumber", "customer_number", "from", "mobile", "sender") ||
    ""
  );
}

function extractRecipientNumber(item, rawBody) {
  return String(
    pick(item, "integratedNumber", "integrated_number", "to", "recipient", "receiver") ||
    pick(rawBody, "integratedNumber", "integrated_number", "to") ||
    ""
  );
}

function valToText(v) {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v.text || v.body || v.caption || v.title || v.url || "").trim();
  return "";
}

function extractText(item) {
  let t = valToText(item.text);
  if (t) return t;
  if (item.content) {
    if (typeof item.content === "string") {
      const trimmed = item.content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { t = valToText(JSON.parse(trimmed)); if (t) return t; } catch {}
      }
      if (trimmed) return trimmed;
    } else {
      t = valToText(item.content);
      if (t) return t;
    }
  }
  return valToText(item.message) || valToText(item.body) || valToText(item.caption) ||
         valToText(item.button) || valToText(item.payload) || "";
}

function extractContentType(item) {
  const raw = String(
    pick(item, "contentType", "content_type", "type", "messageType", "message_type") || "text"
  ).toLowerCase();
  return raw.replace(/^(inbound|incoming|outbound)[\s_-]*/, "").trim() || "text";
}

// ── Interactive / button / list reply extraction ──────────────────────────────
// When a lead taps a quick-reply button (Confirm / Reschedule / Cancel) on a
// template, MSG91 (and Meta) deliver it in one of MANY nested shapes. We dig
// through all of them and return the human-readable label, or "" if this isn't
// an interactive reply.
function extractInteractiveTitle(item) {
  if (!item || typeof item !== "object") return "";
  const candidates = [
    item.button, item.buttonText, item.button_text,
    item.button_reply, item.buttonReply,
    item.list_reply, item.listReply,
    item.quick_reply, item.quickReply,
    item.reply,
    item.interactive,
    item.interactive?.button_reply, item.interactive?.list_reply, item.interactive?.nfm_reply,
    item.content?.button, item.content?.button_reply, item.content?.list_reply,
    item.content?.interactive, item.content?.interactive?.button_reply, item.content?.interactive?.list_reply,
    item.payload, item.payload?.button, item.payload?.button_reply, item.payload?.list_reply,
    item.message?.button, item.message?.interactive?.button_reply, item.message?.interactive?.list_reply,
  ];
  for (const v of candidates) {
    if (!v) continue;
    if (typeof v === "string") { const s = v.trim(); if (s) return s; }
    else if (typeof v === "object") {
      const t = String(v.title || v.text || v.body || v.caption || v.payload || "").trim();
      if (t) return t;
    }
  }
  return "";
}

// True when the payload is an interactive/button/list reply by content-type OR
// by the presence of a recognisable nested reply structure.
function looksInteractive(item, contentType) {
  if (/button|interactive|list|quick|reply/.test(contentType)) return true;
  return !!(
    item.button || item.buttonReply || item.button_reply ||
    item.list_reply || item.listReply || item.interactive ||
    item.quick_reply || item.quickReply ||
    item.content?.button || item.content?.interactive ||
    item.payload?.button_reply || item.payload?.list_reply
  );
}

function extractMessageId(item, rawBody, waPhone) {
  return (
    pick(item, "uuid", "id", "messageId", "message_id", "message_uuid", "requestId", "request_id", "wamid") ||
    pick(rawBody, "uuid", "requestId", "request_id", "message_uuid") ||
    `msg91_${Date.now()}_${waPhone}`
  );
}

function extractContactName(item) {
  return pick(item, "customerName", "customer_name", "name", "senderName", "sender_name") || "";
}

function extractTimestamp(item, rawBody) {
  return parseTimestamp(
    pick(item, "ts", "timestamp", "message_timestamp", "messageTimestamp", "time", "date") ||
    pick(rawBody, "ts", "timestamp", "requestedAt", "requested_at") ||
    null
  );
}

// A delivery/status report has a delivery status field AND no sender phone
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

  const senderPhone = extractSenderPhone(item, rawBody);
  if (senderPhone && senderPhone.replace(/\D/g, "").length >= 10) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  counts.forEach((c) => { countMap[c._id?.toString()] = c.count; });
  agents.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));
  return agents[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler — POST /msg91-webhook
// ─────────────────────────────────────────────────────────────────────────────
const receiveMSG91Webhook = async (req, res) => {
  // ACK immediately — MSG91 requires a 200 within 5s or it retries
  res.sendStatus(200);

  try {
    await processMSG91Payload(req.body);
  } catch (err) {
    console.error("❌ MSG91 webhook uncaught:", err.message, err.stack);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Core processor — called by the HTTP handler (and optionally by the Meta
// webhook when it detects a misrouted MSG91 payload)
// ─────────────────────────────────────────────────────────────────────────────
async function processMSG91Payload(rawBody, opts = {}) {
  try {
    // Handle string body (non-JSON Content-Type edge case)
    if (typeof rawBody === "string") {
      const s = rawBody.trim();
      try { rawBody = JSON.parse(s); } catch {
        const m = s.match(/(?:payload|data|body)=(\{.*\}|\[.*\])/s);
        if (m) { try { rawBody = JSON.parse(decodeURIComponent(m[1])); } catch {} }
      }
    }

    if (!rawBody || typeof rawBody !== "object") {
      console.warn("⚠️  MSG91 webhook: empty or non-JSON body — skipping");
      return;
    }

    console.log("📲 MSG91 webhook payload:", JSON.stringify(rawBody));

    const item = extractItem(rawBody);

    // ── Delivery status update ────────────────────────────────────────────────
    if (isDeliveryReport(rawBody, item)) {
      const msgId     = item.uuid || item.id || item.requestId || rawBody.uuid || rawBody.requestId;
      const rawStatus = (item.status || rawBody.status || "").toLowerCase();
      const statusMap = { sent: "sent", delivered: "delivered", read: "read", failed: "failed", outbound: "sent" };
      const newStatus = statusMap[rawStatus] || "sent";

      console.log(`📬 MSG91 delivery report: ${rawStatus} → msgId=${msgId}`);
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
          console.log(`✅ Status updated: ${msgId} → ${newStatus}`);
        }
      }
      return;
    }

    // ── Inbound message ───────────────────────────────────────────────────────
    const rawPhone = extractSenderPhone(item, rawBody);
    if (!rawPhone) {
      console.warn("⚠️  MSG91 inbound: no sender phone — keys:", Object.keys(rawBody).join(", "));
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

    console.log(`📩 MSG91 inbound: from=${waPhone} type=${contentType} text="${msgText}" id=${waMessageId}`);

    if (waPhone.length < 10) {
      console.warn("⚠️  MSG91 inbound: invalid phone:", waPhone);
      return;
    }

    // ── Dedup — prevent processing the same message twice ────────────────────
    const exists = await WhatsAppMessage.findOne({ waMessageId });
    if (exists) {
      console.log(`⏭  Dedup: already saved ${waMessageId}`);
      return;
    }

    // ── Find company config ───────────────────────────────────────────────────
    // IMPORTANT: this used to fall back to "any active msg91 config in the
    // whole database" whenever the exact-string match on msg91IntegratedNumber
    // failed (e.g. a formatting difference like a stray "+" or space in how it
    // was saved). On a multi-tenant CRM that silently misrouted the message to
    // a DIFFERENT COMPANY — the lead's reply would get saved and socket-emitted
    // to some other company's agent/room, so the actual assigned employee
    // would never see it, with no error and no trace except this being the
    // wrong company entirely. That is exactly what was happening here.
    //
    // Fix: match by normalized digits (last 10) so formatting differences
    // can't cause a miss, and if that STILL fails, resolve the company via
    // the lead who actually owns this phone number — never default to an
    // arbitrary other tenant's config.
    let config = null;
    const toLastTen = toNumber ? toNumber.slice(-10) : "";

    if (toLastTen) {
      const activeConfigs = await WhatsAppConfig.find({ provider: "msg91", isActive: true }).lean();
      config = activeConfigs.find((c) => normalizePhone(c.msg91IntegratedNumber).slice(-10) === toLastTen) || null;
      if (config) config = await WhatsAppConfig.findById(config._id); // re-fetch as a full doc
    }

    if (!config) {
      // Fall back to resolving via the lead itself (searched across ALL
      // companies — a lead's phone number is only meaningful scoped to a
      // company, but we don't know which one yet, which is exactly what
      // we're trying to find).
      const lastTenSender = waPhone.slice(-10);
      const anyCompanyLeads = await Lead.find({
        $or: [
          { mobile: waPhone }, { mobile: lastTenSender }, { mobile: `+${waPhone}` },
        ],
      }).select("company").lean();
      const candidateCompanyIds = [...new Set(anyCompanyLeads.map((l) => l.company?.toString()).filter(Boolean))];
      if (candidateCompanyIds.length === 1) {
        config = await WhatsAppConfig.findOne({ company: candidateCompanyIds[0], provider: "msg91", isActive: true });
        if (config) {
          console.warn(`⚠️  MSG91 inbound: integrated number "${toNumber}" didn't match any config directly — resolved company via lead lookup instead (company=${candidateCompanyIds[0]}). Check that WhatsAppConfig.msg91IntegratedNumber is saved correctly for this company.`);
        }
      } else if (candidateCompanyIds.length > 1) {
        console.error(`❌ MSG91 inbound: phone ${waPhone} matches leads in ${candidateCompanyIds.length} different companies and the integrated number didn't resolve one directly — refusing to guess. Fix WhatsAppConfig.msg91IntegratedNumber for the correct company.`);
        return;
      }
    }

    if (!config) {
      console.error(`❌ MSG91 inbound: could not resolve a company for integrated number "${toNumber}" (sender ${waPhone}) — message dropped rather than risk sending it to the wrong company. Check WhatsAppConfig.msg91IntegratedNumber matches exactly what MSG91 sends as "integrated_number".`);
      return;
    }

    // Resolve leads for this phone (done BEFORE conversation lookup so the
    // merge helper can match by lead ref too, not just waPhone — this is what
    // catches the case where a manual template send created a conversation
    // under a slightly different phone value than the one WhatsApp used for
    // the inbound webhook).
    const matchingLeads = await findLeadsByPhone(waPhone, config.company);
    const leadOwnerIds  = [...new Set(matchingLeads.map((l) => l.user?.toString()).filter(Boolean))];
    const lead          = matchingLeads
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
    const leadOwnerId   = lead?.user?.toString() || null;

    // ── Find or create conversation ───────────────────────────────────────────
    // resolveCanonicalConversation() matches by BOTH waPhone and lead ref, and
    // merges any duplicates it finds into a single record (keeping all
    // messages) instead of just picking the most recent one. This is what
    // makes inbound replies always land on the SAME conversation the employee
    // panel is looking at, even if an earlier manual template send created a
    // separate record for this lead.
    let conversation = await resolveCanonicalConversation({
      leadId: lead?._id || null,
      phoneVariants: [waPhone],
      companyId: config.company,
    });

    if (!conversation) {
      const assignedAgentId = leadOwnerId || (await getAvailableAgent(config.company))?._id?.toString() || null;
      conversation = await WhatsAppConversation.create({
        waPhone,
        contactName,
        lead:          lead?._id || null,
        assignedAgent: assignedAgentId,
        company:       config.company,
        status:        "open",
      });
      console.log(`🆕 New conversation: ${waPhone} → ${conversation._id}`);
    } else {
      // Backfill missing lead/agent refs
      const patch = {};
      if (!conversation.lead && lead?._id) patch.lead = lead._id;
      const currentAgentId  = conversation.assignedAgent?.toString() || null;
      const currentIsValid  = currentAgentId && leadOwnerIds.includes(currentAgentId);
      if (!currentIsValid && leadOwnerId) patch.assignedAgent = leadOwnerId;
      if (Object.keys(patch).length) {
        await WhatsAppConversation.findByIdAndUpdate(conversation._id, patch);
        conversation = { ...(conversation.toObject ? conversation.toObject() : conversation), ...patch };
      }
    }

    // ── Build message content ─────────────────────────────────────────────────
    let msgBody     = "";
    let messageType = "text";
    let mediaId     = null;
    let mediaCaption = null;

    // Friendly labels shown when a message carries no readable text (media,
    // reactions, polls, view-once, etc.). Avoids surfacing scary raw tags like
    // "[unsupported]" in chat and notifications.
    const MEDIA_LABEL = {
      image:    "📷 Photo",
      video:    "🎥 Video",
      audio:    "🎤 Voice message",
      document: "📄 Document",
      sticker:  "💬 Sticker",
    };

    if (["image", "document", "audio", "video", "sticker"].includes(contentType)) {
      messageType  = contentType;
      mediaCaption = item.caption || item.payload?.caption || item[contentType]?.caption || null;

      // MSG91 is inconsistent about where the inbound media URL lives (and uses
      // "attachment_url" on the outbound side), so check every plausible field.
      // The first value that looks like an http(s) URL wins; otherwise we fall
      // back to whatever ID was provided.
      const p = item.payload || {};
      const typed = item[contentType] || p[contentType] || {};
      const candidates = [
        item.attachment_url, p.attachment_url, typed.attachment_url,
        item.url,   p.url,   typed.url,
        item.link,  p.link,  typed.link,
        item.media_url, p.media_url,
        item.media?.url, p.media?.url,
        typed.id, item.id, p.id,
      ];
      mediaId = candidates.find((c) => c) || null;
      const httpUrl = candidates.find((c) => /^https?:\/\//i.test(String(c || "")));
      if (httpUrl) mediaId = httpUrl;

      // One-line diagnostic so a non-rendering attachment is immediately
      // traceable to the field MSG91 actually used.
      console.log(
        `📎 Inbound ${contentType}: resolvedUrl=${httpUrl ? "YES" : "NO"} value="${String(mediaId).slice(0, 120)}"` +
        (httpUrl ? "" : ` | raw keys: ${Object.keys(item).join(",")}`)
      );

      msgBody = mediaCaption || MEDIA_LABEL[contentType] || "📎 Attachment";
    } else if (contentType === "location") {
      messageType = "location";
      msgBody     = `📍 Location: ${item.latitude || "?"}, ${item.longitude || "?"}`;
    } else if (looksInteractive(item, contentType)) {
      // Button / interactive / list reply (e.g. Confirm / Reschedule / Cancel)
      messageType = "text";
      msgBody     = extractInteractiveTitle(item) || msgText || "📩 New message";
    } else if (["text", "inbound", "incoming"].includes(contentType)) {
      msgBody     = msgText || "";
      messageType = "text";
    } else {
      // Unknown / "unsupported" content type — WhatsApp sends this for reactions,
      // polls, view-once media, and newer message types that carry no text.
      // Try any text we can find, otherwise a friendly generic (never "[unsupported]").
      messageType = "text";
      msgBody = msgText || extractInteractiveTitle(item) || "📩 New message";
    }

    if (!msgBody) msgBody = "📩 New message";

    // ── "Stop Promotion" opt-out ──────────────────────────────────────────────
    // When a lead taps the Stop Promotion quick-reply button on the
    // crm_followup_reminder template, WhatsApp delivers the button's title as an
    // inbound message. Flag every lead on this phone (within this company) so
    // the follow-up reminder job stops nudging them. Other automations (outcome
    // messages, new-lead blast, meeting reminders) are unaffected.
    try {
      const optOutText = String(
        extractInteractiveTitle(item) || msgText || msgBody || ""
      ).trim().toLowerCase();
      const isStopRequest = optOutText === "stop promotion" || optOutText === "stop";
      if (isStopRequest && matchingLeads.length) {
        const ids = matchingLeads.map((l) => l._id);
        await Lead.updateMany(
          { _id: { $in: ids } },
          { $set: { followUpReminderOptOut: true } }
        );
        console.log(`🛑 Stop Promotion → opted ${ids.length} lead(s) out of follow-up reminders (phone ${waPhone})`);
      }
    } catch (e) {
      console.error("[optOut] Stop Promotion handling error:", e.message);
    }

    // ── Save message ──────────────────────────────────────────────────────────
    // MSG91 delivers inbound media as a direct URL. Store it in mediaUrl (what
    // the chat UI renders from) as well as mediaId, so images/documents the
    // LEAD sends actually display instead of a "[image]" placeholder.
    const inboundMediaUrl = /^https?:\/\//i.test(String(mediaId || "")) ? mediaId : null;

    const savedMsg = await WhatsAppMessage.create({
      conversation: conversation._id,
      direction:    "inbound",
      body:         msgBody,
      messageType,
      waMessageId,
      mediaId,
      mediaUrl:     inboundMediaUrl,
      mediaCaption,
      sentBy:       null,
      status:       "delivered",
      waTimestamp:  timestamp,
    });

    // Lead-sent media arrives as a private Meta URL that 401s in the browser.
    // Mirror it to Cloudinary in the background so it becomes viewable; the UI
    // is updated live via the wa_media_ready socket event when it's ready.
    if (inboundMediaUrl) {
      mirrorInboundMedia({
        rawUrl:         inboundMediaUrl,
        companyId:      config.company,
        config,
        messageId:      savedMsg._id,
        conversationId: conversation._id,
        contentType,
      }).catch(() => {});
    }

    // ── Update conversation ───────────────────────────────────────────────────
    const sessionExpiry = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
    await WhatsAppConversation.findByIdAndUpdate(conversation._id, {
      lastMessage:      msgBody,
      lastMessageAt:    timestamp,
      status:           "waiting",
      contactName:      contactName || conversation.contactName,
      sessionExpiresAt: sessionExpiry,
      $inc:             { unreadCount: 1 },
    });

    // ── Emit via Socket.io — this is what makes the message appear instantly ──
    const io = global._io;
    if (io) {
      // Always re-fetch the conversation's assignedAgent from DB — it may have
      // been updated by startConversation() after we read it above
      const freshConv       = await WhatsAppConversation.findById(conversation._id).lean();
      const assignedAgentId = freshConv?.assignedAgent?.toString() || conversation.assignedAgent?.toString();

      const agentRooms = new Set();
      if (assignedAgentId) agentRooms.add(assignedAgentId);
      leadOwnerIds.forEach((id) => agentRooms.add(id));

      const socketPayload = {
        type:             "wa_new_message",
        conversationId:   conversation._id.toString(),
        leadId:           (lead?._id || freshConv?.lead || conversation.lead)?.toString() || null,
        sessionExpiresAt: sessionExpiry.toISOString(),
        message: {
          _id:         savedMsg._id.toString(),
          direction:   "inbound",
          body:        msgBody,
          messageType,
          mediaUrl:    inboundMediaUrl,
          waTimestamp: timestamp,
          status:      "delivered",
        },
        waPhone,
        contactName:   contactName || conversation.contactName,
        leadName:      lead?.name || conversation.leadName || null,
        companyId:     config.company.toString(),
        assignedAgent: assignedAgentId,
        leadOwners:    leadOwnerIds,
      };

      // Per-agent rooms
      agentRooms.forEach((agentId) => {
        io.to(`wa_agent_${agentId}`).emit("wa_message", socketPayload);
      });
      // Admin firehose
      io.to("wa_admin").emit("wa_message", socketPayload);
      // Company firehose
      const companyRooms = new Set([config.company.toString()]);
      if (leadOwnerIds.length > 0) {
        const ownerDocs = await User.find({ _id: { $in: leadOwnerIds } }, { company: 1 }).lean();
        ownerDocs.forEach((u) => { if (u.company) companyRooms.add(u.company.toString()); });
      }
      if (assignedAgentId) {
        const agentDoc = await User.findById(assignedAgentId, { company: 1 }).lean();
        if (agentDoc?.company) companyRooms.add(agentDoc.company.toString());
      }
      companyRooms.forEach((cid) => {
        io.to(`wa_company_${cid}`).emit("wa_message", socketPayload);
      });

      console.log(
        `✅ Socket emitted wa_message → wa_admin` +
        ` + agent room(s): [${[...agentRooms].map((id) => `wa_agent_${id}`).join(", ") || "none"}]` +
        ` + company room(s): [${[...companyRooms].map((id) => `wa_company_${id}`).join(", ") || "none"}]` +
        ` for conv ${conversation._id} (assignedAgentId=${assignedAgentId || "null"}, leadOwnerIds=[${leadOwnerIds.join(", ") || "none"}])`
      );
    } else {
      console.warn("⚠️  global._io not set — socket not emitted");
    }

    console.log(`✅ Inbound saved & pushed: ${waPhone} → "${msgBody.substring(0, 80)}" [${messageType}]`);

  } catch (err) {
    console.error("❌ processMSG91Payload error:", err.message, err.stack);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic: does this payload look like MSG91 (not Meta)?
// Used by the Meta webhook endpoint to forward misrouted payloads here.
// ─────────────────────────────────────────────────────────────────────────────
function looksLikeMsg91Payload(body) {
  if (!body || typeof body !== "object") return false;
  if (body.object === "whatsapp_business_account") return false;
  const item = extractItem(body);
  return !!(
    item.customerNumber || item.integratedNumber ||
    body.customerNumber || body.integratedNumber ||
    item.uuid || item.contentType
  );
}

module.exports = { receiveMSG91Webhook, processMSG91Payload, looksLikeMsg91Payload, mirrorInboundMedia };