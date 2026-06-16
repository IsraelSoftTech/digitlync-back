/**
 * Centralized notification service for WhatsApp messages
 * Handles booking confirmations, cancellations, job updates, payment, ratings, reminders
 */

const { pool } = require('../config/db');
const { sendBrandedText } = require('./whatsapp-sender');

/**
 * Log notification to database
 */
async function logNotification(bookingId, farmerId, providerId, recipientPhone, messageType, messageBody) {
  try {
    await pool.query(
      `INSERT INTO notifications_log (booking_id, farmer_id, provider_id, recipient_phone, message_type, message_body, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', CURRENT_TIMESTAMP)`,
      [bookingId, farmerId, providerId, recipientPhone, messageType, messageBody]
    );
  } catch (err) {
    console.error('[Notifications] Failed to log notification:', err.message);
  }
}

/**
 * Send booking confirmation to farmer
 * Shows booking details + cancellation policy
 */
async function sendBookingConfirmationToFarmer(bookingId, farmer, provider, booking) {
  const message = `Booking Confirmed! ✅

Service: ${booking.service_type || 'Agricultural Service'}
Provider: ${provider.full_name}
Date: ${booking.scheduled_date}
Time: ${booking.scheduled_time}
Farm Size: ${booking.farm_size_ha} ha
Price: ${booking.farmer_payable_amount_fcfa} FCFA

💰 Cancellation Policy:
• Free if cancelled >24 hours before
• 10% fee if cancelled 6-24 hours before
• 30% fee if cancelled <6 hours before

Your payment has been secured by Digilync. Provider will confirm job start.`;

  try {
    await sendBrandedText(farmer.phone, message);
    await logNotification(bookingId, farmer.id, provider.id, farmer.phone, 'booking_confirmation', message);
    console.log(`[Notifications] Booking confirmation sent to farmer ${farmer.phone}`);
  } catch (err) {
    console.error(`[Notifications] Failed to send booking confirmation to farmer:`, err.message);
  }
}

/**
 * Send booking confirmation to provider
 * Shows service terms + payment expectations + full completion requirement
 */
async function sendBookingConfirmationToProvider(bookingId, farmer, provider, booking) {
  const message = `New Booking Request! 🚜

Service: ${booking.service_type || 'Agricultural Service'}
Farmer: ${farmer.full_name}
Farm Location: ${farmer.village}, ${farmer.district}
Scheduled: ${booking.scheduled_date} at ${booking.scheduled_time}
Farm Size: ${booking.farm_size_ha} ha

💰 Payment Terms:
Amount: ${booking.farmer_payable_amount_fcfa} FCFA (your portion: ${booking.provider_base_amount_fcfa} FCFA)
Status: Payment HELD in Digilync escrow

⚠️ IMPORTANT: Full Completion Policy
• Service must be 100% complete to release payment
• Partial jobs do not qualify for payment
• Incomplete work may result in dispute
• Reliability affects your future recommendations

✅ To accept, reply with "ACCEPT"
❌ To decline, reply with "DECLINE"`;

  try {
    await sendBrandedText(provider.phone, message);
    await logNotification(bookingId, farmer.id, provider.id, provider.phone, 'booking_confirmation_provider', message);
    console.log(`[Notifications] Booking confirmation sent to provider ${provider.phone}`);
  } catch (err) {
    console.error(`[Notifications] Failed to send booking confirmation to provider:`, err.message);
  }
}

/**
 * Send job started notification to farmer
 */
async function sendJobStartedNotification(bookingId, farmer, provider, booking) {
  const message = `🚜 Job Started!

Provider ${provider.full_name} has started work on your farm.
Service: ${booking.service_type || 'Agricultural Service'}
Location: ${booking.farm_location || farmer.village}

We'll notify you when the job is complete.`;

  try {
    await sendBrandedText(farmer.phone, message);
    await logNotification(bookingId, farmer.id, provider.id, farmer.phone, 'job_started', message);
  } catch (err) {
    console.error(`[Notifications] Failed to send job started notification:`, err.message);
  }
}

/**
 * Send job completed notification + completion verification request to farmer
 */
async function sendJobCompletedNotification(bookingId, farmer, provider, booking) {
  const message = `✅ Job Completed!

Provider ${provider.full_name} indicates the service is complete.
Service: ${booking.service_type || 'Agricultural Service'}

Please confirm:
1️⃣ - Yes, job is complete. Release payment.
2️⃣ - No, job is incomplete. Open dispute.

Reply with 1 or 2.`;

  try {
    await sendBrandedText(farmer.phone, message);
    await logNotification(bookingId, farmer.id, provider.id, farmer.phone, 'job_completed', message);
  } catch (err) {
    console.error(`[Notifications] Failed to send job completed notification:`, err.message);
  }
}

