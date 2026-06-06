const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE d.status = $1';
    }
    const r = await pool.query(
      `SELECT d.*, b.service_type, b.status AS booking_status, b.payment_status,
              f.full_name AS farmer_name, p.full_name AS provider_name
       FROM booking_disputes d
       JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       ${where}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ disputes: r.rows });
  } catch (err) {
    console.error('Disputes list error:', err);
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

router.post('/', async (req, res) => {
  const { booking_id, raised_by, reason, evidence } = req.body || {};
  if (!booking_id || !raised_by || !reason) {
    return res.status(400).json({ error: 'booking_id, raised_by and reason are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `INSERT INTO booking_disputes (booking_id, raised_by, reason, evidence)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [booking_id, String(raised_by), String(reason), evidence || null]
    );
    await client.query(
      `UPDATE bookings SET payment_status = 'on_hold', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [booking_id]
    );
    await client.query(
      `UPDATE booking_payments SET payment_status = 'on_hold', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1`,
      [booking_id]
    );
    await client.query('COMMIT');
    res.status(201).json(d.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Dispute create error:', err);
    res.status(500).json({ error: 'Failed to create dispute' });
  } finally {
    client.release();
  }
});

router.put('/:id/resolve', async (req, res) => {
  const { resolution_note, payment_action } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM booking_disputes WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dispute not found' });
    }
    const dispute = current.rows[0];
    const updated = await client.query(
      `UPDATE booking_disputes
       SET status = 'resolved', resolution_note = $1, resolved_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [resolution_note || null, req.params.id]
    );

    // Get booking details for notification
    const bookingRes = await client.query(
      `SELECT b.*, f.id as farmer_id, f.full_name as farmer_name, f.phone as farmer_phone,
              p.id as provider_id, p.full_name as provider_name, p.phone as provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [dispute.booking_id]
    );
    const booking = bookingRes.rows[0];

    if (payment_action === 'release') {
      await client.query(`UPDATE bookings SET payment_status = 'released', payment_released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [dispute.booking_id]);
      await client.query(`UPDATE booking_payments SET payment_status = 'released', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1`, [dispute.booking_id]);

      // Send payment released notifications
      if (booking) {
        const notifService = require('../services/notification-service');
        const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
        const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };
        await notifService.sendPaymentReleasedNotification(dispute.booking_id, farmer, provider, booking).catch(e => console.error('Payment released notification failed:', e.message));
      }
    }
    if (payment_action === 'refund') {
      await client.query(`UPDATE bookings SET payment_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [dispute.booking_id]);
      await client.query(`UPDATE booking_payments SET payment_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1`, [dispute.booking_id]);

      // Send refund notification to farmer
      if (booking && booking.farmer_phone) {
        const { sendBrandedText } = require('../services/whatsapp-sender');
        await sendBrandedText(
          booking.farmer_phone,
          `💰 Dispute Resolved - Refund Issued\n\nYour dispute on booking #${dispute.booking_id} has been resolved. Your full payment has been refunded.\n\nReason: ${resolution_note || 'As per dispute resolution'}`
        ).catch(e => console.error('Refund notification failed:', e.message));
      }
    }

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Dispute resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve dispute' });
  } finally {
    client.release();
  }
});

module.exports = router;
