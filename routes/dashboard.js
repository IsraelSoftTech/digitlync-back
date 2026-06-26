const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/dashboard/stats - overview stats for admin dashboard
router.get('/stats', async (req, res) => {
  try {
    const farmersRes = await pool.query('SELECT COUNT(*)::int AS count FROM farmers');
    const farmersCount = farmersRes.rows[0]?.count ?? 0;

    let providersCount = 0;
    let bookingsCount = 0;
    try {
      const r = await pool.query('SELECT COUNT(*)::int AS count FROM providers');
      providersCount = r.rows[0]?.count ?? 0;
    } catch (_) {
      /* ignore provider count errors */
    }
    try {
      const r = await pool.query('SELECT COUNT(*)::int AS count FROM bookings');
      bookingsCount = r.rows[0]?.count ?? 0;
    } catch (_) {
      /* ignore booking count errors */
    }

    let pendingRequests = 0;
    let awaitingProviderAccept = 0;
    try {
      const r = await pool.query("SELECT COUNT(*)::int AS count FROM bookings WHERE provider_id IS NULL AND status = 'pending'");
      pendingRequests = r.rows[0]?.count ?? 0;
    } catch (_) {
      /* ignore pending requests count errors */
    }
    try {
      const r = await pool.query(
        "SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'awaiting_provider_accept' AND provider_id IS NOT NULL"
      );
      awaitingProviderAccept = r.rows[0]?.count ?? 0;
    } catch (_) {
      /* ignore */
    }

    res.json({
      farmers: farmersCount,
      providers: providersCount,
      bookings: bookingsCount,
      pendingRequests,
      awaitingProviderAccept,
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

module.exports = router;
