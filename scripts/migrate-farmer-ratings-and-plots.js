/**
 * Migration: Farmer ratings (farmer rates provider after booking) + farm_plots (multiple plots per farmer)
 * Run: node scripts/migrate-farmer-ratings-and-plots.js
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
    // 1. Farmer ratings (farmer rates provider after booking completion)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS farmer_ratings (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        farmer_id INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
        provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        rating DECIMAL(2, 1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(booking_id)
      )
    `);
    console.log('Farmer ratings table created.');

    // 2. Farm plots (multiple GPS locations per farmer)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS farm_plots (
        id SERIAL PRIMARY KEY,
        farmer_id INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
        gps_lat DECIMAL(10, 7) NOT NULL,
        gps_lng DECIMAL(10, 7) NOT NULL,
        plot_name VARCHAR(200),
        plot_size_ha DECIMAL(10, 2),
        crop_type VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Farm plots table created.');

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
