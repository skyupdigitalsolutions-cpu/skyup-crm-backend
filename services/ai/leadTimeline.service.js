// services/ai/leadTimeline.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Collects ALL CRM activity for a lead into one normalized chronological
// timeline — including screenshot-imported WA messages, template sends,
// and the full conversation thread from WhatsAppMessage collection.
// ─────────────────────────────────────────────────────────────────────────────

const Lead                 = require("../../models/Leads");
const Call                 = require("../../models/Call");
const WhatsAppConversation = require("../../models/WhatsAppConversation");
const WhatsAppMessage      = require("../../models/WhatsAppMessage");

/**
 * @param {string|ObjectId} leadId
 * @param {string|ObjectId} companyId
 * @returns {{ lead, timeline, rawData }}
 */
async function buildLeadTimeline(leadId, companyId) {
  // ── 1. Load lead with all embedded data ───────────────────────────────────
  const lead = await Lead.findOne({ _id: leadId, company: companyId })
    .populate("user",          "name email _id")
    .populate("assignedAdmin", "name email _id")
    .lean();

  if (!lead) throw new Error("Lead not found or access denied");

  const timeline = [];

  // ── 2. Call history (embedded) ────────────────────────────────────────────
  for (const ch of lead.callHistory || []) {
    timeline.push({
      type:        "CALL",
      date:        ch.calledAt || lead.date,
      referenceId: null,
      employeeId:  ch.userId,
      employeeName:ch.userName || "Unknown",
      outcome:     ch.outcome  || "",
      summary:     ch.remark   || "",
      hasRecording:!!ch.recordingUrl,
    });
  }

  // ── 3. Follow-ups (embedded scheduledCalls) ───────────────────────────────
  for (const sc of lead.scheduledCalls || []) {
    const isOverdue = !sc.done && sc.scheduledAt && new Date(sc.scheduledAt) < new Date();
    timeline.push({
      type:        "FOLLOW_UP",
      date:        sc.scheduledAt,
      referenceId: null,
      followUpType:sc.type || "follow-up",
      done:        !!sc.done,
      doneAt:      sc.doneAt || null,
      note:        sc.note   || "",
      status:      sc.done ? "COMPLETED" : isOverdue ? "OVERDUE" : "SCHEDULED",
      delayDays:   sc.done && sc.doneAt
        ? +((new Date(sc.doneAt) - new Date(sc.scheduledAt)) / 86400000).toFixed(1)
        : null,
    });
  }

  // ── 4. Meeting remarks (embedded) ─────────────────────────────────────────
  for (const mr of lead.meetingRemarks || []) {
    timeline.push({
      type:        "MEETING",
      date:        mr.metAt || lead.date,
      referenceId: String(mr._id || ""),
      employeeId:  mr.userId,
      employeeName:mr.userName  || "Unknown",
      meetingType: mr.meetingType || "In-Person",
      outcome:     mr.outcome    || "",
      remark:      mr.remark     || "",
      followUpDate:mr.followUpDate || null,
    });
  }

  // ── 5. Template sends (embedded templateHistory) ──────────────────────────
  for (const th of lead.templateHistory || []) {
    timeline.push({
      type:         "TEMPLATE_SENT",
      date:         th.sentAt,
      referenceId:  null,
      templateName: th.templateName || "",
      status:       th.status  || "sent",
      channel:      th.channel || "whatsapp",
    });
  }

  // ── 6. Stage / activity changes ───────────────────────────────────────────
  for (const at of lead.activityTimeline || []) {
    if (["status_changed", "stage_changed", "lead_created", "reassigned"].includes(at.action)) {
      timeline.push({
        type:        "STAGE_CHANGE",
        date:        at.timestamp || lead.date,
        referenceId: null,
        action:      at.action,
        note:        at.note || "",
        performedBy: at.performedBy,
        role:        at.role,
      });
    }
  }

  // ── 7. WhatsApp messages — full conversation thread ───────────────────────
  let waMessages = [];
  let waConversation = null;
  try {
    waConversation = await WhatsAppConversation.findOne({
      lead:    leadId,
      company: companyId,
    }).lean();

    if (waConversation) {
      waMessages = await WhatsAppMessage.find({ conversation: waConversation._id })
        .sort({ waTimestamp: 1, createdAt: 1 })
        .select("direction body messageType waTimestamp createdAt waMessageId status metadata mediaCaption")
        .lean();

      for (const msg of waMessages) {
        const isScreenshotImport = msg.metadata?.source === "screenshot_import";
        timeline.push({
          type:               "WHATSAPP",
          date:               msg.waTimestamp || msg.createdAt,
          referenceId:        String(msg._id),
          direction:          msg.direction === "inbound" ? "INCOMING" : "OUTGOING",
          message:            msg.body || msg.mediaCaption || "",
          messageType:        msg.messageType || "text",
          status:             msg.status || null,
          // Flag screenshot-imported messages so AI knows they're from a
          // different WhatsApp number / external conversation
          isScreenshotImport,
          screenshotUrl:      isScreenshotImport ? msg.metadata?.screenshotUrl : null,
        });
      }
    }
  } catch (err) {
    console.error("[leadTimeline] WhatsApp load error:", err.message);
  }

  // ── 8. Transcribed calls (Call collection) ────────────────────────────────
  let transcribedCalls = [];
  try {
    const calls = await Call.find({ contactId: { $exists: true } })
      .select("callSid status recordingDuration summary transcript transcribeStatus createdAt agentIdentity")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    transcribedCalls = calls.filter(c => c.summary || c.transcript);

    for (const c of transcribedCalls) {
      if (c.summary) {
        timeline.push({
          type:        "CALL_TRANSCRIPT",
          date:        c.createdAt,
          referenceId: String(c._id),
          callSid:     c.callSid,
          summary:     typeof c.summary === "object" ? (c.summary.summary || "") : String(c.summary),
          sentiment:   c.summary?.sentiment   || null,
          nextAction:  c.summary?.nextAction  || null,
          keyPoints:   c.summary?.keyPoints   || [],
          duration:    c.recordingDuration    || null,
        });
      }
    }
  } catch (err) {
    console.error("[leadTimeline] Call transcript load error:", err.message);
  }

  // ── 9. Sort chronologically ───────────────────────────────────────────────
  timeline.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });

  return {
    lead,
    timeline,
    rawData: {
      callHistory:      lead.callHistory      || [],
      scheduledCalls:   lead.scheduledCalls   || [],
      meetingRemarks:   lead.meetingRemarks   || [],
      templateHistory:  lead.templateHistory  || [],
      waMessages,
      waConversation,
      transcribedCalls,
    },
  };
}

module.exports = { buildLeadTimeline };
