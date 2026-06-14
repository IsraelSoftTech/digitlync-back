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
    // Prevent overlapping slots for the same provider on the same date
    const overlapCheck = await pool.query(
      `SELECT id FROM provider_availability_slots WHERE provider_id = $1 AND available_date = $2
       AND NOT (end_time <= $3 OR start_time >= $4) LIMIT 1`,
      [providerId, available_date, start_time, end_time]
    );
    if (overlapCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Slot overlaps existing availability' });
    }
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

// Update an availability slot by id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { available_date, start_time, end_time } = req.body || {};
  if (!available_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'available_date, start_time and end_time are required' });
  }
  try {
    // Ensure slot exists
    const existing = await pool.query('SELECT * FROM provider_availability_slots WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Slot not found' });
    const providerId = existing.rows[0].provider_id;

    // Prevent overlaps with other slots (exclude current id)
    const overlapCheck = await pool.query(
      `SELECT id FROM provider_availability_slots WHERE provider_id = $1 AND available_date = $2
       AND id <> $5 AND NOT (end_time <= $3 OR start_time >= $4) LIMIT 1`,
      [providerId, available_date, start_time, end_time, id]
    );
    if (overlapCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Updated slot would overlap existing availability' });
    }

    const r = await pool.query(
      `UPDATE provider_availability_slots SET available_date = $1, start_time = $2, end_time = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [available_date, start_time, end_time, id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Availability update error:', err);
    res.status(500).json({ error: 'Failed to update slot' });
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
