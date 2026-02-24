const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, p.full_name AS provider_name, p.phone AS provider_phone
      FROM bookings b
      LEFT JOIN farmers f ON b.farmer_id = f.id
      LEFT JOIN providers p ON b.provider_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ` AND b.status = $${params.length}`;
    }
    query += ' ORDER BY b.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error('Bookings list error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, f.village AS farmer_village, f.district AS farmer_district,
        p.full_name AS provider_name, p.phone AS provider_phone, p.services_offered
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Booking get error:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

router.post('/', async (req, res) => {
  const { farmer_id, provider_id, service_type, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes } = req.body || {};
  if (!farmer_id || !provider_id) return res.status(400).json({ error: 'Farmer and provider are required' });
  try {
    const result = await pool.query(
      `INSERT INTO bookings (farmer_id, provider_id, service_type, status, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8) RETURNING *`,
      [farmer_id, provider_id, service_type?.trim() || null, scheduled_date || null, scheduled_time || null, farm_size_ha != null ? parseFloat(farm_size_ha) : null, farm_produce_type?.trim() || null, notes?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Booking create error:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

router.put('/:id', async (req, res) => {
  const { status, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE bookings SET status=COALESCE($1, status), scheduled_date=COALESCE($2, scheduled_date),
        scheduled_time=COALESCE($3, scheduled_time), farm_size_ha=COALESCE($4, farm_size_ha),
        farm_produce_type=COALESCE($5, farm_produce_type), notes=COALESCE($6, notes), updated_at=CURRENT_TIMESTAMP
       WHERE id=$7 RETURNING *`,
      [status || null, scheduled_date || null, scheduled_time || null, farm_size_ha != null ? parseFloat(farm_size_ha) : null, farm_produce_type !== undefined ? farm_produce_type : null, notes !== undefined ? notes : null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Booking update error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Booking delete error:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

module.exports = router;
