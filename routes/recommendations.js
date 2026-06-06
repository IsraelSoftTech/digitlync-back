const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { getRecommendedProviders, getProviderAvailableSlots } = require('../services/recommendation-engine');

/**
 * GET /api/recommendations
 * Get recommended providers for a farmer's service request
 * Query params:
 * - farmer_id: required
 * - service_type: required
 * - requested_date: required (YYYY-MM-DD)
 * - farm_size_ha: required
 * - budget_max: optional (max farmer budget)
 */
router.get('/', async (req, res) => {
  const { farmer_id, service_type, requested_date, farm_size_ha, budget_max } = req.query;

  if (!farmer_id || !service_type || !requested_date || !farm_size_ha) {
    return res.status(400).json({
      error: 'Missing required parameters: farmer_id, service_type, requested_date, farm_size_ha',
    });
  }

  try {
    const recommendations = await getRecommendedProviders(
      parseInt(farmer_id),
      service_type,
      requested_date,
      parseFloat(farm_size_ha),
      budget_max ? parseFloat(budget_max) : null
    );

    res.json({
      success: true,
      recommendedProviders: recommendations,
      count: recommendations.length,
      note: 'Providers ranked by distance, availability, rating, and reputation',
    });
  } catch (err) {
    console.error('Recommendations error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/recommendations/:provider_id/slots
 * Get available time slots for a selected provider on a specific date
 * Query params:
 * - date: required (YYYY-MM-DD)
 */
router.get('/:provider_id/slots', async (req, res) => {
  const { provider_id } = req.params;
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Missing required parameter: date (YYYY-MM-DD)' });
  }

  try {
    const slots = await getProviderAvailableSlots(parseInt(provider_id), date);

    res.json({
      success: true,
      providerId: parseInt(provider_id),
      date,
      availableSlots: slots,
      count: slots.length,
    });
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/recommendations/provider/:provider_id
 * Get provider details with distance and availability info
 * Query params:
 * - farmer_id: required (to calculate distance)
 */
router.get('/provider/:provider_id', async (req, res) => {
  const { provider_id } = req.params;
  const { farmer_id } = req.query;

  if (!farmer_id) {
    return res.status(400).json({ error: 'Missing required parameter: farmer_id' });
  }

  try {
    const providerRes = await pool.query('SELECT * FROM providers WHERE id = $1', [provider_id]);
    if (providerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const farmerRes = await pool.query('SELECT gps_lat, gps_lng FROM farmers WHERE id = $1', [farmer_id]);
    if (farmerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Farmer not found' });
    }

    const { haversineDistanceKm } = require('../utils/geo');
    const { calculateReputationScore } = require('../services/recommendation-engine');

    const provider = providerRes.rows[0];
    const farmer = farmerRes.rows[0];

    const distance = haversineDistanceKm(
      farmer.gps_lat,
      farmer.gps_lng,
      provider.gps_lat,
      provider.gps_lng
    );

    const reputation = await calculateReputationScore(provider.id);

    const ratingsRes = await pool.query(
      'SELECT AVG(CAST(rating AS FLOAT)) as avg_rating FROM farmer_ratings WHERE provider_id = $1',
      [provider.id]
    );

    res.json({
      success: true,
      provider: {
        ...provider,
        distance: Math.round(distance * 10) / 10,
        distanceDisplay: distance < 1 ? `${Math.round(distance * 1000)}m` : `${Math.round(distance * 10) / 10}km`,
        avgRating: Math.round((ratingsRes.rows[0]?.avg_rating || 0) * 10) / 10,
        reputation,
      },
    });
  } catch (err) {
    console.error('Get provider details error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
