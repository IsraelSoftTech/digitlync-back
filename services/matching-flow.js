/**
 * Booking lifecycle: farmer selection → provider accept → escrow → completion.
 * Aligns with operational.txt (no auto-match without farmer choice).
 */
const { pool } = require('../config/db');
const { sendBrandedText } = require('./whatsapp-sender');
const { buildOptionListReply, sendBotReply } = require('./whatsapp-interactive');
const {
  calculateBookingEconomics,
  calculateServiceEconomics,
} = require('./operational-core');
const paymentProcessor = require('./payment-processor');
const notificationService = require('./notification-service');

function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizePayoutMethod(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === '1' || t.includes('momo') || t.includes('mobile')) return 'mobile_money';
  if (t === '0' || t.includes('orange')) return 'orange_money';
  return null;
}

function normalizeFarmerPaymentMethod(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.includes('momo') || t.includes('mobile') || t === '1') return 'mobile_money';
  if (t.includes('orange') || t === '2' || t === '0') return 'orange_money';
  return null;
}

/** Resolve rate card for a provider + service (provider_services row or ha fallback). */
async function resolveServiceRate(providerId, serviceType, requestedQty) {
  const qty = Number(requestedQty) || 0;
  const svc = String(serviceType || '').trim();
  const ps = await pool.query(
    `SELECT * FROM provider_services
     WHERE provider_id = $1 AND service_name ILIKE $2
     ORDER BY id LIMIT 1`,
    [providerId, svc]
  );
  if (ps.rows.length > 0) {
    const row = ps.rows[0];
    const minQty = row.min_service_qty != null ? parseFloat(row.min_service_qty) : 1;
    const basePrice =
      row.base_price_fcfa != null
        ? parseFloat(row.base_price_fcfa)
        : row.base_price_per_ha != null
          ? parseFloat(row.base_price_per_ha) * (minQty || 1)
          : 0;
    const economics = calculateServiceEconomics({
      minServiceQty: minQty || 1,
      basePriceFcfa: basePrice,
      requestedQty: qty,
      baseDurationDays: row.base_duration_days,
      baseDurationHours: row.base_duration_hours,
    });
    return {
      providerServiceId: row.id,
      economics,
      rateCard: row,
    };
  }
  const p = await pool.query('SELECT base_price_per_ha FROM providers WHERE id = $1', [providerId]);
  const priceHa = p.rows[0]?.base_price_per_ha || 0;
  const economics = calculateBookingEconomics({
    providerBasePricePerHa: priceHa,
    farmSizeHa: qty,
  });
  return { providerServiceId: null, economics, rateCard: null };
}

async function lockAvailabilitySlot(slotId) {
  if (!slotId) return;
  await pool.query(
    `UPDATE provider_availability_slots SET is_booked = TRUE WHERE id = $1 AND is_booked = FALSE`,
    [slotId]
  );
}

async function unlockAvailabilitySlot(slotId) {
  if (!slotId) return;
  await pool.query(`UPDATE provider_availability_slots SET is_booked = FALSE WHERE id = $1`, [slotId]);
}

