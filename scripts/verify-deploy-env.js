#!/usr/bin/env node
/**
 * Check env that this process would actually use.
 * Windows:
 *   npm run verify:deploy
 *   npm run verify:deploy:prod
 */
const { loadEnv } = require('../config/load-env');
loadEnv();

const fe = process.env.FRONTEND_URL || '';
const pub = process.env.PUBLIC_FRONTEND_URL || '';
const be = process.env.BACKEND_URL || '';
const nodeEnv = process.env.NODE_ENV || 'development';
const firstFe = fe.split(',')[0] || '';
const botLinkBase = pub || firstFe;
let ok = true;

function fail(msg) {
  console.error('FAIL:', msg);
  ok = false;
}
function pass(msg) {
  console.log('OK:', msg);
}

console.log('DigiLync env check (this machine / this process)\n');
console.log('  NODE_ENV:', nodeEnv);
console.log('  FRONTEND_URL:', fe || '(unset)');
console.log('  PUBLIC_FRONTEND_URL:', pub || '(unset)');
console.log('  BACKEND_URL:', be || '(unset)');
console.log('  DB_HOST:', process.env.DB_HOST || '(unset)');
console.log('  WhatsApp GPS links will use:', botLinkBase || '(unset)');
console.log('');

if (/localhost|127\.0\.0\.1/i.test(botLinkBase)) {
  fail('Bot GPS links would be localhost — run: npm run verify:deploy:prod');
} else if (botLinkBase) {
  pass(`Bot GPS links: ${botLinkBase}/gps?t=...`);
}

if (nodeEnv !== 'production') {
  fail('NODE_ENV is not production. For live-like config run: npm run verify:deploy:prod');
} else {
  pass('NODE_ENV=production');
}

if (!process.env.DB_HOST) fail('DB_HOST missing');
else pass(`DB_HOST=${process.env.DB_HOST}`);

if (!process.env.META_WHATSAPP_ACCESS_TOKEN || !process.env.META_WHATSAPP_PHONE_NUMBER_ID) {
  fail('WhatsApp Meta token/phone id empty in this env file — bot cannot send');
} else {
  pass('WhatsApp Meta credentials present');
}

console.log('');
console.log('Note: https://api.digilync.net/api/health is the LIVE server, not this laptop.');
console.log('Local health:  http://localhost:5000/api/health');

process.exit(ok ? 0 : 1);
