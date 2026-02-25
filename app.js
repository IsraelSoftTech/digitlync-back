const express = require('express');
const cors = require('cors');

const app = express();

// CORS: allow frontend (localhost:3000 in dev, digilync.net + www in prod)
const defaultOrigins =
  process.env.NODE_ENV === 'production'
    ? ['https://digilync.net', 'https://www.digilync.net']
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
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());

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
  res.json({
    status: 'ok',
    message: 'DigiLync API',
    db,
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
app.use('/api/public', require('./routes/public-metrics'));

module.exports = app;
