// scripts/createTwimlApp.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// FIX (Render → Hetzner migration): the voice URL was hardcoded to the now-
// decommissioned onrender.com domain. Twilio's voiceUrl is a REGISTERED
// setting on Twilio's side (in their API/console) — editing this file alone
// does nothing until this script (or the Twilio console) actually pushes the
// change to Twilio. Update VOICE_URL below if your domain differs.
const VOICE_URL = 'https://skyupcrm-backend.duckdns.org/api/twilio/voice';

async function createOrUpdateApp() {
  // FIX: this used to always CREATE a brand-new TwiML app every time it ran —
  // fine for first-time setup, but running it again after a domain migration
  // would create a SECOND app with the new URL while the ORIGINAL app (the
  // one actually referenced by TWILIO_TWIML_APP_SID in .env, and thus the one
  // Twilio actually uses for live calls) kept pointing at the dead Render
  // URL. Now: if TWILIO_TWIML_APP_SID is already set, UPDATE that existing
  // app's voiceUrl in place instead of creating an orphaned duplicate.
  const existingSid = process.env.TWILIO_TWIML_APP_SID;

  if (existingSid) {
    const app = await client.applications(existingSid).update({
      voiceUrl: VOICE_URL,
      voiceMethod: 'POST',
    });
    console.log(`✅ Updated existing TwiML App ${app.sid} → voiceUrl: ${VOICE_URL}`);
    console.log('   No .env change needed — TWILIO_TWIML_APP_SID is unchanged.');
  } else {
    const app = await client.applications.create({
      friendlyName: 'CRM Voice App',
      voiceUrl: VOICE_URL,
      voiceMethod: 'POST',
    });
    console.log('✅ Created new TwiML App SID:', app.sid);
    console.log('   Paste this into your .env as TWILIO_TWIML_APP_SID');
  }
}

createOrUpdateApp().catch((err) => {
  console.error('❌ Failed to create/update TwiML app:', err.message);
  process.exit(1);
});