async function createAwaitingProviderBooking(farmerId, providerId, requestData, economics, slotId, providerServiceId) {
  const ins = await pool.query(
    `INSERT INTO bookings (
       farmer_id, provider_id, service_type, status, scheduled_date, scheduled_time, farm_size_ha,
       budget_min_fcfa, budget_max_fcfa, provider_base_amount_fcfa, platform_fee_amount_fcfa,
       farmer_payable_amount_fcfa, payment_status, availability_slot_id, requested_qty,
       provider_service_id, estimated_duration_days, estimated_duration_hours
     )
     VALUES ($1, $2, $3, 'awaiting_provider_accept', $4, $5, $6, $7, $8, $9, $10, $11, 'unfunded',
             $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      farmerId,
      providerId,
      requestData.service_type,
      requestData.scheduled_date || null,
      requestData.scheduled_time || null,
      requestData.farm_size_ha,
      requestData.budget_min_fcfa || null,
      requestData.budget_max_fcfa || null,
      economics.providerBaseAmount,
      economics.platformFeeAmount,
      economics.farmerPayableAmount,
      slotId || null,
      requestData.requested_qty ?? requestData.farm_size_ha,
      providerServiceId || null,
      economics.estimatedDurationDays,
      economics.estimatedDurationHours,
    ]
  );
  if (slotId) await lockAvailabilitySlot(slotId);
  return ins.rows[0];
}

async function notifyProviderBookingRequest(booking, farmer, provider) {
  const priceStr = roundMoney(booking.farmer_payable_amount_fcfa).toLocaleString();
  const dateStr = booking.scheduled_date ? String(booking.scheduled_date).slice(0, 10) : 'TBD';
  const timeStr = booking.scheduled_time ? String(booking.scheduled_time).slice(0, 5) : 'TBD';
  const list = buildOptionListReply(
    `*New booking request #${booking.id}*\n\n` +
      `Farmer: ${farmer.full_name || farmer.name || 'Farmer'}\n` +
      `Service: ${booking.service_type}\n` +
      `Date: ${dateStr} at ${timeStr}\n` +
      `Farm size: ${booking.farm_size_ha || '—'} ha\n` +
      `Farmer pays: ${priceStr} FCFA (your share after commission on completion)\n\n` +
      'Accept only if you can complete 100% of the service on time.',
    [
      { id: `accept_${booking.id}`, title: 'Accept booking', description: 'Confirm this job' },
      { id: `reject_${booking.id}`, title: 'Decline booking', description: 'Not available' },
    ]
  );
  await sendBotReply(provider.phone, list);
}

async function notifyFarmerEscrowPrompt(farmerPhone, providerName, serviceType, serviceCost, bookingId) {
  const costStr = roundMoney(serviceCost).toLocaleString();
  const msg =
    `*${providerName}* accepted your *${serviceType}* booking.\n\n` +
    `Total to pay (incl. 10% DigiLync fee): *${costStr} FCFA*\n\n` +
    'Paying to escrow protects your money until work is 100% complete.\n\n' +
    'Reply *1* to pay to escrow.\n' +
    'Reply *0* to cancel.';
  await sendBrandedText(farmerPhone, msg);
  const phone = normalizePhone(farmerPhone);
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = 'farmer', step = 'match_escrow_decision',
     data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $2`,
    [
      JSON.stringify({
        booking_id: bookingId,
        service_type: serviceType,
        service_cost: serviceCost,
        provider_name: providerName,
      }),
      phone,
    ]
  );
}

async function providerAcceptBooking(bookingId, providerId) {
  const br = await pool.query(
    `SELECT b.*, f.id AS farmer_id, f.full_name AS farmer_name, f.phone AS farmer_phone,
            f.village, f.district, p.full_name AS provider_name, p.phone AS provider_phone
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     JOIN providers p ON b.provider_id = p.id
     WHERE b.id = $1 AND b.provider_id = $2 AND b.status = 'awaiting_provider_accept'`,
    [bookingId, providerId]
  );
  if (br.rows.length === 0) return { ok: false, error: 'not_found' };
  const booking = br.rows[0];

  await pool.query(
    `UPDATE bookings SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [bookingId]
  );

  const farmer = { id: booking.farmer_id, full_name: booking.farmer_name, phone: booking.farmer_phone };
  const provider = { id: providerId, full_name: booking.provider_name, phone: booking.provider_phone };

  await notifyFarmerEscrowPrompt(
    booking.farmer_phone,
    booking.provider_name,
    booking.service_type,
    booking.farmer_payable_amount_fcfa,
    bookingId
  );

  const acceptMsg =
    `✅ *Booking accepted*\n\n` +
    `Service: ${booking.service_type}\n` +
    `Date: ${booking.scheduled_date || 'TBD'} ${booking.scheduled_time || ''}\n` +
    `Farmer pays: ${roundMoney(booking.farmer_payable_amount_fcfa).toLocaleString()} FCFA\n\n` +
    'The farmer will pay to escrow next. Payment is released only after the farmer confirms 100% completion. ' +
    'Partial jobs are not eligible for payout.\n\n' +
    'Reply *MENU* for options.';
  await sendBrandedText(provider.phone, acceptMsg).catch((e) =>
    console.error('providerAccept notify:', e.message)
  );

  return { ok: true, booking, farmer, provider };
}

