/**
 * Notifications API - real alerts from system state
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/notifications - alerts for admin
router.get('/', async (req, res) => {
  try {
    const alerts = [];

    const unassigned = await pool.query(
      `SELECT COUNT(*)::int AS c FROM bookings WHERE provider_id IS NULL AND status = 'pending'`
    );
    const unassignedCount = unassigned.rows[0]?.c ?? 0;
    if (unassignedCount > 0) {
      alerts.push({
        id: 'unassigned',
        type: 'matching',
        title: 'Bookings need matching',
        message: `${unassignedCount} request(s) waiting for provider assignment.`,
        count: unassignedCount,
        link: '/bookings?unassigned=1',
        created_at: new Date().toISOString(),
      });
    }

    const lowRated = await pool.query(
      `SELECT p.id, p.full_name, AVG(fr.rating)::float AS avg
       FROM providers p
       JOIN farmer_ratings fr ON fr.provider_id = p.id
       GROUP BY p.id, p.full_name
       HAVING AVG(fr.rating) < 3.5`
    );
    lowRated.rows.forEach((r) => {
      alerts.push({
        id: `low-rating-${r.id}`,
        type: 'performance',
        title: 'Low provider rating',
        message: `${r.full_name} has an average rating of ${Math.round(parseFloat(r.avg) * 10) / 10}/5.`,
        providerId: r.id,
        created_at: new Date().toISOString(),
      });
    });

    const pendingBookings = await pool.query(
      `SELECT COUNT(*)::int AS c FROM bookings WHERE status = 'awaiting_provider_accept' AND provider_id IS NOT NULL`
    );
    const pendingCount = pendingBookings.rows[0]?.c ?? 0;
    if (pendingCount > 0) {
      alerts.push({
        id: 'pending-confirm',
        type: 'info',
        title: 'Awaiting provider confirmation',
        message: `${pendingCount} auto-matched booking(s) waiting for provider acceptance.`,
        count: pendingCount,
        link: '/bookings?status=awaiting_provider_accept',
        created_at: new Date().toISOString(),
      });
    }

    const recentAutoMatched = await pool.query(
      `SELECT COUNT(*)::int AS c FROM admin_audit_logs
       WHERE action_type = 'matching' AND created_at > NOW() - INTERVAL '24 hours'`
    );
    const recentMatchCount = recentAutoMatched.rows[0]?.c ?? 0;
    if (recentMatchCount > 0) {
      alerts.push({
        id: 'recent-auto-match',
        type: 'matching',
        title: 'Recent auto-matches',
        message: `${recentMatchCount} automatic match event(s) in the last 24 hours.`,
        count: recentMatchCount,
        link: '/audit',
        created_at: new Date().toISOString(),
      });
    }

    res.json({ alerts });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

module.exports = router;
