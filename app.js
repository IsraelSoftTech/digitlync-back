const express = require('express');
const cors = require('cors');

const app = express();

// CORS: allow frontend (localhost:3000 in dev, digilync.net in prod)
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim());
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some((o) => origin === o || origin.startsWith(o))) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
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
app.use('/api/farmers', require('./routes/farmers'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/bookings', require('./routes/bookings'));

module.exports = app;
