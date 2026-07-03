// controllers/devTestFollowUpReminderController.js
// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — FOR TESTING ONLY. Safe to delete once you've confirmed the
// follow-up reminder automation (jobs/followUpReminderJob.js) works.
//
// Lets you manually trigger the follow-up reminder check on demand instead of
// waiting for the real 9:30 AM / 8:30 PM IST cron windows, so you can verify:
//   • the crm_followup_reminder WhatsApp template sends correctly (or see the
//     exact MSG91 rejection reason if it's still pending/rejected approval)
//   • the Email half sends correctly
//   • which leads are being matched as "due"
//
// TO REMOVE WHEN DONE TESTING:
//   1. Delete this file.
//   2. In routes/developerRoutes.js, remove the require() line and the
//      `router.get("/test-followup-reminder", ...)` line that reference it.
//
// Protected by the same protectUnified + authorizeRoles("developer") gate as
// every other developer route — requires a valid developer JWT.
// ─────────────────────────────────────────────────────────────────────────────

const { runFollowUpReminderCheck } = require("../jobs/followUpReminderJob");

// GET /api/developer/test-followup-reminder?slot=morning
// slot: "morning" | "evening" (defaults to "morning")
const testFollowUpReminder = async (req, res) => {
  try {
    const slot = req.query.slot === "evening" ? "evening" : "morning";
    console.log(`[devTest] Manually triggering follow-up reminder check — slot="${slot}"`);

    const result = await runFollowUpReminderCheck(slot);

    return res.status(200).json({
      success: true,
      slot,
      matched: result.matched,
      sent:    result.sent,
      details: result.details,
      note:
        "Check each entry's `results` array for per-channel status (sent/skipped/failed) " +
        "and `detail` for the exact reason (e.g. MSG91 template rejection message).",
    });
  } catch (err) {
    console.error("[devTest] testFollowUpReminder error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { testFollowUpReminder };