const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { sendBrandedText, isEnabled } = require('../services/whatsapp-sender');
const { recordProviderJobEvent } = require('../services/provider-job-flow');

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
    const allowed = REQUIRED_BOOKING_STATUS[event_type] || [];
    if (!allowed.includes(booking.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Booking status '${booking.status}' cannot accept event '${event_type}'`,
      });
    }
    await client.query(
      `INSERT INTO booking_job_events (booking_id, actor_type, actor_id, event_type, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.bookingId, actor_type || 'provider', actor_id || null, event_type, note || null]
    );
    const newStatus = EVENT_TO_STATUS[event_type];
    const updated = await client.query(
      `UPDATE bookings
       SET status = $1, updated_at = CURRENT_TIMESTAMP,
           completed_at = CASE WHEN $1 = 'awaiting_farmer_confirmation' THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE id = $2
       RETURNING *`,
      [newStatus, req.params.bookingId]
    );
    await client.query('COMMIT');

    const notificationService = require('../services/notification-service');
    const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
    const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };

    if (event_type === 'started') {
      await notificationService
        .sendJobStartedNotification(booking.id, farmer, provider, booking)
        .catch((e) => console.error('Job started notification failed:', e.message));
    } else if (event_type === 'ended') {
      await notificationService
        .sendJobCompletedNotification(booking.id, farmer, provider, booking)
        .catch((e) => console.error('Job completion notification failed:', e.message));
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
 */
router.post('/:bookingId/start', async (req, res) => {
  try {
    const bookingId = parseInt(req.params.bookingId, 10);
    const providerId = parseInt(req.body?.provider_id, 10);
    if (!providerId) {
      return res.status(400).json({ error: 'provider_id is required' });
    }
    const result = await recordProviderJobEvent(bookingId, providerId, 'started', 'Job started');
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 400;
      return res.status(status).json({ error: result.error, bookingStatus: result.status });
    }
    res.json({ success: true, booking: result.booking });
  } catch (err) {
    console.error('Job start error:', err);
    res.status(500).json({ error: 'Failed to start job' });
  }
});

/**
 * POST /api/job-events/:bookingId/complete
 */
router.post('/:bookingId/complete', async (req, res) => {
  try {
    const bookingId = parseInt(req.params.bookingId, 10);
    const providerId = parseInt(req.body?.provider_id, 10);
    if (!providerId) {
      return res.status(400).json({ error: 'provider_id is required' });
    }
    const result = await recordProviderJobEvent(bookingId, providerId, 'ended', 'Job completed');
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 400;
      return res.status(status).json({ error: result.error, bookingStatus: result.status });
    }
    res.json({ success: true, booking: result.booking });
  } catch (err) {
    console.error('Job completion error:', err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

module.exports = router;
