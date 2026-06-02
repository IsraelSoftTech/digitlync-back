/**
 * Migration: operational core schema for booking lifecycle
 * Run: node scripts/migrate-operational-core.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { ensureOperationalSchema } = require('../services/operational-core');

async function run() {
  try {
    await ensureOperationalSchema();
    console.log('Operational core migration completed.');
    process.exit(0);
  } catch (err) {
    console.error('Operational core migration failed:', err.message);
    process.exit(1);
  }
}

run();
