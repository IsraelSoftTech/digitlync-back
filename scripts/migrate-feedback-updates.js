/**
 * Migration: Feedback updates (Farmer location structure, booking time/produce, provider services, admin ratings)
 * Run: node scripts/migrate-feedback-updates.js
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
    // 1. Farmers: Add structured location columns (keep village/location for backward compatibility)
    await pool.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS country VARCHAR(100),
        ADD COLUMN IF NOT EXISTS region VARCHAR(200),
        ADD COLUMN IF NOT EXISTS division VARCHAR(200),
        ADD COLUMN IF NOT EXISTS subdivision VARCHAR(200),
        ADD COLUMN IF NOT EXISTS district VARCHAR(200),
        ADD COLUMN IF NOT EXISTS service_needs TEXT[] DEFAULT '{}'
    `);
    console.log('Farmers: Added country, region, division, subdivision, district, service_needs.');

    // 2. Bookings: Add scheduled_time and farm_produce_type
    await pool.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS scheduled_time TIME,
        ADD COLUMN IF NOT EXISTS farm_produce_type VARCHAR(200)
    `);
    console.log('Bookings: Added scheduled_time, farm_produce_type.');

    // 3. Provider services (multiple services per provider)
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
    console.log('Provider services table created.');

    // 4. Provider service equipment (multiple equipment per service)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS provider_service_equipment (
        id SERIAL PRIMARY KEY,
        provider_service_id INTEGER NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        equipment_name VARCHAR(200) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Provider service equipment table created.');

    // 5. Admin ratings (admins can rate farmers and providers)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_ratings (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        ratee_type VARCHAR(20) NOT NULL CHECK (ratee_type IN ('farmer', 'provider')),
        ratee_id INTEGER NOT NULL,
        rating DECIMAL(2, 1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ratee_type, ratee_id, admin_id)
      )
    `);
    console.log('Admin ratings table created.');

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
