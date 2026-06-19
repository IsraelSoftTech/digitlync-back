/**
 * Auto-matching, escrow payment simulation, and work confirmation flows.
 */
const { pool } = require('../config/db');
const { sendBrandedText } = require('./whatsapp-sender');
const { calculateBookingEconomics } = require('./operational-core');
const paymentProcessor = require('./payment-processor');

function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

async function updateProviderSession(waPhone, bookingId) {
  const phone = normalizePhone(waPhone);
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = 'provider', step = 'provider_match_payout_method',
     data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $2`,
    [JSON.stringify({ booking_id: bookingId }), phone]
  );
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

function pickBestProvider(providers, farmSizeHa, budgetMin, budgetMax) {
  if (!providers || !providers.length) return null;
  const scored = providers
    .map((p) => {
      const economics = calculateBookingEconomics({
        providerBasePricePerHa: p.base_price_per_ha,
        farmSizeHa,
      });
      const cost = economics.farmerPayableAmount;
      const hasSlots = Array.isArray(p.availability_slots) && p.availability_slots.length > 0;
      if (budgetMax != null && !Number.isNaN(budgetMax) && cost > budgetMax) return null;
      if (budgetMin != null && !Number.isNaN(budgetMin) && cost < budgetMin) return null;
      return {
        provider: p,
        economics,
        cost,
        hasSlots,
        distance: p.distance_km != null ? p.distance_km : 9999,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.hasSlots !== b.hasSlots) return a.hasSlots ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.cost - b.cost;
    });
  return scored[0] || null;
}

async function createAutoMatchedBooking(farmerId, provider, requestData) {
  const economics = calculateBookingEconomics({
    providerBasePricePerHa: provider.base_price_per_ha,
    farmSizeHa: requestData.farm_size_ha,
  });
  const ins = await pool.query(
    `INSERT INTO bookings (
       farmer_id, provider_id, service_type, status, scheduled_date, scheduled_time, farm_size_ha,
       budget_min_fcfa, budget_max_fcfa, provider_base_amount_fcfa, platform_fee_amount_fcfa,
       farmer_payable_amount_fcfa, payment_status
     )
     VALUES ($1, $2, $3, 'matched', $4, $5, $6, $7, $8, $9, $10, $11, 'unfunded')
     RETURNING *`,
    [
      farmerId,
      provider.id,
      requestData.service_type,
      requestData.scheduled_date || null,
      requestData.scheduled_time || null,
      requestData.farm_size_ha,
      requestData.budget_min_fcfa || null,
      requestData.budget_max_fcfa || null,
      economics.providerBaseAmount,
      economics.platformFeeAmount,
      economics.farmerPayableAmount,
    ]
  );
  return ins.rows[0];
}

async function notifyFarmerMatchOffer(farmerPhone, providerName, serviceType, serviceCost) {
  const costStr = roundMoney(serviceCost).toLocaleString();
  const msg =
    `You have been matched with *${providerName}* for *${serviceType}* that costs *${costStr} FCFA*.\n\n` +
    'Paying to escrow means your money is protected. If the provider does not complete the work, your payment will be returned.\n\n' +
    'Reply *1* to pay to escrow.\n' +
    'Reply *0* to go back to the main menu.';
  await sendBrandedText(farmerPhone, msg);
}

async function notifyProviderMatched(providerPhone, farmerName, serviceType, servicePrice, bookingId) {
  const priceStr = roundMoney(servicePrice).toLocaleString();
  const msg =
    `You have been matched with *${farmerName}* for *${serviceType}* which costs *${priceStr} FCFA*.\n\n` +
    'You will be paid only when the farmer confirms the job is complete.\n\n' +
    'Reply *1* for MoMo.\n' +
    'Reply *0* for Orange Money.';
  await sendBrandedText(providerPhone, msg);
  try {
    await updateProviderSession(providerPhone, bookingId);
  } catch (err) {
    console.error('notifyProviderMatched session update:', err.message);
  }
}

async function initiateAutoMatch(waFrom, farmer, provider, requestData) {
  const booking = await createAutoMatchedBooking(farmer.id, provider, requestData);
  const serviceCost = booking.farmer_payable_amount_fcfa;
  await notifyFarmerMatchOffer(waFrom, provider.full_name, requestData.service_type, serviceCost);
  await notifyProviderMatched(
    provider.phone,
    farmer.name || 'Farmer',
    requestData.service_type,
    serviceCost,
    booking.id
  );
  const phone = normalizePhone(waFrom);
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = 'farmer', step = 'match_escrow_decision',
     data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $2`,
    [
      JSON.stringify({
        booking_id: booking.id,
        provider_id: provider.id,
        service_type: requestData.service_type,
        service_cost: serviceCost,
        provider_name: provider.full_name,
      }),
      phone,
    ]
  );
  return booking;
}

