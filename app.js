const express = require('express');
const cors = require('cors');

const app = express();

// CORS: allow frontend (localhost:3000 in dev, digilync.net in prod)
const defaultOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://digilync.net', 'https://www.digilync.net', 'https://digitlync-front.onrender.com']
    : ['http://localhost:3000'];
const allowedOrigins = (process.env.FRONTEND_URL || defaultOrigins.join(','))
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
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
app.use('/api/audit-logs', require('./routes/audit-logs'));
app.use('/api/public', require('./routes/public-metrics'));
app.use('/api/farm-plots', require('./routes/farm-plots'));
app.use('/api/whatsapp', require('./routes/whatsapp-webhook'));

module.exports = app;
