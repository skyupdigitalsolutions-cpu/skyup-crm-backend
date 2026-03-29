// scripts/createTwimlApp.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function createApp() {
  const app = await client.applications.create({
    friendlyName: 'CRM Voice App',
    voiceUrl: 'https://skyup-crm-backend.onrender.com/api/twilio/voice',
    voiceMethod: 'POST',
  });
  console.log('TwiML App SID:', app.sid); // paste this into your .env as TWILIO_TWIML_APP_SID
}

createApp();