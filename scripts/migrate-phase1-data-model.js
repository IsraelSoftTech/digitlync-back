/**
 * Phase 1 Data Model Migration
 * - Provider GPS (gps_lat, gps_lng)
 * - Farmer Layers 2–5 (Production, Financial, Assets, Verification)
 * - Provider Layers 2–8 (Equipment, Geographic, Labour, Pricing, Availability, Trust, Performance)
 * Run: node scripts/migrate-phase1-data-model.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    // ─── PROVIDER: GPS + Layers 2–8 ─────────────────────────────────────────
    console.log('Adding provider columns...');
    await pool.query(`
      ALTER TABLE providers
        ADD COLUMN IF NOT EXISTS gps_lat DECIMAL(10, 8),
        ADD COLUMN IF NOT EXISTS gps_lng DECIMAL(11, 8),
        ADD COLUMN IF NOT EXISTS number_of_machines INTEGER,
        ADD COLUMN IF NOT EXISTS equipment_condition VARCHAR(50),
        ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(50),
        ADD COLUMN IF NOT EXISTS backup_equipment_available BOOLEAN,
        ADD COLUMN IF NOT EXISTS years_operating INTEGER,
        ADD COLUMN IF NOT EXISTS willingness_to_travel BOOLEAN,
        ADD COLUMN IF NOT EXISTS travel_surcharge_per_km DECIMAL(10, 2),
        ADD COLUMN IF NOT EXISTS labour_provided BOOLEAN,
        ADD COLUMN IF NOT EXISTS number_of_workers INTEGER,
        ADD COLUMN IF NOT EXISTS skilled_vs_unskilled VARCHAR(255),
        ADD COLUMN IF NOT EXISTS ability_to_scale_large_farms BOOLEAN,
        ADD COLUMN IF NOT EXISTS minimum_booking_size_ha DECIMAL(10, 2),
        ADD COLUMN IF NOT EXISTS minimum_charge_ha DECIMAL(10, 2),
        ADD COLUMN IF NOT EXISTS fuel_included BOOLEAN,
        ADD COLUMN IF NOT EXISTS advance_payment_percent DECIMAL(5, 2),
        ADD COLUMN IF NOT EXISTS accepted_payment_methods TEXT,
        ADD COLUMN IF NOT EXISTS cancellation_policy TEXT,
        ADD COLUMN IF NOT EXISTS days_available_per_week INTEGER,
        ADD COLUMN IF NOT EXISTS peak_season_capacity TEXT,
        ADD COLUMN IF NOT EXISTS required_booking_lead_time_days INTEGER,
        ADD COLUMN IF NOT EXISTS national_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS equipment_ownership_proof TEXT,
        ADD COLUMN IF NOT EXISTS reference_contact TEXT,
        ADD COLUMN IF NOT EXISTS consent_platform_rules BOOLEAN,
        ADD COLUMN IF NOT EXISTS agreement_no_show_penalties BOOLEAN,
        ADD COLUMN IF NOT EXISTS on_time_completion_rate DECIMAL(5, 2),
        ADD COLUMN IF NOT EXISTS job_success_rate DECIMAL(5, 2),
        ADD COLUMN IF NOT EXISTS dispute_frequency INTEGER,
        ADD COLUMN IF NOT EXISTS repeat_client_percent DECIMAL(5, 2)
    `);
    console.log('Provider columns added.');

    // ─── FARMER: Layers 2–5 ──────────────────────────────────────────────────
    console.log('Adding farmer columns...');
    await pool.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS number_of_plots INTEGER,
        ADD COLUMN IF NOT EXISTS soil_type VARCHAR(100),
        ADD COLUMN IF NOT EXISTS irrigation_type VARCHAR(100),
        ADD COLUMN IF NOT EXISTS planting_season VARCHAR(100),
        ADD COLUMN IF NOT EXISTS expected_harvest_month VARCHAR(50),
        ADD COLUMN IF NOT EXISTS estimated_yield_per_ha DECIMAL(12, 2),
        ADD COLUMN IF NOT EXISTS previous_yield DECIMAL(12, 2),
        ADD COLUMN IF NOT EXISTS seed_variety VARCHAR(200),
        ADD COLUMN IF NOT EXISTS fertilizer_use VARCHAR(255),
        ADD COLUMN IF NOT EXISTS pest_disease_challenges TEXT,
        ADD COLUMN IF NOT EXISTS bank_account_access BOOLEAN,
        ADD COLUMN IF NOT EXISTS mobile_money_access BOOLEAN,
        ADD COLUMN IF NOT EXISTS seasonal_revenue DECIMAL(14, 2),
        ADD COLUMN IF NOT EXISTS existing_loans DECIMAL(14, 2),
        ADD COLUMN IF NOT EXISTS cooperative_membership BOOLEAN,
        ADD COLUMN IF NOT EXISTS current_buyers TEXT,
        ADD COLUMN IF NOT EXISTS storage_method VARCHAR(200),
        ADD COLUMN IF NOT EXISTS post_harvest_loss_percent DECIMAL(5, 2),
        ADD COLUMN IF NOT EXISTS land_ownership VARCHAR(100),
        ADD COLUMN IF NOT EXISTS years_farming INTEGER,
        ADD COLUMN IF NOT EXISTS access_to_tractor_services BOOLEAN,
        ADD COLUMN IF NOT EXISTS access_to_labour BOOLEAN,
        ADD COLUMN IF NOT EXISTS storage_capacity VARCHAR(200),
        ADD COLUMN IF NOT EXISTS mechanization_level VARCHAR(100),
        ADD COLUMN IF NOT EXISTS geo_tagged_farm_photos TEXT,
        ADD COLUMN IF NOT EXISTS national_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS next_of_kin TEXT,
        ADD COLUMN IF NOT EXISTS consent_to_data_use BOOLEAN
    `);
    console.log('Farmer columns added.');

    console.log('Phase 1 data model migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
