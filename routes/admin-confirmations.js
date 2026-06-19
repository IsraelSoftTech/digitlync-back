const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAdmin } = require('../middleware/admin-auth');
const paymentProcessor = require('../services/payment-processor');
const { confirmWorkAndReleasePayment } = require('../services/matching-flow');
const { ensureOperationalSchema } = require('../services/operational-core');

// GET /api/admin-confirmations/work - bookings awaiting work confirmation
router.get('/work', requireAdmin, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT b.id, b.service_type, b.farmer_id, f.full_name AS farmer_name, b.provider_id,
              p.full_name AS provider_name, b.status, b.farmer_payable_amount_fcfa, b.payment_status,
              b.scheduled_date, b.created_at
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.provider_id IS NOT NULL
         AND b.status = 'confirmed'
         AND b.payment_status = 'held'
         AND b.completion_verified_at IS NULL
       ORDER BY b.created_at DESC
       LIMIT 200`
    );
    res.json({ ok: true, bookings: q.rows });
  } catch (err) {
    console.error('admin-confirmations work list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin-confirmations/ - bookings needing manual payment release
router.get('/', requireAdmin, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT b.id, b.service_type, b.farmer_id, f.full_name AS farmer_name, b.provider_id,
              p.full_name AS provider_name, b.status, b.farmer_payable_amount_fcfa, b.payment_status,
              b.completion_verified_at, b.created_at
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.provider_id IS NOT NULL
         AND b.completion_verified_at IS NOT NULL
         AND b.payment_status IN ('held', 'release_pending')
       ORDER BY b.created_at DESC
       LIMIT 200`
    );
    res.json({ ok: true, bookings: q.rows });
  } catch (err) {
    console.error('admin-confirmations list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin-confirmations/:id/confirm-work - admin confirms work is done
router.post('/:id/confirm-work', requireAdmin, async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  if (!bookingId) return res.status(400).json({ ok: false, error: 'invalid_booking_id' });
  try {
    await ensureOperationalSchema();
    const result = await confirmWorkAndReleasePayment(bookingId, null);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('admin-confirmations confirm-work error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin-confirmations/:id/release - manually release payment (admin)
router.post('/:id/release', requireAdmin, async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  if (!bookingId) return res.status(400).json({ ok: false, error: 'invalid_booking_id' });
  try {
    await ensureOperationalSchema();
    const result = await paymentProcessor.processPaymentRelease(bookingId, null, true);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('admin-confirmations release error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
