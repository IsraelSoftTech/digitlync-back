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

/** Legacy ha-based pricing (fallback when no service rate card). */
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
    estimatedDurationDays: null,
    estimatedDurationHours: null,
  };
}

/**
 * Proportional pricing from a provider service rate card (operational spec §3).
 */
function calculateServiceEconomics({
  minServiceQty,
  basePriceFcfa,
  requestedQty,
  baseDurationDays = null,
  baseDurationHours = null,
}) {
  const minQty = Number(minServiceQty) || 1;
  const qty = Number(requestedQty) || 0;
  const basePrice = Number(basePriceFcfa) || 0;
  const scaleFactor = minQty > 0 ? qty / minQty : 0;
  const providerBaseAmount = roundMoney(basePrice * scaleFactor);
  const platformFeeAmount = roundMoney(providerBaseAmount * PLATFORM_COMMISSION_RATE);
  const farmerPayableAmount = roundMoney(providerBaseAmount + platformFeeAmount);
  const days = baseDurationDays != null ? roundMoney(Number(baseDurationDays) * scaleFactor) : null;
  const hours = baseDurationHours != null ? roundMoney(Number(baseDurationHours) * scaleFactor) : null;
  return {
    providerBaseAmount,
    platformFeeAmount,
    farmerPayableAmount,
    estimatedDurationDays: days,
    estimatedDurationHours: hours,
    scaleFactor,
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
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completion_verified_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS payment_released_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE providers
      ADD COLUMN IF NOT EXISTS min_service_qty DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS service_unit VARCHAR(64),
      ADD COLUMN IF NOT EXISTS service_unit_label VARCHAR(255)
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_services (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service_name VARCHAR(200) NOT NULL,
      work_capacity_ha_per_hour DECIMAL(10, 2),
      base_price_per_ha DECIMAL(12, 2),
      country VARCHAR(100),
      region VARCHAR(200),
      division VARCHAR(200),
      subdivision VARCHAR(200),
      district VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE provider_services
      ADD COLUMN IF NOT EXISTS min_service_qty DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS service_unit VARCHAR(64),
      ADD COLUMN IF NOT EXISTS service_unit_label VARCHAR(255),
      ADD COLUMN IF NOT EXISTS base_price_fcfa DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS base_duration_days DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS base_duration_hours DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS work_capacity_notes TEXT
  `);

  await pool.query(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS availability_slot_id INTEGER REFERENCES provider_availability_slots(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS requested_qty DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS provider_service_id INTEGER REFERENCES provider_services(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS estimated_duration_days DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS estimated_duration_hours DECIMAL(10, 2)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_confirmation_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(255) NOT NULL UNIQUE,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      farmer_id INTEGER REFERENCES farmers(id) ON DELETE SET NULL,
      provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
      recipient_phone VARCHAR(32),
      message_type VARCHAR(64),
      message_body TEXT,
      status VARCHAR(32) DEFAULT 'sent',
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = {
  PLATFORM_COMMISSION_RATE,
  calculateBookingEconomics,
  calculateServiceEconomics,
  calculateCancellationFee,
  validateSchedulingWindow,
  ensureOperationalSchema,
};
