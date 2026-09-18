const { loadEnv } = require('./config/load-env');
loadEnv();

const app = require('./app');

const PORT = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === 'production';

function warnMisconfiguredProductionEnv() {
  const fe = String(process.env.FRONTEND_URL || '');
  const pub = String(process.env.PUBLIC_FRONTEND_URL || '');
  const publicLink = pub || fe.split(',')[0] || '';
  if (!/localhost|127\.0\.0\.1/i.test(publicLink)) return;
  console.error('');
  console.error('*** MISCONFIGURED: GPS links would be localhost ***');
  console.error('Use:  npm run start:prod');
  console.error('That loads .env.production (https://www.digilync.net).');
  console.error('Plain `npm start` is local development only.');
  console.error('');
}

if (!process.env.META_WHATSAPP_ACCESS_TOKEN || !process.env.META_WHATSAPP_PHONE_NUMBER_ID) {
  console.warn('[WhatsApp] META_WHATSAPP_ACCESS_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID is empty — bot cannot send messages.');
}

app.listen(PORT, () => {
  warnMisconfiguredProductionEnv();
  console.log(`Digilync API running on port ${PORT}`);
  console.log(`  Mode: ${isProd ? 'production' : 'development'}`);
  console.log(`  FRONTEND_URL: ${process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '(not set)'}`);
  console.log(`  URL: ${process.env.BACKEND_URL || (isProd ? 'https://api.digilync.net' : `http://localhost:${PORT}`)}`);
});
