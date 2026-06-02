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
      `SELECT b.*, f.phone AS farmer_phone, p.phone AS provider_phone
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

    if (isEnabled() && booking.farmer_phone) {
      const verb = event_type === 'ended' ? 'ended the job and is awaiting your completion confirmation' : `${event_type} the job`;
      await sendBrandedText(
        booking.farmer_phone,
        `🔔 *Job update*\n\nProvider has ${verb}.\nBooking #${req.params.bookingId}\nService: ${booking.service_type || 'Service'}`
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

module.exports = router;