async function providerRejectBooking(bookingId, providerId) {
  const br = await pool.query(
    `SELECT b.*, f.phone AS farmer_phone
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     WHERE b.id = $1 AND b.provider_id = $2 AND b.status = 'awaiting_provider_accept'`,
    [bookingId, providerId]
  );
  if (br.rows.length === 0) return { ok: false, error: 'not_found' };
  const booking = br.rows[0];

  await pool.query(
    `UPDATE bookings SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [bookingId]
  );
  if (booking.availability_slot_id) await unlockAvailabilitySlot(booking.availability_slot_id);

  return { ok: true, booking };
}

async function cancelMatchedBooking(bookingId, farmerId) {
  const br = await pool.query(
    `SELECT id, availability_slot_id, status FROM bookings WHERE id = $1 AND farmer_id = $2`,
    [bookingId, farmerId]
  );
  if (br.rows.length === 0) return;
  const b = br.rows[0];
  if (!['matched', 'awaiting_provider_accept'].includes(b.status)) return;
  await pool.query(
    `UPDATE bookings SET status = 'cancelled', payment_status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [bookingId]
  );
  if (b.availability_slot_id) await unlockAvailabilitySlot(b.availability_slot_id);
}

async function simulateFarmerEscrowPayment(bookingId, farmerId, paymentMethod, paymentNumber) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const br = await client.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, f.village, f.district,
              p.full_name AS provider_name, p.phone AS provider_phone
       FROM bookings b
       JOIN farmers f ON b.farmer_id = f.id
       JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1 AND b.farmer_id = $2 FOR UPDATE`,
      [bookingId, farmerId]
    );
    if (br.rows.length === 0) throw new Error('Booking not found');
    const booking = br.rows[0];
    if (booking.status !== 'matched') throw new Error('Booking is not awaiting payment');

    await client.query(
      `UPDATE bookings SET status = 'confirmed', payment_status = 'held', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [bookingId]
    );
    await client.query(
      `INSERT INTO booking_payments (
         booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa,
         payment_status, payout_method, payout_reference, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, 'held', $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (booking_id) DO UPDATE SET
         escrow_amount_fcfa = EXCLUDED.escrow_amount_fcfa,
         provider_amount_fcfa = EXCLUDED.provider_amount_fcfa,
         platform_fee_amount_fcfa = EXCLUDED.platform_fee_amount_fcfa,
         payment_status = 'held',
         payout_method = EXCLUDED.payout_method,
         payout_reference = EXCLUDED.payout_reference,
         updated_at = CURRENT_TIMESTAMP`,
      [
        bookingId,
        booking.farmer_payable_amount_fcfa,
        booking.provider_base_amount_fcfa,
        booking.platform_fee_amount_fcfa,
        paymentMethod,
        paymentNumber,
      ]
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
    await notificationService.sendBookingConfirmationToFarmer(bookingId, farmer, provider, booking);
    await notificationService.sendBookingConfirmationToProvider(bookingId, farmer, provider, booking);

    return booking;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function saveProviderPayoutMethod(bookingId, providerId, method) {
  await pool.query(
    `INSERT INTO booking_payments (booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status, payout_method, created_at, updated_at)
     VALUES ($1, 0, 0, 0, 'held', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (booking_id) DO UPDATE SET payout_method = EXCLUDED.payout_method, updated_at = CURRENT_TIMESTAMP`,
    [bookingId, method]
  );
}

async function confirmWorkAndReleasePayment(bookingId, farmerId = null) {
  const br = await pool.query(
    `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone,
            p.full_name AS provider_name, p.phone AS provider_phone
     FROM bookings b
     LEFT JOIN farmers f ON b.farmer_id = f.id
     LEFT JOIN providers p ON b.provider_id = p.id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (br.rows.length === 0) throw new Error('Booking not found');
  const booking = br.rows[0];
  if (farmerId != null && booking.farmer_id !== farmerId) throw new Error('Booking does not belong to farmer');
  const confirmable = ['confirmed', 'awaiting_farmer_confirmation'];
  if (!confirmable.includes(booking.status)) {
    throw new Error(`Booking status '${booking.status}' cannot be confirmed`);
  }
  if (booking.payment_status !== 'held') {
    throw new Error('Escrow payment is required before confirming work');
  }

  await pool.query(
    `UPDATE bookings SET status = 'completed', completion_verified_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [bookingId]
  );

  const paymentResult = await paymentProcessor.processPaymentRelease(bookingId, farmerId, farmerId == null);

  const farmer = {
    id: booking.farmer_id,
    full_name: booking.farmer_name,
    phone: booking.farmer_phone,
  };
  const provider = {
    id: booking.provider_id,
    full_name: booking.provider_name,
    phone: booking.provider_phone,
  };
  const updatedBooking = {
    ...booking,
    payment_status: 'released',
    provider_base_amount_fcfa: paymentResult.providerAmount || booking.provider_base_amount_fcfa,
    payout_method: paymentResult.payoutMethod || 'Mobile Money',
  };
  await notificationService
    .sendPaymentReleasedNotification(bookingId, farmer, provider, updatedBooking)
    .catch((e) => console.error('confirmWork payment notifications:', e.message));

  return { booking: updatedBooking, paymentResult };
}

async function getFarmerConfirmableBookings(farmerId) {
  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, b.farmer_payable_amount_fcfa, b.status,
            p.full_name AS provider_name
     FROM bookings b
     LEFT JOIN providers p ON b.provider_id = p.id
     WHERE b.farmer_id = $1
       AND b.status = 'awaiting_farmer_confirmation'
       AND b.payment_status = 'held'
       AND b.completion_verified_at IS NULL
       AND b.provider_id IS NOT NULL
     ORDER BY b.created_at DESC
     LIMIT 10`,
    [farmerId]
  );
  return r.rows;
}

async function adminAssignProviderMatch(bookingId, providerId) {
  const pRes = await pool.query('SELECT * FROM providers WHERE id = $1', [providerId]);
  if (pRes.rows.length === 0) throw new Error('Provider not found');
  const provider = pRes.rows[0];

  const bRes = await pool.query(
    `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone
     FROM bookings b
     LEFT JOIN farmers f ON b.farmer_id = f.id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (bRes.rows.length === 0) throw new Error('Booking not found');
  const booking = bRes.rows[0];

  const { economics, providerServiceId } = await resolveServiceRate(
    providerId,
    booking.service_type,
    booking.farm_size_ha
  );

  const upd = await pool.query(
    `UPDATE bookings SET provider_id = $1, status = 'awaiting_provider_accept', payment_status = 'unfunded',
       provider_base_amount_fcfa = $2, platform_fee_amount_fcfa = $3, farmer_payable_amount_fcfa = $4,
       provider_service_id = $5, requested_qty = $6, estimated_duration_days = $7, estimated_duration_hours = $8,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $9 RETURNING *`,
    [
      providerId,
      economics.providerBaseAmount,
      economics.platformFeeAmount,
      economics.farmerPayableAmount,
      providerServiceId,
      booking.farm_size_ha,
      economics.estimatedDurationDays,
      economics.estimatedDurationHours,
      bookingId,
    ]
  );
  const updated = upd.rows[0];
  const farmer = { full_name: booking.farmer_name, phone: booking.farmer_phone };
  await notifyProviderBookingRequest(updated, farmer, provider);
  return updated;
}

module.exports = {
  resolveServiceRate,
  createAwaitingProviderBooking,
  notifyProviderBookingRequest,
  notifyFarmerEscrowPrompt,
  providerAcceptBooking,
  providerRejectBooking,
  lockAvailabilitySlot,
  unlockAvailabilitySlot,
  adminAssignProviderMatch,
  cancelMatchedBooking,
  simulateFarmerEscrowPayment,
  saveProviderPayoutMethod,
  confirmWorkAndReleasePayment,
  getFarmerConfirmableBookings,
  normalizePayoutMethod,
  normalizeFarmerPaymentMethod,
};
