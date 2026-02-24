const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/admin-ratings?ratee_type=farmer|provider&ratee_id=123
router.get('/', async (req, res) => {
  const { ratee_type, ratee_id } = req.query;
  if (!ratee_type || !ratee_id) {
    return res.status(400).json({ error: 'ratee_type and ratee_id required' });
  }
  if (!['farmer', 'provider'].includes(ratee_type)) {
    return res.status(400).json({ error: 'ratee_type must be farmer or provider' });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM admin_ratings WHERE ratee_type = $1 AND ratee_id = $2 ORDER BY created_at DESC`,
      [ratee_type, ratee_id]
    );
    res.json({ ratings: result.rows });
  } catch (err) {
    console.error('Admin ratings get error:', err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// POST /api/admin-ratings - submit or update admin rating
router.post('/', async (req, res) => {
  const { admin_id, ratee_type, ratee_id, rating, notes } = req.body || {};
  if (!ratee_type || !ratee_id || rating == null) {
    return res.status(400).json({ error: 'ratee_type, ratee_id, and rating are required' });
  }
  if (!['farmer', 'provider'].includes(ratee_type)) {
    return res.status(400).json({ error: 'ratee_type must be farmer or provider' });
  }
  const r = parseFloat(rating);
  if (isNaN(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }
  const aid = admin_id != null ? parseInt(admin_id, 10) : 1;
  try {
    const result = await pool.query(
      `INSERT INTO admin_ratings (admin_id, ratee_type, ratee_id, rating, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ratee_type, ratee_id, admin_id) DO UPDATE SET rating = $4, notes = $5, created_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [aid, ratee_type, parseInt(ratee_id, 10), r, notes?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(500).json({ error: 'Admin ratings table not found. Run migration: node scripts/migrate-feedback-updates.js' });
    }
    console.error('Admin rating submit error:', err);
    res.status(500).json({ error: 'Failed to save rating' });
  }
});

module.exports = router;
