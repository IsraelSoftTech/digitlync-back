const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'DigiLync API' });
});

// API routes (to be expanded per SRS modules)
app.use('/api/farmers', require('./routes/farmers'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/bookings', require('./routes/bookings'));

module.exports = app;
