/**
 * WhatsApp booking reminders
 * Sends reminders to farmers and providers before scheduled bookings.
 * Call from cron: node scripts/run-reminders.js (or similar)
 */
const { pool } = require('../config/db');
const { sendText, isEnabled } = require('./whatsapp-sender');

/** Send reminders for bookings in the next 24 hours */
async function sendUpcomingReminders() {
  if (!isEnabled()) {
    console.log('[Reminders] WhatsApp not configured, skipping');
    return { sent: 0, errors: 0 };
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().slice(0, 10);

  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, b.scheduled_time, b.farm_size_ha,
        f.full_name AS farmer_name, f.phone AS farmer_phone,
        p.full_name AS provider_name, p.phone AS provider_phone
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     JOIN providers p ON b.provider_id = p.id
     WHERE b.status = 'confirmed' AND b.scheduled_date = $1`,
    [dateStr]
  );

  let sent = 0;
  let errors = 0;

  for (const b of r.rows) {
    const timeStr = b.scheduled_time ? ` at ${String(b.scheduled_time).slice(0, 5)}` : '';
    const base = `🔔 *Reminder:* Your Digilync booking is tomorrow${timeStr}.\n\n` +
      `Service: ${b.service_type || 'Service'}\n` +
      `Size: ${b.farm_size_ha || '—'} ha\n`;

    try {
      await sendText(b.farmer_phone, base + `Provider: ${b.provider_name || '—'}\n\nPlease be on time. Reply *MENU* for options.`);
      sent++;
    } catch (e) {
      console.error('[Reminders] Farmer send failed:', b.farmer_phone, e.message);
      errors++;
    }

    try {
      await sendText(b.provider_phone, base + `Farmer: ${b.farmer_name || '—'}\n\nPlease be on time. Reply *MENU* for options.`);
      sent++;
    } catch (e) {
      console.error('[Reminders] Provider send failed:', b.provider_phone, e.message);
      errors++;
    }
  }

  return { sent, errors, count: r.rows.length };
}

/** Send "rate your service" prompt to farmers with completed bookings (no rating yet) */
async function sendRatingPrompts() {
  if (!isEnabled()) return { sent: 0 };

  const r = await pool.query(
    `SELECT b.id, b.farmer_id, f.phone AS farmer_phone, f.full_name AS farmer_name,
        p.full_name AS provider_name, b.service_type
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     JOIN providers p ON b.provider_id = p.id
     LEFT JOIN farmer_ratings fr ON fr.booking_id = b.id
     WHERE b.status = 'completed' AND fr.id IS NULL
       AND b.updated_at > NOW() - INTERVAL '7 days'
     LIMIT 20`
  );

  let sent = 0;
  for (const row of r.rows) {
    try {
      await sendText(row.farmer_phone,
        `✅ *Service completed!*\n\n` +
        `How was your experience with *${row.provider_name}* (${row.service_type})?\n\n` +
        'Reply *RATE* to rate this service (1-5 stars).'
      );
      sent++;
    } catch (e) {
      console.error('[Reminders] Rating prompt failed:', row.farmer_phone, e.message);
    }
  }
  return { sent };
}

module.exports = {
  sendUpcomingReminders,
  sendRatingPrompts,
};
