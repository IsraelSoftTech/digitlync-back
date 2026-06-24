/**
 * Provider job lifecycle — start / pause / resume / end (operational §11).
 * Shared by REST job-events API and WhatsApp bot commands.
 */
const { pool } = require('../config/db');
const notificationService = require('./notification-service');
const { sendBrandedText, isEnabled } = require('./whatsapp-sender');

const EVENT_TO_STATUS = {
  started: 'in_progress',
  paused: 'in_progress',
  resumed: 'in_progress',
  ended: 'awaiting_farmer_confirmation',
};

const REQUIRED_BOOKING_STATUS = {
  started: ['confirmed'],
  paused: ['in_progress'],
  resumed: ['in_progress'],
  ended: ['in_progress'],
};

const DUPLICATE_EVENT_TYPES = ['started', 'ended'];

async function loadBookingForProvider(bookingId, providerId) {
  const r = await pool.query(
    `SELECT b.*, f.id AS farmer_id, f.full_name AS farmer_name, f.phone AS farmer_phone,
            f.village, f.district,
            p.id AS provider_id, p.full_name AS provider_name, p.phone AS provider_phone
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     JOIN providers p ON b.provider_id = p.id
     WHERE b.id = $1 AND b.provider_id = $2`,
    [bookingId, providerId]
  );
  return r.rows[0] || null;
}

/**
 * @returns {{ ok: true, booking: object, eventType: string } | { ok: false, error: string }}
 */
async function recordProviderJobEvent(bookingId, providerId, eventType, note = null) {
  const normalized = String(eventType || '').trim().toLowerCase();
  if (!EVENT_TO_STATUS[normalized]) {
    return { ok: false, error: 'invalid_event' };
  }

  const booking = await loadBookingForProvider(bookingId, providerId);
  if (!booking) return { ok: false, error: 'not_found' };

  const allowed = REQUIRED_BOOKING_STATUS[normalized] || [];
  if (!allowed.includes(booking.status)) {
    return { ok: false, error: 'bad_status', status: booking.status };
  }

  if (DUPLICATE_EVENT_TYPES.includes(normalized)) {
    const dup = await pool.query(
      `SELECT id FROM booking_job_events WHERE booking_id = $1 AND event_type = $2 LIMIT 1`,
      [bookingId, normalized]
    );
    if (dup.rows.length > 0) {
      return { ok: false, error: 'already_recorded', eventType: normalized };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO booking_job_events (booking_id, actor_type, actor_id, event_type, note)
       VALUES ($1, 'provider', $2, $3, $4)`,
      [bookingId, providerId, normalized, note]
    );
    const newStatus = EVENT_TO_STATUS[normalized];
    const updated = await client.query(
      `UPDATE bookings
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP,
           completed_at = CASE WHEN $1 = 'awaiting_farmer_confirmation' THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = $2
       RETURNING *`,
      [newStatus, bookingId]
    );
    await client.query('COMMIT');

    const farmer = {
      id: booking.farmer_id,
      full_name: booking.farmer_name,
      phone: booking.farmer_phone,
      village: booking.village,
      district: booking.district,
    };
    const provider = {
      id: booking.provider_id,
      full_name: booking.provider_name,
      phone: booking.provider_phone,
    };
    const updatedBooking = { ...booking, ...updated.rows[0] };

    if (normalized === 'started') {
      await notificationService
        .sendJobStartedNotification(bookingId, farmer, provider, updatedBooking)
        .catch((e) => console.error('Job started notification failed:', e.message));
    } else if (normalized === 'ended') {
      await notificationService
        .sendJobCompletedNotification(bookingId, farmer, provider, updatedBooking)
        .catch((e) => console.error('Job completed notification failed:', e.message));
    } else if (isEnabled() && booking.farmer_phone) {
      await sendBrandedText(
        booking.farmer_phone,
        `🔔 *Job update*\n\nProvider has ${normalized} the job.\nBooking #${bookingId}\nService: ${booking.service_type || 'Service'}`
      ).catch((e) => console.error('Job event farmer notify failed:', e.message));
    }

    return { ok: true, booking: updated.rows[0], eventType: normalized };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function providerJobErrorMessage(result) {
  switch (result.error) {
    case 'not_found':
      return 'Booking not found or not assigned to you. Reply *4* for your jobs.';
    case 'bad_status':
      return `This job is in status "${result.status}" and cannot be updated that way. Reply *4* for your jobs.`;
    case 'already_recorded':
      return result.eventType === 'started'
        ? 'This job has already been started.'
        : 'This job has already been marked complete.';
    case 'invalid_event':
      return 'Invalid job command. Reply *4* for your jobs.';
    default:
      return 'Something went wrong. Reply *4* to try again.';
  }
}

module.exports = {
  recordProviderJobEvent,
  providerJobErrorMessage,
  EVENT_TO_STATUS,
};
