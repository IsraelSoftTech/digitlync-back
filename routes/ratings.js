/**
 * Ratings API - farmer ratings of providers (from completed bookings)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/ratings/summary - system-wide and provider breakdown
router.get('/summary', async (req, res) => {
  try {
    let avgRes = { rows: [{ avg: null, total: 0 }] };
    let byProvider = { rows: [] };
    try {
      avgRes = await pool.query(
      `SELECT AVG(rating)::float AS avg, COUNT(*)::int AS total FROM farmer_ratings`
    );
      byProvider = await pool.query(
      `SELECT p.id, p.full_name, p.services_offered,
              AVG(fr.rating)::float AS avg_rating, COUNT(fr.id)::int AS rating_count
       FROM providers p
       JOIN farmer_ratings fr ON fr.provider_id = p.id
       GROUP BY p.id, p.full_name, p.services_offered
       ORDER BY avg_rating DESC`
      );
    } catch (_) {
      /* ignore ratings query errors */
    }

    const avg = parseFloat(avgRes.rows[0]?.avg) || 0;
    const total = avgRes.rows[0]?.total ?? 0;

    const top = byProvider.rows.filter((r) => parseFloat(r.avg_rating) >= 4).slice(0, 10);
    const low = byProvider.rows.filter((r) => parseFloat(r.avg_rating) < 3.5);

    res.json({
      systemAvg: Math.round(avg * 10) / 10,
      totalRatings: total,
      topProviders: top,
      lowRatedProviders: low,
      byProvider: byProvider.rows,
    });
  } catch (err) {
    console.error('Ratings summary error:', err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// GET /api/ratings/recent - recent ratings with details
router.get('/recent', async (req, res) => {
  try {
    let r = { rows: [] };
    try {
      r = await pool.query(
      `SELECT fr.id, fr.rating, fr.notes, fr.created_at,
              p.full_name AS provider_name, f.full_name AS farmer_name, b.service_type
       FROM farmer_ratings fr
       JOIN providers p ON p.id = fr.provider_id
       JOIN farmers f ON f.id = fr.farmer_id
       JOIN bookings b ON b.id = fr.booking_id
       ORDER BY fr.created_at DESC LIMIT 20`
      );
    } catch (_) {
      /* ignore recent ratings query errors */
    }
    res.json({ ratings: r.rows });
  } catch (err) {
    console.error('Ratings recent error:', err);
    res.status(500).json({ error: 'Failed to fetch recent ratings' });
  }
});

module.exports = router;