/**
 * Send payment released notification to both parties
 */
async function sendPaymentReleasedNotification(bookingId, farmer, provider, booking) {
  // Notify farmer
  const farmerMsg = `💰 Payment Completed!

Your payment has been successfully processed.
Provider: ${provider.full_name}
Amount: ${booking.farmer_payable_amount_fcfa} FCFA

Please rate this provider:
⭐ How would you rate this service?
(Reply with 1-5 stars)`;

  try {
    await sendBrandedText(farmer.phone, farmerMsg);
    await logNotification(bookingId, farmer.id, provider.id, farmer.phone, 'payment_released', farmerMsg);
  } catch (err) {
    console.error(`[Notifications] Failed to send payment notification to farmer:`, err.message);
  }

  // Notify provider
  const providerMsg = `💰 Payment Released!

Your job has been verified and payment is being processed.
Service: ${booking.service_type}
Amount: ${booking.provider_base_amount_fcfa} FCFA
Payout Method: ${booking.payout_method || 'Mobile Money'}

Payout will be completed within 48 hours. Thank you!`;

  try {
    await sendBrandedText(provider.phone, providerMsg);
    await logNotification(bookingId, farmer.id, provider.id, provider.phone, 'payment_released_provider', providerMsg);
  } catch (err) {
    console.error(`[Notifications] Failed to send payment notification to provider:`, err.message);
  }
}

/**
 * Send booking reminder to farmer
 */
async function sendBookingReminderToFarmer(booking, farmer, provider, intervalLabel) {
  const daysLeft = Math.ceil((new Date(booking.scheduled_date) - new Date()) / (1000 * 60 * 60 * 24));
  const message = `🔔 Booking Reminder

Your service is scheduled in ${daysLeft} days.
Provider: ${provider.full_name}
Date: ${booking.scheduled_date} at ${booking.scheduled_time}
Service: ${booking.service_type || 'Agricultural Service'}

Make sure you'll be available. 👨‍🌾`;

  try {
    await sendBrandedText(farmer.phone, message);
    await logNotification(booking.id, farmer.id, provider.id, farmer.phone, `reminder_${intervalLabel}`, message);
  } catch (err) {
    console.error(`[Notifications] Failed to send reminder to farmer:`, err.message);
  }
}

/**
 * Send booking reminder to provider
 */
async function sendBookingReminderToProvider(booking, farmer, provider, intervalLabel) {
  const daysLeft = Math.ceil((new Date(booking.scheduled_date) - new Date()) / (1000 * 60 * 60 * 24));
  const message = `🔔 Job Reminder

Your scheduled job is in ${daysLeft} days.
Farmer: ${farmer.full_name}
Date: ${booking.scheduled_date} at ${booking.scheduled_time}
Farm Size: ${booking.farm_size_ha} ha
Amount: ${booking.provider_base_amount_fcfa} FCFA

Be on time! ⏰`;

  try {
    await sendBrandedText(provider.phone, message);
    await logNotification(booking.id, farmer.id, provider.id, provider.phone, `reminder_${intervalLabel}`, message);
  } catch (err) {
    console.error(`[Notifications] Failed to send reminder to provider:`, err.message);
  }
}

/**
 * Send dispute notification to admin
 */
async function sendDisputeNotificationToAdmin(booking, farmer, reason) {
  const message = `⚠️ DISPUTE ALERT

Farmer ${farmer.full_name} has raised a dispute on Booking #${booking.id}.
Reason: ${reason}

Action Required: Review and resolve dispute.

Check admin dashboard for details.`;

  try {
    console.log(`[Notifications] Dispute notification queued for admin: ${message}`);
    // In production, send to admin WhatsApp or email
  // Prefer payout info saved in booking_payments if present
  let payoutMethod = booking.payout_method || 'Mobile Money';
  let payoutRef = '';
  try {
    const bp = await pool.query('SELECT payout_method, payout_reference FROM booking_payments WHERE booking_id = $1', [bookingId]);
    if (bp.rows.length > 0) {
      payoutMethod = bp.rows[0].payout_method || payoutMethod;
      payoutRef = bp.rows[0].payout_reference || '';
    }
  } catch (e) {
    // ignore
  }

  const providerMsg = `💰 Payment Released!
  } catch (err) {
    console.error(`[Notifications] Failed to send dispute notification:`, err.message);
  }
}

module.exports = {
  logNotification,
  sendBookingConfirmationToFarmer,
  sendBookingConfirmationToProvider,
  sendJobStartedNotification,
  sendJobCompletedNotification,
  sendPaymentReleasedNotification,
  sendBookingReminderToFarmer,
  sendBookingReminderToProvider,
  sendDisputeNotificationToAdmin,
};
