const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { sendBrandedText, isEnabled } = require('../services/whatsapp-sender');

const EVENT_TO_STATUS = {
  started: 'in_progress',
  paused: 'in_progress',
  resumed: 'in_progress',
  ended: 'awaiting_farmer_confirmation',
};

router.get('/booking/:bookingId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM booking_job_events WHERE booking_id = $1 ORDER BY created_at DESC`,
      [req.params.bookingId]
    );
    res.json({ events: r.rows });
  } catch (err) {
    console.error('Job events list error:', err);
    res.status(500).json({ error: 'Failed to fetch job events' });
  }
});

router.post('/booking/:bookingId', async (req, res) => {
  const { event_type, actor_type, actor_id, note } = req.body || {};
  if (!event_type || !EVENT_TO_STATUS[event_type]) {
    return res.status(400).json({ error: 'event_type must be one of: started, paused, resumed, ended' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bookingR = await client.query(
      `SELECT b.*, f.id as farmer_id, f.full_name as farmer_name, f.phone AS farmer_phone, 
              p.id as provider_id, p.full_name as provider_name, p.phone AS provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON f.id = b.farmer_id
       LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.id = $1`,
      [req.params.bookingId]
    );
    if (bookingR.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    const booking = bookingR.rows[0];
    await client.query(
      `INSERT INTO booking_job_events (booking_id, actor_type, actor_id, event_type, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.bookingId, actor_type || 'provider', actor_id || null, event_type, note || null]
    );
    const newStatus = EVENT_TO_STATUS[event_type];
    const updated = await client.query(
      `UPDATE bookings
       SET status = $1, updated_at = CURRENT_TIMESTAMP, completed_at = CASE WHEN $1 = 'awaiting_farmer_confirmation' THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = $2
       RETURNING *`,
      [newStatus, req.params.bookingId]
    );
    await client.query('COMMIT');

    // Send detailed notifications
    const notificationService = require('../services/notification-service');
    const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
    const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };

    if (event_type === 'started') {
      await notificationService.sendJobStartedNotification(booking.id, farmer, provider, booking).catch(e => console.error('Job started notification failed:', e.message));
    } else if (event_type === 'ended') {
      await notificationService.sendJobCompletedNotification(booking.id, farmer, provider, booking).catch(e => console.error('Job completion notification failed:', e.message));
    } else if (isEnabled() && booking.farmer_phone) {
      await sendBrandedText(
        booking.farmer_phone,
        `🔔 *Job update*\n\nProvider has ${event_type} the job.\nBooking #${req.params.bookingId}\nService: ${booking.service_type || 'Service'}`
      ).catch((e) => console.error('Job event farmer notify failed:', e.message));
    }

    res.status(201).json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Job event create error:', err);
    res.status(500).json({ error: 'Failed to create job event' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/job-events/:bookingId/start
 * Convenience endpoint for provider to mark job as started
 */
router.post('/:bookingId/start', async (req, res) => {
  try {
    const eventRes = await pool.query(
      `SELECT * FROM booking_job_events WHERE booking_id = $1 AND event_type = 'started'`,
      [req.params.bookingId]
    );

    if (eventRes.rows.length > 0) {
      return res.status(400).json({ error: 'Job already started' });
    }

    const result = await pool.query(
      `INSERT INTO booking_job_events (booking_id, actor_type, actor_id, event_type, note)
       VALUES ($1, 'provider', NULL, 'started', 'Job started')
       RETURNING *`,
      [req.params.bookingId]
    );

    await pool.query(
      `UPDATE bookings SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.bookingId]
    );

    // Send notification
    const bookingRes = await pool.query(
      `SELECT b.*, f.id as farmer_id, f.full_name as farmer_name, f.phone as farmer_phone,
              p.id as provider_id, p.full_name as provider_name, p.phone as provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON f.id = b.farmer_id
       LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.id = $1`,
      [req.params.bookingId]
    );

    if (bookingRes.rows.length > 0) {
      const booking = bookingRes.rows[0];
      const notifService = require('../services/notification-service');
      const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
      const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };
      await notifService.sendJobStartedNotification(booking.id, farmer, provider, booking).catch(e => console.error('Start notification failed:', e.message));
    }

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('Job start error:', err);
    res.status(500).json({ error: 'Failed to start job' });
  }
});

/**
 * POST /api/job-events/:bookingId/complete
 * Convenience endpoint for provider to mark job as completed
 */
router.post('/:bookingId/complete', async (req, res) => {
  try {
    const eventRes = await pool.query(
      `SELECT * FROM booking_job_events WHERE booking_id = $1 AND event_type = 'ended'`,
      [req.params.bookingId]
    );

    if (eventRes.rows.length > 0) {
      return res.status(400).json({ error: 'Job already marked as completed' });
    }

    const result = await pool.query(
      `INSERT INTO booking_job_events (booking_id, actor_type, actor_id, event_type, note)
       VALUES ($1, 'provider', NULL, 'ended', 'Job completed')
       RETURNING *`,
      [req.params.bookingId]
    );

    await pool.query(
      `UPDATE bookings SET status = 'awaiting_farmer_confirmation', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.bookingId]
    );

    // Send notification
    const bookingRes = await pool.query(
      `SELECT b.*, f.id as farmer_id, f.full_name as farmer_name, f.phone as farmer_phone,
              p.id as provider_id, p.full_name as provider_name, p.phone as provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON f.id = b.farmer_id
       LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.id = $1`,
      [req.params.bookingId]
    );

    if (bookingRes.rows.length > 0) {
      const booking = bookingRes.rows[0];
      const notifService = require('../services/notification-service');
      const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
      const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };
      await notifService.sendJobCompletedNotification(booking.id, farmer, provider, booking).catch(e => console.error('Completion notification failed:', e.message));
    }

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('Job completion error:', err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

module.exports = router;
