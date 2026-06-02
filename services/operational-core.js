const { pool } = require('../config/db');

const PLATFORM_COMMISSION_RATE = 0.1;
const FOUR_MONTHS_IN_DAYS = 122;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDateTime(dateValue, timeValue) {
  if (!dateValue) return null;
  const datePart = String(dateValue).slice(0, 10);
  const timePart = timeValue ? String(timeValue).slice(0, 8) : '00:00:00';
  const iso = `${datePart}T${timePart}`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function validateSchedulingWindow(scheduledDate) {
  if (!scheduledDate) return { ok: true };
  const now = new Date();
  const maxDate = addDays(now, FOUR_MONTHS_IN_DAYS);
  const d = new Date(String(scheduledDate).slice(0, 10));
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: 'Invalid scheduled date' };
  }
  if (d > maxDate) {
    return { ok: false, error: 'Bookings cannot be scheduled beyond 4 months' };
  }
  return { ok: true };
}

function calculateBookingEconomics({ providerBasePricePerHa, farmSizeHa }) {
  const basePricePerHa = Number(providerBasePricePerHa) || 0;
  const size = Number(farmSizeHa) || 0;
  const providerBaseAmount = roundMoney(basePricePerHa * size);
  const platformFeeAmount = roundMoney(providerBaseAmount * PLATFORM_COMMISSION_RATE);
  const farmerPayableAmount = roundMoney(providerBaseAmount + platformFeeAmount);
  return {
    providerBaseAmount,
    platformFeeAmount,
    farmerPayableAmount,
  };
}

function calculateCancellationFee({ farmerPayableAmount, scheduledDate, scheduledTime, cancelledAt = new Date() }) {
  const serviceAt = parseDateTime(scheduledDate, scheduledTime);
  if (!serviceAt) return { feeRate: 0, feeAmount: 0 };
  const diffMs = serviceAt.getTime() - cancelledAt.getTime();
  const hours = diffMs / (1000 * 60 * 60);
  let feeRate = 0;
  if (hours < 6) feeRate = 0.3;
  else if (hours < 24) feeRate = 0.1;
  const feeAmount = roundMoney((Number(farmerPayableAmount) || 0) * feeRate);
  return { feeRate, feeAmount };
}

async function ensureOperationalSchema() {
  await pool.query(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS budget_min_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS budget_max_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS provider_base_amount_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS platform_fee_amount_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS farmer_payable_amount_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS cancellation_fee_rate DECIMAL(5, 4),
      ADD COLUMN IF NOT EXISTS cancellation_fee_amount_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) DEFAULT 'unfunded',
      ADD COLUMN IF NOT EXISTS payout_due_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_availability_slots (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      available_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      is_booked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_id, available_date, start_time, end_time)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_job_events (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      actor_type VARCHAR(20) NOT NULL,
      actor_id INTEGER,
      event_type VARCHAR(32) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_payments (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      escrow_amount_fcfa DECIMAL(12, 2) NOT NULL,
      provider_amount_fcfa DECIMAL(12, 2) NOT NULL,
      platform_fee_amount_fcfa DECIMAL(12, 2) NOT NULL,
      payment_status VARCHAR(32) NOT NULL DEFAULT 'held',
      payout_method VARCHAR(32),
      payout_reference VARCHAR(255),
      payout_processed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(booking_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_disputes (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      raised_by VARCHAR(20) NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_reminder_logs (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      interval_label VARCHAR(32) NOT NULL,
      recipient_type VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(booking_id, interval_label, recipient_type)
    )
  `);
}

module.exports = {
  PLATFORM_COMMISSION_RATE,
  calculateBookingEconomics,
  calculateCancellationFee,
  validateSchedulingWindow,
  ensureOperationalSchema,
};
