const express = require('express');
const cors = require('cors');

const app = express();
const { ensureOperationalSchema } = require('./services/operational-core');
const { ensurePlatformSettingsSchema } = require('./services/platform-settings');

// CORS: allow frontend (localhost:3000 in dev, digilync.net in prod)
// FRONTEND_URL is merged with defaults so a single origin in .env does not drop www / Render preview.
const defaultOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://digilync.net', 'https://www.digilync.net', 'https://digitlync-front.onrender.com']
    : ['http://localhost:3000'];
const envOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];
const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman) or matching allowed list
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Id', 'X-Admin-Username'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check (includes DB connectivity test)
app.get('/api/health', async (req, res) => {
  const db = { connected: false };
  try {
    const { pool } = require('./config/db');
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    db.connected = true;
  } catch (err) {
    db.error = err.message;
  }
  const whatsapp = (() => {
    try {
      const { isEnabled } = require('./services/whatsapp-sender');
      return isEnabled() ? 'configured' : 'not_configured';
    } catch (_) {
      return 'error';
    }
  })();

  res.json({
    status: 'ok',
    message: 'Digilync API',
    db,
    whatsapp,
    env: process.env.NODE_ENV || 'development',
  });
});

// API routes (to be expanded per SRS modules)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/farmers', require('./routes/farmers'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/admin-ratings', require('./routes/admin-ratings'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin-confirmations', require('./routes/admin-confirmations'));
app.use('/api/audit-logs', require('./routes/audit-logs'));
app.use('/api/public', require('./routes/public-metrics'));
app.use('/api/public', require('./routes/public-farmer-gps'));
app.use('/api/farm-plots', require('./routes/farm-plots'));
app.use('/api/whatsapp', require('./routes/whatsapp-webhook'));
app.use('/api/availability', require('./routes/availability'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/job-events', require('./routes/job-events'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/settings', require('./routes/settings'));

// Best-effort bootstrapping for operational schema.
ensureOperationalSchema().catch((err) => {
  console.error('Operational schema bootstrap failed:', err.message);
});
ensurePlatformSettingsSchema().catch((err) => {
  console.error('Platform settings schema bootstrap failed:', err.message);
});

module.exports = app;
