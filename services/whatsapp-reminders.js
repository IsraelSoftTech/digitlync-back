/**
 * WhatsApp booking reminders
 * Sends reminders to farmers and providers before scheduled bookings.
 * Call from cron: node scripts/run-reminders.js (or similar)
 */
const { pool } = require('../config/db');
const { sendBrandedText, isEnabled } = require('./whatsapp-sender');

const REMINDER_INTERVALS = [
  { label: '4m', days: 120 },
  { label: '3m', days: 90 },
  { label: '2m', days: 60 },
  { label: '1m', days: 30 },
  { label: '2w', days: 14 },
  { label: '5d', days: 5 },
  { label: '2d', days: 2 },
  { label: '1d', days: 1 },
  { label: '2h', hours: 2 },
];

function classifyInterval(targetDate, now = new Date()) {
  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs < 0) return null;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;
  for (const i of REMINDER_INTERVALS) {
    if (i.days != null && Math.abs(diffDays - i.days) <= 0.5) return i.label;
    if (i.hours != null && Math.abs(diffHours - i.hours) <= 0.5) return i.label;
  }
  return null;
}

/** Send reminders across all configured intervals */
async function sendUpcomingReminders() {
  if (!isEnabled()) {
    console.log('[Reminders] WhatsApp not configured, skipping');
    return { sent: 0, errors: 0 };
  }

  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, b.scheduled_time, b.farm_size_ha,
        f.full_name AS farmer_name, f.phone AS farmer_phone,
        p.full_name AS provider_name, p.phone AS provider_phone
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     JOIN providers p ON b.provider_id = p.id
     WHERE b.status IN ('confirmed', 'in_progress', 'awaiting_farmer_confirmation')
       AND b.scheduled_date IS NOT NULL`
  );

  let sent = 0;
  let errors = 0;

  for (const b of r.rows) {
    const target = new Date(`${String(b.scheduled_date).slice(0, 10)}T${String(b.scheduled_time || '00:00:00').slice(0, 8)}`);
    const intervalLabel = classifyInterval(target);
    if (!intervalLabel) continue;
    const alreadyFarmer = await pool.query(
      `SELECT 1 FROM booking_reminder_logs WHERE booking_id = $1 AND interval_label = $2 AND recipient_type = 'farmer'`,
      [b.id, intervalLabel]
    );
    const alreadyProvider = await pool.query(
      `SELECT 1 FROM booking_reminder_logs WHERE booking_id = $1 AND interval_label = $2 AND recipient_type = 'provider'`,
      [b.id, intervalLabel]
    );
    const timeStr = b.scheduled_time ? ` at ${String(b.scheduled_time).slice(0, 5)}` : '';
    const base = `🔔 *Reminder (${intervalLabel}):* Upcoming booking${timeStr}.\n\n` +
      `Service: ${b.service_type || 'Service'}\n` +
      `Size: ${b.farm_size_ha || '—'} ha\n`;

    if (alreadyFarmer.rows.length === 0) {
      try {
        await sendBrandedText(b.farmer_phone, base + `Provider: ${b.provider_name || '—'}\n\nPlease be on time. Reply *MENU* for options.`);
        await pool.query(
          `INSERT INTO booking_reminder_logs (booking_id, interval_label, recipient_type) VALUES ($1, $2, 'farmer')`,
          [b.id, intervalLabel]
        );
        sent++;
      } catch (e) {
        console.error('[Reminders] Farmer send failed:', b.farmer_phone, e.message);
        errors++;
      }
    }

    if (alreadyProvider.rows.length === 0) {
      try {
        await sendBrandedText(b.provider_phone, base + `Farmer: ${b.farmer_name || '—'}\n\nPlease be on time. Reply *MENU* for options.`);
        await pool.query(
          `INSERT INTO booking_reminder_logs (booking_id, interval_label, recipient_type) VALUES ($1, $2, 'provider')`,
          [b.id, intervalLabel]
        );
        sent++;
      } catch (e) {
        console.error('[Reminders] Provider send failed:', b.provider_phone, e.message);
        errors++;
      }
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
      await sendBrandedText(row.farmer_phone,
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
