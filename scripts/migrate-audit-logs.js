/**
 * Migration: Admin audit logs table
 * Run: node scripts/migrate-audit-logs.js
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
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        admin_username VARCHAR(100),
        action_type VARCHAR(50) NOT NULL,
        action TEXT NOT NULL,
        entity_type VARCHAR(50),
        entity_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('admin_audit_logs table created.');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON admin_audit_logs(admin_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON admin_audit_logs(action_type);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at);
    `);
    console.log('Audit logs indexes created.');

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
