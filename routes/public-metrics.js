/**
 * Public metrics endpoint for landing page live stats.
 * No auth required - returns aggregate counts for platform credibility.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/public/metrics - platform stats for public landing page
router.get('/metrics', async (req, res) => {
  try {
    const farmersRes = await pool.query('SELECT COUNT(*)::int AS count FROM farmers');
    const farmersCount = farmersRes.rows[0]?.count ?? 0;

    let providersCount = 0;
    let bookingsCount = 0;
    let completedCount = 0;
    let activeRegionsCount = 0;
    let averageRating = null;
    let onTimeCompletionRate = null;

    try {
      const r = await pool.query('SELECT COUNT(*)::int AS count FROM providers');
      providersCount = r.rows[0]?.count ?? 0;
    } catch (_) {}

    try {
      const r = await pool.query('SELECT COUNT(*)::int AS count FROM bookings');
      bookingsCount = r.rows[0]?.count ?? 0;
    } catch (_) {}

    try {
      const r = await pool.query(
        "SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'completed'"
      );
      completedCount = r.rows[0]?.count ?? 0;
    } catch (_) {}

    try {
      const r = await pool.query(`
        SELECT COUNT(DISTINCT COALESCE(district, division, region, village))::int AS count
        FROM farmers
        WHERE COALESCE(district, division, region, village) IS NOT NULL
          AND TRIM(COALESCE(district, division, region, village)) != ''
      `);
      activeRegionsCount = r.rows[0]?.count ?? 0;
    } catch (_) {}

    try {
      const r = await pool.query(
        'SELECT ROUND(AVG(rating)::numeric, 1) AS avg FROM admin_ratings'
      );
      const avg = r.rows[0]?.avg;
      averageRating = avg != null ? parseFloat(avg) : null;
    } catch (_) {}

    if (completedCount > 0 && bookingsCount > 0) {
      onTimeCompletionRate = Math.round((completedCount / bookingsCount) * 100);
    }

    res.json({
      farmsOnboarded: farmersCount,
      serviceProvidersRegistered: providersCount,
      serviceRequestsSubmitted: bookingsCount,
      completedServices: completedCount,
      activeRegions: activeRegionsCount,
      averageServiceRating: averageRating,
      onTimeCompletionRatePercent: onTimeCompletionRate,
    });
  } catch (err) {
    console.error('Public metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

module.exports = router;