async function cancelMatchedBooking(bookingId, farmerId) {
  await pool.query(
    `UPDATE bookings SET status = 'cancelled', payment_status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND farmer_id = $2 AND status = 'matched'`,
    [bookingId, farmerId]
  );
}

async function simulateFarmerEscrowPayment(bookingId, farmerId, paymentMethod, paymentNumber) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const br = await client.query(
      `SELECT * FROM bookings WHERE id = $1 AND farmer_id = $2 FOR UPDATE`,
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
  await pool.query(
    `UPDATE bookings SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND provider_id = $2`,
    [bookingId, providerId]
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
  if (!['confirmed', 'matched'].includes(booking.status)) {
    throw new Error(`Booking status '${booking.status}' cannot be confirmed`);
  }
  if (booking.payment_status !== 'held') {
    throw new Error('Escrow payment is required before confirming work');
  }

  await pool.query(
    `UPDATE bookings SET completion_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [bookingId]
  );

  const paymentResult = await paymentProcessor.processPaymentRelease(bookingId, farmerId, farmerId == null);

  const providerAmount = paymentResult.providerAmount || booking.provider_base_amount_fcfa;
  const amountStr = roundMoney(providerAmount).toLocaleString();
  const providerMsg =
    `You have been paid by Digilync for offering *${booking.service_type}* to *${booking.farmer_name}* ` +
    `a sum of *${amountStr} FCFA*. Thank you for using Digilync.`;

  if (booking.provider_phone) {
    await sendBrandedText(booking.provider_phone, providerMsg).catch((e) => {
      console.error('confirmWork provider notify failed:', e.message);
    });
  }

  if (booking.farmer_phone) {
    await sendBrandedText(
      booking.farmer_phone,
      `Thank you for confirming. Payment has been released to *${booking.provider_name}* for *${booking.service_type}*.`
    ).catch((e) => console.error('confirmWork farmer notify failed:', e.message));
  }

  return { booking, paymentResult };
}

async function getFarmerConfirmableBookings(farmerId) {
  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, b.farmer_payable_amount_fcfa, b.status,
            p.full_name AS provider_name
     FROM bookings b
     LEFT JOIN providers p ON b.provider_id = p.id
     WHERE b.farmer_id = $1
       AND b.status = 'confirmed'
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

  const economics = calculateBookingEconomics({
    providerBasePricePerHa: provider.base_price_per_ha,
    farmSizeHa: booking.farm_size_ha,
  });

  const upd = await pool.query(
    `UPDATE bookings SET provider_id = $1, status = 'matched', payment_status = 'unfunded',
       provider_base_amount_fcfa = $2, platform_fee_amount_fcfa = $3, farmer_payable_amount_fcfa = $4,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 RETURNING *`,
    [providerId, economics.providerBaseAmount, economics.platformFeeAmount, economics.farmerPayableAmount, bookingId]
  );
  const updated = upd.rows[0];

  await notifyFarmerMatchOffer(
    booking.farmer_phone,
    provider.full_name,
    updated.service_type,
    updated.farmer_payable_amount_fcfa
  );
  await notifyProviderMatched(
    provider.phone,
    booking.farmer_name || 'Farmer',
    updated.service_type,
    updated.farmer_payable_amount_fcfa,
    bookingId
  );

  const phone = normalizePhone(booking.farmer_phone);
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = 'farmer', step = 'match_escrow_decision',
     data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $2`,
    [
      JSON.stringify({
        booking_id: bookingId,
        provider_id: providerId,
        service_type: updated.service_type,
        service_cost: updated.farmer_payable_amount_fcfa,
        provider_name: provider.full_name,
      }),
      phone,
    ]
  );

  return updated;
}

module.exports = {
  pickBestProvider,
  createAutoMatchedBooking,
  initiateAutoMatch,
  adminAssignProviderMatch,
  cancelMatchedBooking,
  simulateFarmerEscrowPayment,
  saveProviderPayoutMethod,
  confirmWorkAndReleasePayment,
  getFarmerConfirmableBookings,
  normalizePayoutMethod,
  normalizeFarmerPaymentMethod,
  notifyFarmerMatchOffer,
  notifyProviderMatched,
};
