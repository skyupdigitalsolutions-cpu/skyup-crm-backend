// scripts/createTwimlApp.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function createApp() {
  const app = await client.applications.create({
    friendlyName: 'CRM Voice App',
    voiceUrl: 'https://skyup-crm-backend.onrender.com/api/twilio/voice', // replace with your server URL
    voiceMethod: 'POST',
  });
  console.log('TwiML App SID:', APf37f976714e5e0a67817a931e3a0c0ce); // paste this into your .env
}

createApp();