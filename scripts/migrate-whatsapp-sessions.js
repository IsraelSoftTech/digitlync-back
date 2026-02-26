/**
 * Migration: WhatsApp bot sessions for conversation state
 * Run: node scripts/migrate-whatsapp-sessions.js
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id SERIAL PRIMARY KEY,
        wa_phone VARCHAR(50) NOT NULL UNIQUE,
        user_type VARCHAR(20) DEFAULT 'unknown' CHECK (user_type IN ('unknown', 'farmer', 'provider')),
        step VARCHAR(50) DEFAULT 'welcome',
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_wa_phone ON whatsapp_sessions(wa_phone)
    `);
    console.log('whatsapp_sessions table created successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
