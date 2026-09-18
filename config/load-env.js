/**
 * Load .env then optionally override with .env.production.
 * Windows-friendly: `npm run start:prod` passes --prod (NODE_ENV=foo npm ... does not work in PowerShell).
 */
const fs = require('fs');
const path = require('path');

function wantsProductionEnv() {
  if (process.env.NODE_ENV === 'production') return true;
  if (String(process.env.DIGILYNC_ENV || '').toLowerCase() === 'production') return true;
  return process.argv.includes('--prod');
}

function loadEnv() {
  const root = path.join(__dirname, '..');
  require('dotenv').config({ path: path.join(root, '.env') });

  const useProd = wantsProductionEnv();
  const prodPath = path.join(root, '.env.production');
  if (useProd && fs.existsSync(prodPath)) {
    require('dotenv').config({ path: prodPath, override: true });
    process.env.NODE_ENV = 'production';
  }
  return { useProd, nodeEnv: process.env.NODE_ENV || 'development' };
}

module.exports = { loadEnv, wantsProductionEnv };
