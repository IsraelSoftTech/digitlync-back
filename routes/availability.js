const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/provider/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const { from, to } = req.query;
    const params = [providerId];
    let where = 'WHERE provider_id = $1';
    if (from) {
      params.push(from);
      where += ` AND available_date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      where += ` AND available_date <= $${params.length}`;
    }
    const r = await pool.query(
      `SELECT * FROM provider_availability_slots ${where}
       ORDER BY available_date ASC, start_time ASC`,
      params
    );
    res.json({ slots: r.rows });
  } catch (err) {
    console.error('Availability list error:', err);
    res.status(500).json({ error: 'Failed to fetch availability slots' });
  }
});

router.post('/provider/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const { available_date, start_time, end_time } = req.body || {};
  if (!available_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'available_date, start_time and end_time are required' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO provider_availability_slots (provider_id, available_date, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider_id, available_date, start_time, end_time) DO UPDATE SET end_time = EXCLUDED.end_time
       RETURNING *`,
      [providerId, available_date, start_time, end_time]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('Availability create error:', err);
    res.status(500).json({ error: 'Failed to create availability slot' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM provider_availability_slots WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Slot not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Availability delete error:', err);
    res.status(500).json({ error: 'Failed to delete slot' });
  }
});

module.exports = router;
