// services/adReferral.js — NEW FILE
// Click-to-WhatsApp (CTWA) ads. When someone taps such an ad and messages you, Meta puts a `referral`
// object on their FIRST WhatsApp message:
//   { source_type: "ad", source_id: "<ad id>", source_url, headline, body, ctwa_clid, ... }
// source_id is the ad's id — exactly the "which ad did this lead come from" answer, and it was being
// thrown away. We keep it on the conversation, and on the lead once one is linked.
"use strict";

// A lead whose STORED channel was only a guess (WhatsApp / organic / other) is really a Meta ad lead once we
// know the ad, so it is corrected to "meta". (A lead with no stored channel needs no correction: the channel
// logic already treats any lead that has an ad id as Meta.) Google, LinkedIn, website… are left alone.
const GUESSED_CHANNELS = ["whatsapp", "organic", "other"];

function shapeReferral(r) {
  if (!r || !r.source_id) return null;
  const type = String(r.source_type || "ad").toLowerCase();
  if (type !== "ad") return null;                       // posts / pages etc. are not an ad
  const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
  return {
    sourceId: clip(r.source_id, 64), sourceType: type, sourceUrl: clip(r.source_url, 500),
    headline: clip(r.headline, 300), body: clip(r.body, 1000), ctwaClid: clip(r.ctwa_clid, 300), capturedAt: new Date(),
  };
}

// Fill in the lead's ad id (never overwrite an exact one that came from a lead form) and, if its
// channel was only a guess, mark it as Meta. Bookkeeping only — never counts as lead activity.
async function attachAdToLead(Lead, leadId, sourceId) {
  if (!leadId || !sourceId) return;
  await Lead.updateOne(
    { _id: leadId, $or: [{ "attribution.metaAdId": null }, { "attribution.metaAdId": "" }, { "attribution.metaAdId": { $exists: false } }] },
    { $set: { "attribution.metaAdId": String(sourceId) } },
    { timestamps: false },
  );
  await Lead.updateOne(
    { _id: leadId, "attribution.channel": { $in: GUESSED_CHANNELS } },
    { $set: { "attribution.channel": "meta" } },
    { timestamps: false },
  );
}

// Called for every inbound WhatsApp message. `models` = { Lead, WhatsAppConversation }.
// The FIRST ad that started the conversation is kept (a later message can't replace it).
async function recordAdReferral(models, conversation, rawReferral) {
  const ref = shapeReferral(rawReferral);
  if (!ref) return null;
  if (!conversation.adReferral || !conversation.adReferral.sourceId) {
    await models.WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { adReferral: ref } });
  }
  if (conversation.lead) await attachAdToLead(models.Lead, conversation.lead, ref.sourceId);
  return ref;
}

module.exports = { shapeReferral, attachAdToLead, recordAdReferral, GUESSED_CHANNELS };
