// utils/conversationMerge.js
// ─────────────────────────────────────────────────────────────────────────────
// ROOT-CAUSE FIX for the "employee panel shows an empty/expired chat while the
// lead's real WhatsApp history lives in a different conversation record" bug.
//
// Because conversations were being looked up independently by the inbound
// webhook (by waPhone), by the manual "Send Template & Start Chat" flow (by
// waPhone), and by the employee chat screen (by lead ref OR waPhone), a lead
// could end up with TWO WhatsAppConversation documents — one holding the real
// message history, one nearly empty. Whichever one a given screen happened to
// resolve to determined what the user saw, which is why:
//   • the lead's inbound replies looked "lost" (they were saved fine, just on
//     the OTHER conversation doc), and
//   • the employee saw "24-hour session expired" even right after the lead
//     replied (they were looking at the doc whose sessionExpiresAt was never
//     touched).
//
// This helper is the single source of truth for "which conversation record
// represents this lead/phone". Call it everywhere a conversation is resolved
// (webhook inbound, employee/admin chat lookup). It is idempotent and
// self-healing — every call that finds more than one matching record merges
// them into a single canonical one (keeping ALL messages, just re-pointing
// them), so the duplicate problem repairs itself in production without
// needing a manual one-off migration.
// ─────────────────────────────────────────────────────────────────────────────

const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const { hmac } = require("./fieldCrypto");

/**
 * Find every WhatsAppConversation document that could plausibly represent the
 * same lead/phone, merge them into one canonical record, and return it.
 *
 * @param {Object} opts
 * @param {string|null} opts.leadId        Lead._id, if known
 * @param {string[]}    opts.phoneVariants Every phone string worth matching
 *                                         against waPhone (already normalised
 *                                         in whatever formats the callers use
 *                                         — this function does an exact-match
 *                                         $in query, it does not re-normalise)
 * @param {string} opts.companyId
 * @returns {Promise<Object|null>} the canonical conversation (Mongoose doc), or
 *                                 null if nothing matches at all
 */
async function resolveCanonicalConversation({ leadId, phoneVariants = [], companyId }) {
  if (!companyId) return null;

  const or = [];
  if (leadId) or.push({ lead: leadId });
  // waPhone is now encrypted at rest with a random IV, so it can no longer be
  // matched by equality/$in directly — waPhoneHash is the deterministic HMAC
  // of the same plaintext values, so this preserves identical matching
  // semantics to the old `{ waPhone: { $in: phoneVariants } }` query.
  if (phoneVariants.length) or.push({ waPhoneHash: { $in: phoneVariants.map(hmac) } });
  if (!or.length) return null;

  const candidates = await WhatsAppConversation.find({
    company: companyId,
    $or: or,
  }).sort({ createdAt: 1 }); // oldest first — stable tie-break

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    // Still worth backfilling the lead ref if it was created before the lead
    // was matched (e.g. an unknown-number inbound that later got linked).
    if (leadId && !candidates[0].lead) {
      candidates[0].lead = leadId;
      await candidates[0].save();
    }
    return candidates[0];
  }

  // ── More than one candidate → merge ────────────────────────────────────────
  console.warn(
    `⚠️  [conversationMerge] ${candidates.length} duplicate conversations found ` +
    `for lead=${leadId || "?"} phones=${phoneVariants.join(",")} — merging into one`
  );

  const counts = await Promise.all(
    candidates.map((c) => WhatsAppMessage.countDocuments({ conversation: c._id }))
  );

  // Canonical = the one with the most messages (real history wins). Tie-break
  // by most recent lastMessageAt, then by being the oldest record.
  let canonicalIdx = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (counts[i] > counts[canonicalIdx]) {
      canonicalIdx = i;
    } else if (counts[i] === counts[canonicalIdx]) {
      const a = candidates[i].lastMessageAt ? new Date(candidates[i].lastMessageAt).getTime() : 0;
      const b = candidates[canonicalIdx].lastMessageAt ? new Date(candidates[canonicalIdx].lastMessageAt).getTime() : 0;
      if (a > b) canonicalIdx = i;
    }
  }

  const canonical = candidates[canonicalIdx];
  const losers = candidates.filter((_, i) => i !== canonicalIdx);

  // Re-point every message from the losing conversations onto the canonical one.
  const loserIds = losers.map((c) => c._id);
  await WhatsAppMessage.updateMany(
    { conversation: { $in: loserIds } },
    { $set: { conversation: canonical._id } }
  );

  // Merge metadata: take the freshest lastMessage/lastMessageAt/sessionExpiresAt
  // across ALL candidates (not just the canonical one) so a recent inbound that
  // happened to land on a "loser" record isn't lost.
  let bestLastMessageAt = canonical.lastMessageAt || null;
  let bestLastMessage    = canonical.lastMessage || "";
  let bestSessionExpiry  = canonical.sessionExpiresAt || null;
  let bestStatus         = canonical.status;
  let unreadTotal         = canonical.unreadCount || 0;

  for (const loser of losers) {
    unreadTotal += loser.unreadCount || 0;
    if (loser.lastMessageAt && (!bestLastMessageAt || new Date(loser.lastMessageAt) > new Date(bestLastMessageAt))) {
      bestLastMessageAt = loser.lastMessageAt;
      bestLastMessage    = loser.lastMessage;
    }
    if (loser.sessionExpiresAt && (!bestSessionExpiry || new Date(loser.sessionExpiresAt) > new Date(bestSessionExpiry))) {
      bestSessionExpiry = loser.sessionExpiresAt;
    }
    // "waiting" (customer replied, agent hasn't) beats "open"/"closed" when merging,
    // since it reflects whoever has the more recent real activity.
    if (loser.status === "waiting") bestStatus = "waiting";
  }

  canonical.lastMessageAt    = bestLastMessageAt;
  canonical.lastMessage      = bestLastMessage;
  canonical.sessionExpiresAt = bestSessionExpiry;
  canonical.status           = bestStatus;
  canonical.unreadCount      = unreadTotal;
  if (leadId && !canonical.lead) canonical.lead = leadId;
  if (!canonical.assignedAgent) {
    const withAgent = losers.find((l) => l.assignedAgent);
    if (withAgent) canonical.assignedAgent = withAgent.assignedAgent;
  }
  await canonical.save();

  // Delete the now-empty duplicate records.
  await WhatsAppConversation.deleteMany({ _id: { $in: loserIds } });

  console.log(
    `✅ [conversationMerge] merged ${losers.length} duplicate(s) into conversation ${canonical._id} ` +
    `(now has messages from all ${candidates.length} original record(s))`
  );

  return canonical;
}

module.exports = { resolveCanonicalConversation };