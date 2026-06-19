const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');
const { sendBrandedText, isEnabled } = require('../services/whatsapp-sender');
const { sendBotReply, buildOptionListReply } = require('../services/whatsapp-interactive');
const {
  calculateBookingEconomics,
  calculateCancellationFee,
  validateSchedulingWindow,
} = require('../services/operational-core');
const { ensureOperationalSchema } = require('../services/operational-core');

router.get('/', async (req, res) => {
  const { status, unassigned } = req.query;
  try {
    let query = `
      SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, p.full_name AS provider_name, p.phone AS provider_phone
      FROM bookings b
      LEFT JOIN farmers f ON b.farmer_id = f.id
      LEFT JOIN providers p ON b.provider_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ` AND b.status = $${params.length}`;
    }
    if (unassigned === '1' || unassigned === 'true') {
      query += ' AND b.provider_id IS NULL';
    }
    query += ' ORDER BY b.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error('Bookings list error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, f.village AS farmer_village, f.district AS farmer_district,
        p.full_name AS provider_name, p.phone AS provider_phone, p.services_offered,
        p.base_price_per_ha, p.work_capacity_ha_per_hour
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Booking get error:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

router.post('/', async (req, res) => {
  const {
    farmer_id,
    provider_id,
    service_type,
    scheduled_date,
    scheduled_time,
    farm_size_ha,
    farm_produce_type,
    notes,
    budget_min_fcfa,
    budget_max_fcfa,
  } = req.body || {};
  if (!farmer_id) return res.status(400).json({ error: 'Farmer is required' });
  const scheduleValidation = validateSchedulingWindow(scheduled_date);
  if (!scheduleValidation.ok) return res.status(400).json({ error: scheduleValidation.error });
  try {
    let providerEconomics = { providerBaseAmount: null, platformFeeAmount: null, farmerPayableAmount: null };
    if (provider_id && farm_size_ha != null) {
      const p = await pool.query('SELECT base_price_per_ha FROM providers WHERE id = $1', [provider_id]);
      if (p.rows.length > 0) {
        providerEconomics = calculateBookingEconomics({
          providerBasePricePerHa: p.rows[0].base_price_per_ha,
          farmSizeHa: farm_size_ha,
        });
      }
    }
    const result = await pool.query(
      `INSERT INTO bookings (
         farmer_id, provider_id, service_type, status, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes,
         budget_min_fcfa, budget_max_fcfa, provider_base_amount_fcfa, platform_fee_amount_fcfa, farmer_payable_amount_fcfa, payment_status
       )
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        farmer_id,
        provider_id || null,
        service_type?.trim() || null,
        scheduled_date || null,
        scheduled_time || null,
        farm_size_ha != null ? parseFloat(farm_size_ha) : null,
        farm_produce_type?.trim() || null,
        notes?.trim() || null,
        budget_min_fcfa != null ? parseFloat(budget_min_fcfa) : null,
        budget_max_fcfa != null ? parseFloat(budget_max_fcfa) : null,
        providerEconomics.providerBaseAmount,
        providerEconomics.platformFeeAmount,
        providerEconomics.farmerPayableAmount,
        provider_id ? 'held' : 'unfunded',
      ]
    );
    const booking = result.rows[0];
    if (provider_id && booking.farmer_payable_amount_fcfa != null) {
      await pool.query(
        `INSERT INTO booking_payments (booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status)
         VALUES ($1, $2, $3, $4, 'held')
         ON CONFLICT (booking_id) DO NOTHING`,
        [booking.id, booking.farmer_payable_amount_fcfa, booking.provider_base_amount_fcfa, booking.platform_fee_amount_fcfa]
      );
    }
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking created: farmer ${farmer_id} → provider ${provider_id || 'unassigned'} (ID ${booking.id})`, entityType: 'booking', entityId: booking.id });
    res.status(201).json(booking);
  } catch (err) {
    console.error('Booking create error:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

router.put('/:id', async (req, res) => {
  const {
    status,
    scheduled_date,
    scheduled_time,
    farm_size_ha,
    farm_produce_type,
    notes,
    provider_id,
    budget_min_fcfa,
    budget_max_fcfa,
    payout_method,
    farmer_completion_confirmed,
  } = req.body || {};
  try {
    const prevResult = await pool.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, p.full_name AS provider_name, p.phone AS provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (prevResult.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const prev = prevResult.rows[0];

    const scheduleValidation = validateSchedulingWindow(scheduled_date || prev.scheduled_date);
    if (!scheduleValidation.ok) return res.status(400).json({ error: scheduleValidation.error });
    const newProviderId = provider_id !== undefined ? (provider_id || null) : prev.provider_id;
    const finalFarmSizeHa = farm_size_ha != null ? parseFloat(farm_size_ha) : prev.farm_size_ha;
    let economics = {
      providerBaseAmount: prev.provider_base_amount_fcfa,
      platformFeeAmount: prev.platform_fee_amount_fcfa,
      farmerPayableAmount: prev.farmer_payable_amount_fcfa,
    };
    if (newProviderId && finalFarmSizeHa != null) {
      const p = await pool.query('SELECT base_price_per_ha FROM providers WHERE id = $1', [newProviderId]);
      if (p.rows.length > 0) {
        economics = calculateBookingEconomics({ providerBasePricePerHa: p.rows[0].base_price_per_ha, farmSizeHa: finalFarmSizeHa });
      }
    }
    let cancellationRate = prev.cancellation_fee_rate;
    let cancellationAmount = prev.cancellation_fee_amount_fcfa;
    if (status === 'cancelled') {
      const cancellation = calculateCancellationFee({
        farmerPayableAmount: economics.farmerPayableAmount,
        scheduledDate: scheduled_date || prev.scheduled_date,
        scheduledTime: scheduled_time || prev.scheduled_time,
      });
      cancellationRate = cancellation.feeRate;
      cancellationAmount = cancellation.feeAmount;
    }
    const result = await pool.query(
      `UPDATE bookings SET status=COALESCE($1, status), scheduled_date=COALESCE($2, scheduled_date),
        scheduled_time=COALESCE($3, scheduled_time), farm_size_ha=COALESCE($4, farm_size_ha),
        farm_produce_type=COALESCE($5, farm_produce_type), notes=COALESCE($6, notes),
        provider_id=$7, budget_min_fcfa=COALESCE($8, budget_min_fcfa), budget_max_fcfa=COALESCE($9, budget_max_fcfa),
        provider_base_amount_fcfa=$10, platform_fee_amount_fcfa=$11, farmer_payable_amount_fcfa=$12,
        cancellation_fee_rate=$13, cancellation_fee_amount_fcfa=$14,
        payment_status=CASE
          WHEN $1 = 'cancelled' THEN 'cancelled'
          WHEN $15 = true AND status = 'awaiting_farmer_confirmation' THEN 'release_pending'
          ELSE payment_status
        END,
        payout_due_at=CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP + INTERVAL '48 hours' ELSE payout_due_at END,
        updated_at=CURRENT_TIMESTAMP
       WHERE id=$16 RETURNING *`,
      [
        status || null,
        scheduled_date || null,
        scheduled_time || null,
        farm_size_ha != null ? parseFloat(farm_size_ha) : null,
        farm_produce_type !== undefined ? farm_produce_type : null,
        notes !== undefined ? notes : null,
        newProviderId,
        budget_min_fcfa != null ? parseFloat(budget_min_fcfa) : null,
        budget_max_fcfa != null ? parseFloat(budget_max_fcfa) : null,
        economics.providerBaseAmount,
        economics.platformFeeAmount,
        economics.farmerPayableAmount,
        cancellationRate,
        cancellationAmount,
        farmer_completion_confirmed === true,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const booking = result.rows[0];

    if (booking.provider_id && booking.farmer_payable_amount_fcfa != null) {
      await pool.query(
        `INSERT INTO booking_payments (
           booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status, payout_method
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (booking_id)
         DO UPDATE SET
           escrow_amount_fcfa = EXCLUDED.escrow_amount_fcfa,
           provider_amount_fcfa = EXCLUDED.provider_amount_fcfa,
           platform_fee_amount_fcfa = EXCLUDED.platform_fee_amount_fcfa,
           payment_status = CASE
             WHEN EXCLUDED.payment_status IS NOT NULL THEN EXCLUDED.payment_status
             ELSE booking_payments.payment_status
           END,
           payout_method = COALESCE(EXCLUDED.payout_method, booking_payments.payout_method),
           updated_at = CURRENT_TIMESTAMP`,
        [
          booking.id,
          booking.farmer_payable_amount_fcfa,
          booking.provider_base_amount_fcfa,
          booking.platform_fee_amount_fcfa,
          booking.payment_status || 'held',
          payout_method || null,
        ]
      );
    }
    const { adminId, adminUsername } = getAdminFromRequest(req);
    let auditMsg = status ? ` status changed to ${status}` : ' updated';
    if (provider_id != null && !prev.provider_id && booking.provider_id) {
      auditMsg = ` provider assigned (ID ${provider_id})`;
      if (isEnabled()) {
        try {
          const { adminAssignProviderMatch } = require('../services/matching-flow');
          await adminAssignProviderMatch(booking.id, booking.provider_id);
        } catch (e) {
          console.error('[Bookings] manual match notify failed:', e.message);
        }
      }
    }
    if (status === 'cancelled' && isEnabled() && prev.farmer_phone) {
      const policyMsg =
        booking.cancellation_fee_rate >= 0.3
          ? '30% fee applied (<6 hours before service).'
          : booking.cancellation_fee_rate >= 0.1
            ? '10% fee applied (6-24 hours before service).'
            : 'No cancellation fee applied (>=24 hours before service).';
      await sendBrandedText(
        prev.farmer_phone,
        `⚠️ *Booking cancelled*\n\n${policyMsg}\nFee: ${(booking.cancellation_fee_amount_fcfa || 0).toLocaleString()} FCFA`
      ).catch((e) => console.error('[Bookings] cancellation notify farmer failed:', e.message));
    }
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking${auditMsg} (ID ${booking.id})`, entityType: 'booking', entityId: booking.id });
    res.json(booking);
  } catch (err) {
    console.error('Booking update error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking deleted (ID ${req.params.id})`, entityType: 'booking', entityId: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (err) {
    console.error('Booking delete error:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

/**
 * POST /api/bookings/:id/match
 * Admin manual match — assign provider and trigger bot match notifications
 */
router.post('/:id/match', async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  const providerId = parseInt(req.body?.provider_id, 10);
  if (!bookingId || !providerId) {
    return res.status(400).json({ error: 'booking id and provider_id are required' });
  }
  try {
    await ensureOperationalSchema();
    const { adminAssignProviderMatch } = require('../services/matching-flow');
    const booking = await adminAssignProviderMatch(bookingId, providerId);
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({
      adminId,
      adminUsername,
      actionType: 'booking',
      action: `Manual match: booking ${bookingId} → provider ${providerId}`,
      entityType: 'booking',
      entityId: bookingId,
    });
    res.json({ ok: true, booking });
  } catch (err) {
    console.error('Booking match error:', err);
    res.status(500).json({ error: err.message || 'Failed to match booking' });
  }
});

/**
 * POST /api/bookings/:id/confirm
 * Send confirmation messages to farmer and provider
 */
router.post('/:id/confirm', async (req, res) => {
  try {
    const { notificationService } = require('../services/notification-service') || {};
    if (!notificationService) {
      // Load individual functions
      const {
        sendBookingConfirmationToFarmer,
        sendBookingConfirmationToProvider,
      } = require('../services/notification-service');

      const bookingRes = await pool.query(
        `SELECT b.*, f.id as farmer_id, f.full_name as farmer_name, f.phone as farmer_phone,
                p.id as provider_id, p.full_name as provider_name, p.phone as provider_phone
         FROM bookings b
         LEFT JOIN farmers f ON b.farmer_id = f.id
         LEFT JOIN providers p ON b.provider_id = p.id
         WHERE b.id = $1`,
        [req.params.id]
      );

      if (bookingRes.rows.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const booking = bookingRes.rows[0];
      const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
      const provider = { id: booking.provider_id, full_name: booking.provider_name, phone: booking.provider_phone };

      await sendBookingConfirmationToFarmer(booking.id, farmer, provider, booking);
      await sendBookingConfirmationToProvider(booking.id, farmer, provider, booking);

      res.json({
        success: true,
        bookingId: booking.id,
        message: 'Confirmation messages sent to farmer and provider',
      });
    }
  } catch (err) {
    console.error('Booking confirmation error:', err);
    res.status(500).json({ error: 'Failed to send confirmation: ' + err.message });
  }
});

/**
 * POST /api/bookings/:id/complete
 * Farmer confirms job completion, triggers payment release
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const { confirmWorkAndReleasePayment } = require('../services/matching-flow');
    const bookingId = parseInt(req.params.id, 10);
    await ensureOperationalSchema();
    const result = await confirmWorkAndReleasePayment(bookingId, null);
    res.json({
      success: true,
      ...result.paymentResult,
      message: 'Work confirmed and payment released',
    });
  } catch (err) {
    console.error('Booking completion error:', err);
    res.status(500).json({ error: 'Failed to complete booking: ' + err.message });
  }
});

module.exports = router;
