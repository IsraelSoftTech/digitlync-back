/**
 * Public metrics endpoint for landing page live stats.
 * No auth required - returns aggregate counts for platform credibility.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/public/metrics - platform stats for public landing page
router.get('/metrics', async (req, res) => {
  let farmersCount = 0;
  let providersCount = 0;
  let bookingsCount = 0;
  let completedCount = 0;
  let activeRegionsCount = 0;
  let averageRating = null;
  let onTimeCompletionRate = null;

  try {
    const farmersRes = await pool.query('SELECT COUNT(*)::int AS count FROM farmers');
    farmersCount = farmersRes.rows[0]?.count ?? 0;
  } catch (e) {
    console.error('Public metrics farmers count error:', e.message);
  }

  try {
    const r = await pool.query('SELECT COUNT(*)::int AS count FROM providers');
    providersCount = r.rows[0]?.count ?? 0;
  } catch (_) {
    /* ignore providers count error */
  }

  try {
    const r = await pool.query('SELECT COUNT(*)::int AS count FROM bookings');
    bookingsCount = r.rows[0]?.count ?? 0;
  } catch (_) {
    /* ignore bookings count error */
  }

  try {
    const r = await pool.query(
      "SELECT COUNT(*)::int AS count FROM bookings WHERE status = 'completed'"
    );
    completedCount = r.rows[0]?.count ?? 0;
  } catch (_) {
    /* ignore completed count error */
  }

  try {
    const r = await pool.query(`
      SELECT COUNT(DISTINCT COALESCE(district, division, region, village))::int AS count
      FROM farmers
      WHERE COALESCE(district, division, region, village) IS NOT NULL
        AND TRIM(COALESCE(district, division, region, village)) != ''
    `);
    activeRegionsCount = r.rows[0]?.count ?? 0;
  } catch (_) {
    /* ignore active regions count error */
  }

  try {
    const r = await pool.query(
      'SELECT ROUND(AVG(rating)::numeric, 1) AS avg FROM admin_ratings'
    );
    const avg = r.rows[0]?.avg;
    averageRating = avg != null ? parseFloat(avg) : null;
  } catch (_) {
    /* ignore average rating error */
  }

  try {
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

function isValidGps(lat, lng) {
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (Number.isNaN(la) || Number.isNaN(lo)) return false;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return false;
  if (la === 0 && lo === 0) return false;
  return true;
}

// GET /api/public/locations - farmers, farm plots, and providers with GPS for public map (no auth)
router.get('/locations', async (req, res) => {
  try {
    const locations = [];

    const farmersRes = await pool.query(`
      SELECT id, full_name, village, region, district, gps_lat, gps_lng
      FROM farmers
      WHERE gps_lat IS NOT NULL AND gps_lng IS NOT NULL
      ORDER BY created_at DESC
    `);
    for (const f of farmersRes.rows) {
      if (!isValidGps(f.gps_lat, f.gps_lng)) continue;
      locations.push({
        type: 'farmer',
        id: `farmer-${f.id}`,
        entity_id: f.id,
        full_name: f.full_name,
        village: f.village || f.district || f.region || '',
        gps_lat: parseFloat(f.gps_lat),
        gps_lng: parseFloat(f.gps_lng),
      });
    }

    try {
      const plotsRes = await pool.query(`
        SELECT fp.id, fp.farmer_id, fp.plot_name, fp.gps_lat, fp.gps_lng, fp.crop_type,
               f.full_name AS farmer_name, f.village, f.district, f.region
        FROM farm_plots fp
        JOIN farmers f ON f.id = fp.farmer_id
        WHERE fp.gps_lat IS NOT NULL AND fp.gps_lng IS NOT NULL
        ORDER BY fp.id ASC
      `);
      for (const p of plotsRes.rows) {
        if (!isValidGps(p.gps_lat, p.gps_lng)) continue;
        locations.push({
          type: 'plot',
          id: `plot-${p.id}`,
          entity_id: p.id,
          full_name: p.plot_name || `${p.farmer_name || 'Farm'} (plot)`,
          village: p.village || p.district || p.region || '',
          crop_type: p.crop_type,
          gps_lat: parseFloat(p.gps_lat),
          gps_lng: parseFloat(p.gps_lng),
        });
      }
    } catch (plotErr) {
      console.warn('Public locations: farm_plots skipped', plotErr.message);
    }

    const providersRes = await pool.query(`
      SELECT id, full_name, services_offered, gps_lat, gps_lng
      FROM providers
      WHERE gps_lat IS NOT NULL AND gps_lng IS NOT NULL
      ORDER BY created_at DESC
    `);
    for (const p of providersRes.rows) {
      if (!isValidGps(p.gps_lat, p.gps_lng)) continue;
      locations.push({
        type: 'provider',
        id: `provider-${p.id}`,
        entity_id: p.id,
        full_name: p.full_name,
        services_offered: p.services_offered || '',
        gps_lat: parseFloat(p.gps_lat),
        gps_lng: parseFloat(p.gps_lng),
      });
    }

    const farmerCount = locations.filter((l) => l.type === 'farmer' || l.type === 'plot').length;
    const providerCount = locations.filter((l) => l.type === 'provider').length;

    res.json({
      locations,
      counts: {
        farmers: locations.filter((l) => l.type === 'farmer').length,
        plots: locations.filter((l) => l.type === 'plot').length,
        providers: providerCount,
        total: locations.length,
        farmerPins: farmerCount,
      },
    });
  } catch (err) {
    console.error('Public locations error:', err);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

module.exports = router;
