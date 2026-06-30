const { pool } = require('../config/db');

const DEFAULT_SETTINGS = {
  bookingLeadTime: 3,
  reminderTiming: 24,
  maxServiceRadius: 50,
  minRating: 3.0,
  maintenanceSignalEnabled: false,
};

function rowToSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    bookingLeadTime: row.booking_lead_time_days,
    reminderTiming: row.reminder_timing_hours,
    maxServiceRadius: row.max_service_radius_km,
    minRating: parseFloat(row.min_rating),
    maintenanceSignalEnabled: Boolean(row.maintenance_signal_enabled),
  };
}

async function ensurePlatformSettingsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      booking_lead_time_days INTEGER NOT NULL DEFAULT 3,
      reminder_timing_hours INTEGER NOT NULL DEFAULT 24,
      max_service_radius_km INTEGER NOT NULL DEFAULT 50,
      min_rating DECIMAL(3, 1) NOT NULL DEFAULT 3.0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by_admin_id INTEGER
    )
  `);
  await pool.query(`
    INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS maintenance_signal_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

async function getPlatformSettings() {
  const result = await pool.query('SELECT * FROM platform_settings WHERE id = 1');
  return rowToSettings(result.rows[0]);
}

async function updatePlatformSettings(updates, adminId) {
  const bookingLeadTime = parseInt(updates.bookingLeadTime, 10);
  const reminderTiming = parseInt(updates.reminderTiming, 10);
  const maxServiceRadius = parseInt(updates.maxServiceRadius, 10);
  const minRating = parseFloat(updates.minRating);

  if (
    Number.isNaN(bookingLeadTime) || bookingLeadTime < 1 || bookingLeadTime > 30 ||
    Number.isNaN(reminderTiming) || reminderTiming < 1 || reminderTiming > 72 ||
    Number.isNaN(maxServiceRadius) || maxServiceRadius < 5 || maxServiceRadius > 200 ||
    Number.isNaN(minRating) || minRating < 0 || minRating > 5
  ) {
    return { ok: false, error: 'Invalid settings values' };
  }

  const result = await pool.query(
    `UPDATE platform_settings
     SET booking_lead_time_days = $1,
         reminder_timing_hours = $2,
         max_service_radius_km = $3,
         min_rating = $4,
         updated_at = CURRENT_TIMESTAMP,
         updated_by_admin_id = $5
     WHERE id = 1
     RETURNING *`,
    [bookingLeadTime, reminderTiming, maxServiceRadius, minRating, adminId || null]
  );

  return { ok: true, settings: rowToSettings(result.rows[0]) };
}

async function updateMaintenanceSignal(enabled, adminId) {
  const signalEnabled = Boolean(enabled);
  const result = await pool.query(
    `UPDATE platform_settings
     SET maintenance_signal_enabled = $1,
         updated_at = CURRENT_TIMESTAMP,
         updated_by_admin_id = $2
     WHERE id = 1
     RETURNING *`,
    [signalEnabled, adminId || null]
  );
  return { ok: true, maintenanceSignalEnabled: Boolean(result.rows[0]?.maintenance_signal_enabled) };
}

async function getMaintenanceSignalEnabled() {
  const settings = await getPlatformSettings();
  return Boolean(settings.maintenanceSignalEnabled);
}

module.exports = {
  DEFAULT_SETTINGS,
  ensurePlatformSettingsSchema,
  getPlatformSettings,
  updatePlatformSettings,
  updateMaintenanceSignal,
  getMaintenanceSignalEnabled,
};
