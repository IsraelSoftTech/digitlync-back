/**
 * Payment processor service
 * Handles escrow release, payout calculation, and payout processing
 */

const { pool } = require('../config/db');

/**
 * Calculate provider payout after farmer confirms completion
 * Deducts 10% platform commission and returns provider amount
 */
function calculateProviderPayout(farmerPayableAmount) {
  const farmPayable = Number(farmerPayableAmount) || 0;
  // Since farmerPayableAmount = providerBase + (providerBase * 0.1)
  // We need to extract: providerAmount = farmPayable / 1.1
  const providerAmount = Math.round((farmPayable / 1.1) * 100) / 100;
  const platformFee = Math.round((farmPayable - providerAmount) * 100) / 100;
  return {
    providerAmount,
    platformFee,
  };
}

/**
 * Process payment release after farmer confirms completion
 * 1. Update booking status to completed
 * 2. Release escrow (set payment_status = released)
 * 3. Calculate payout
 * 4. Queue payout to provider
 * 5. Return payout details
 */
async function processPaymentRelease(bookingId, farmerId, verifiedByAdmin = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get booking details
    const bookingRes = await client.query(
      `SELECT b.*, p.id as provider_id, p.phone, p.payout_method, 
              f.id as farmer_id, f.phone as farmer_phone
       FROM bookings b
       LEFT JOIN providers p ON b.provider_id = p.id
       LEFT JOIN farmers f ON b.farmer_id = f.id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const booking = bookingRes.rows[0];

    // Check if already released
    if (booking.payment_status === 'released') {
      throw new Error('Payment already released for this booking');
    }

    // Check if in dispute
    const disputeRes = await client.query(
      `SELECT id FROM booking_disputes WHERE booking_id = $1 AND status = 'open'`,
      [bookingId]
    );
    if (disputeRes.rows.length > 0) {
      throw new Error('Cannot release payment while dispute is open');
    }

    // Update booking: mark completion verified and set payment_released_at
    await client.query(
      `UPDATE bookings 
       SET status = 'completed', 
           completion_verified_at = CURRENT_TIMESTAMP,
           payment_released_at = CURRENT_TIMESTAMP,
           payment_status = 'released'
       WHERE id = $1`,
      [bookingId]
    );

    // Calculate payout
    const { providerAmount, platformFee } = calculateProviderPayout(booking.farmer_payable_amount_fcfa);

    // Update or create payment record
    await client.query(
      `INSERT INTO booking_payments (
         booking_id, 
         escrow_amount_fcfa, 
         provider_amount_fcfa, 
         platform_fee_amount_fcfa, 
         payment_status, 
         payout_method,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, 'released', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (booking_id) 
       DO UPDATE SET 
         payment_status = 'released',
         provider_amount_fcfa = $3,
         platform_fee_amount_fcfa = $4,
         payout_method = $5,
         updated_at = CURRENT_TIMESTAMP`,
      [
        bookingId,
        booking.farmer_payable_amount_fcfa,
        providerAmount,
        platformFee,
        booking.payout_method || 'mobile_money',
      ]
    );

    // Log audit: payment released
    try {
      const auditMsg = `Payment released for booking #${bookingId}: ${providerAmount} FCFA to provider ${booking.provider_id}`;
      await client.query(
        `INSERT INTO audit_logs (admin_id, admin_username, action_type, action, created_at)
         VALUES ($1, $2, 'payment', $3, CURRENT_TIMESTAMP)`,
        [1, 'system', auditMsg]
      );
    } catch (_) {
      // Audit table may not exist
    }

    await client.query('COMMIT');

    return {
      success: true,
      bookingId,
      providerAmount,
      platformFee,
      payoutMethod: booking.payout_method || 'mobile_money',
      providerId: booking.provider_id,
      providerPhone: booking.phone,
      message: `Payment released: ${providerAmount} FCFA to provider`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PaymentProcessor] Error releasing payment:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hold payment (transition to dispute)
 * Used when dispute is raised
 */
async function holdPaymentForDispute(bookingId, reason) {
  try {
    await pool.query(
      `UPDATE bookings SET payment_status = 'held' WHERE id = $1`,
      [bookingId]
    );

    await pool.query(
      `UPDATE booking_payments SET payment_status = 'held' WHERE booking_id = $1`,
      [bookingId]
    );

    console.log(`[PaymentProcessor] Payment held for dispute on booking #${bookingId}: ${reason}`);

    return { success: true, bookingId, status: 'held', reason };
  } catch (err) {
    console.error('[PaymentProcessor] Error holding payment:', err.message);
    throw err;
  }
}

/**
 * Refund farmer (cancel booking with full refund)
 */
async function refundFarmer(bookingId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      `SELECT farmer_payable_amount_fcfa, farmer_id FROM bookings WHERE id = $1`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const refundAmount = bookingRes.rows[0].farmer_payable_amount_fcfa;

    // Mark booking cancelled
    await client.query(
      `UPDATE bookings 
       SET status = 'cancelled', 
           payment_status = 'refunded'
       WHERE id = $1`,
      [bookingId]
    );

    // Update payment record
    await client.query(
      `UPDATE booking_payments 
       SET payment_status = 'refunded'
       WHERE booking_id = $1`,
      [bookingId]
    );

    await client.query('COMMIT');

    console.log(`[PaymentProcessor] Refund processed for booking #${bookingId}: ${refundAmount} FCFA`);

    return {
      success: true,
      bookingId,
      refundAmount,
      reason,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PaymentProcessor] Error processing refund:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release payment after dispute resolved (admin approves payout)
 */
async function releasePaymentAfterDispute(bookingId) {
  try {
    const bookingRes = await pool.query(
      `SELECT farmer_payable_amount_fcfa FROM bookings WHERE id = $1`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const { providerAmount, platformFee } = calculateProviderPayout(
      bookingRes.rows[0].farmer_payable_amount_fcfa
    );

    await pool.query(
      `UPDATE booking_payments 
       SET payment_status = 'released', 
           provider_amount_fcfa = $2,
           platform_fee_amount_fcfa = $3
       WHERE booking_id = $1`,
      [bookingId, providerAmount, platformFee]
    );

    await pool.query(
      `UPDATE bookings 
       SET payment_status = 'released',
           payment_released_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [bookingId]
    );

    console.log(`[PaymentProcessor] Payment released after dispute resolution on booking #${bookingId}`);

    return { success: true, bookingId, providerAmount, platformFee };
  } catch (err) {
    console.error('[PaymentProcessor] Error releasing payment after dispute:', err.message);
    throw err;
  }
}

/**
 * Get payment status for a booking
 */
async function getPaymentStatus(bookingId) {
  try {
    const res = await pool.query(
      `SELECT bp.*, b.status, b.farmer_payable_amount_fcfa
       FROM booking_payments bp
       LEFT JOIN bookings b ON bp.booking_id = b.id
       WHERE bp.booking_id = $1`,
      [bookingId]
    );

    return res.rows[0] || null;
  } catch (err) {
    console.error('[PaymentProcessor] Error getting payment status:', err.message);
    throw err;
  }
}

module.exports = {
  calculateProviderPayout,
  processPaymentRelease,
  holdPaymentForDispute,
  refundFarmer,
  releasePaymentAfterDispute,
  getPaymentStatus,
};
