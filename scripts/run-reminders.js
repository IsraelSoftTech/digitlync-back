/**
 * Run WhatsApp booking reminders
 * Schedule via cron: 0 8 * * * node /path/to/backend/scripts/run-reminders.js
 * (Runs daily at 8 AM)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sendUpcomingReminders, sendRatingPrompts } = require('../services/whatsapp-reminders');

async function run() {
  console.log('[Reminders] Starting...');
  const upcoming = await sendUpcomingReminders();
  console.log('[Reminders] Upcoming:', upcoming);
  const rating = await sendRatingPrompts();
  console.log('[Reminders] Rating prompts:', rating);
  console.log('[Reminders] Done.');
}

run().catch((err) => {
  console.error('[Reminders] Error:', err);
  process.exit(1);
});
