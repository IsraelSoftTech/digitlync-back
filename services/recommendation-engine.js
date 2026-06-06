/**
 * Provider recommendation engine
 * Intelligently matches farmers with providers based on:
 * - Service type (must match)
 * - Location proximity (closer = better)
 * - Availability (±5 days from requested date)
 * - Provider rating (higher = better)
 * - Capacity (can handle farm size)
 */

const { pool } = require('../config/db');
const { haversineDistanceKm } = require('../utils/geo');

const AVAILABILITY_WINDOW_DAYS = 5;

/**
 * Calculate provider reputation/quality score (0-100)
 * Factors:
 * - Average rating: 40%
 * - Completion rate: 30%
 * - Low cancellation rate: 20%
 * - Low dispute rate: 10%
 */
async function calculateReputationScore(providerId) {
  // Get provider metrics
  const ratingsRes = await pool.query(
    `SELECT AVG(CAST(rating AS FLOAT)) as avg_rating, COUNT(*) as rating_count
     FROM farmer_ratings WHERE provider_id = $1`,
    [providerId]
  );

  const bookingsRes = await pool.query(
    `SELECT 
       COUNT(*) as total_bookings,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_bookings,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_bookings
     FROM bookings WHERE provider_id = $1 AND status IN ('completed', 'cancelled')`,
    [providerId]
  );

  const disputesRes = await pool.query(
    `SELECT COUNT(*) as dispute_count FROM booking_disputes 
     WHERE booking_id IN (SELECT id FROM bookings WHERE provider_id = $1)`,
    [providerId]
  );

  const avgRating = ratingsRes.rows[0]?.avg_rating || 0;
  const ratingCount = ratingsRes.rows[0]?.rating_count || 0;
  const totalBookings = parseInt(bookingsRes.rows[0]?.total_bookings || 0);
  const completedBookings = parseInt(bookingsRes.rows[0]?.completed_bookings || 0);
  const cancelledBookings = parseInt(bookingsRes.rows[0]?.cancelled_bookings || 0);
  const disputeCount = parseInt(disputesRes.rows[0]?.dispute_count || 0);

  // Calculate components
  const ratingScore = (avgRating / 5) * 100 * 0.4; // 40% weight, normalize to 5-star scale
  const completionRate = totalBookings > 0 ? (completedBookings / totalBookings) * 100 * 0.3 : 0; // 30% weight
  const cancellationPenalty = totalBookings > 0 ? Math.max(0, (1 - cancelledBookings / totalBookings)) * 100 * 0.2 : 20; // 20% weight
  const disputePenalty = Math.max(0, 10 - disputeCount * 2); // 10% weight, lose 2 points per dispute

  const totalScore = ratingScore + completionRate + cancellationPenalty + disputePenalty;

  return {
    score: Math.min(100, Math.max(0, totalScore)),
    avgRating: Math.round(avgRating * 10) / 10,
    completionRate: Math.round(totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0),
    ratingCount,
    totalBookings,
  };
}

/**
 * Check if provider is available on/near requested date
 * Returns availability span (from_date, to_date) if available
 */
async function checkAvailability(providerId, requestedDate) {
  const reqDate = new Date(requestedDate);
  const windowStart = new Date(reqDate);
  windowStart.setDate(windowStart.getDate() - AVAILABILITY_WINDOW_DAYS);
  const windowEnd = new Date(reqDate);
  windowEnd.setDate(windowEnd.getDate() + AVAILABILITY_WINDOW_DAYS);

  const res = await pool.query(
    `SELECT 
       MIN(available_date) as first_available,
       MAX(available_date) as last_available,
       COUNT(DISTINCT available_date) as available_days
     FROM provider_availability_slots
     WHERE provider_id = $1 
       AND available_date BETWEEN $2 AND $3
       AND is_booked = FALSE`,
    [providerId, windowStart.toISOString().split('T')[0], windowEnd.toISOString().split('T')[0]]
  );

  return res.rows[0];
}

/**
 * Get available time slots for provider on a specific date
 */
async function getAvailableSlots(providerId, date) {
  const res = await pool.query(
    `SELECT start_time, end_time FROM provider_availability_slots
     WHERE provider_id = $1 
       AND available_date = $2
       AND is_booked = FALSE
     ORDER BY start_time`,
    [providerId, date]
  );
  return res.rows;
}

/**
 * Get recommended providers for a farmer service request
 * @param {number} farmerId - Farmer requesting service
 * @param {string} serviceType - Service type requested
 * @param {string} requestedDate - Preferred service date
 * @param {number} farmSizeHa - Farm size
 * @param {number} budgetMax - Max budget (optional filter)
 * @returns {Array} Ranked providers with all details
 */
async function getRecommendedProviders(farmerId, serviceType, requestedDate, farmSizeHa, budgetMax = null) {
  try {
    // Get farmer details (for location)
    const farmerRes = await pool.query(
      `SELECT gps_lat, gps_lng FROM farmers WHERE id = $1`,
      [farmerId]
    );

    if (farmerRes.rows.length === 0) {
      throw new Error('Farmer not found');
    }

    const farmer = farmerRes.rows[0];
    if (!farmer.gps_lat || !farmer.gps_lng) {
      throw new Error('Farmer location not set');
    }

    // Get all providers offering this service
    const providersRes = await pool.query(
      `SELECT p.*, 
              AVG(CAST(fr.rating AS FLOAT)) as avg_rating,
              COUNT(DISTINCT fr.id) as rating_count,
              (SELECT COUNT(*) FROM bookings WHERE provider_id = p.id AND status = 'completed') as completed_jobs
       FROM providers p
       LEFT JOIN farmer_ratings fr ON p.id = fr.provider_id
       WHERE p.services_offered ILIKE $1
       GROUP BY p.id
       ORDER BY avg_rating DESC NULLS LAST`,
      [`%${serviceType}%`]
    );

    if (providersRes.rows.length === 0) {
      return []; // No providers for this service type
    }

    // Score and rank each provider
    const scored = await Promise.all(
      providersRes.rows.map(async (provider) => {
        // Calculate distance
        const distance = haversineDistanceKm(
          farmer.gps_lat,
          farmer.gps_lng,
          provider.gps_lat,
          provider.gps_lng
        );

        // Check availability
        const availability = await checkAvailability(provider.id, requestedDate);

        // Calculate reputation
        const reputation = await calculateReputationScore(provider.id);

        // Calculate pricing
        const basePricePerHa = provider.base_price_per_ha || 0;
        const providerAmount = Math.round(basePricePerHa * farmSizeHa * 100) / 100;
        const platformFee = Math.round(providerAmount * 0.1 * 100) / 100;
        const farmerPayable = Math.round((providerAmount + platformFee) * 100) / 100;

        // Score provider (lower distance = better, higher rating = better, available = better)
        let rankingScore = 0;

        // Distance scoring (max 30 points): closer is better, max 20km distance considered
        const distanceScore = Math.max(0, 30 - (distance / 20) * 30);
        rankingScore += distanceScore;

        // Availability scoring (25 points if available in window)
        const hasAvailability = availability && availability.available_days > 0;
        rankingScore += hasAvailability ? 25 : 0;

        // Rating scoring (max 25 points): avg rating / 5 * 25
        rankingScore += ((provider.avg_rating || 0) / 5) * 25;

        // Reputation scoring (max 20 points): use calculated reputation
        rankingScore += (reputation.score / 100) * 20;

        // Budget filter (if provided)
        if (budgetMax && farmerPayable > budgetMax) {
          rankingScore = 0; // Filter out
        }

        return {
          providerId: provider.id,
          name: provider.full_name,
          phone: provider.phone,
          servicesOffered: provider.services_offered,
          distanceKm: Math.round(distance * 10) / 10,
          distanceDisplay: distance < 1 ? `${Math.round(distance * 1000)}m` : `${Math.round(distance * 10) / 10}km`,
          gpsLat: provider.gps_lat,
          gpsLng: provider.gps_lng,
          avgRating: Math.round(provider.avg_rating * 10) / 10 || 0,
          ratingCount: provider.rating_count || 0,
          reputation,
          availabilityPeriod: hasAvailability
            ? {
                firstAvailable: availability.first_available,
                lastAvailable: availability.last_available,
                availableDays: availability.available_days,
              }
            : null,
          basePrice: basePricePerHa,
          providerAmount,
          platformFee,
          farmerPayable,
          workCapacity: provider.work_capacity_ha_per_hour,
          serviceRadius: provider.service_radius_km,
          rankingScore,
          canHandle: !provider.work_capacity_ha_per_hour || provider.work_capacity_ha_per_hour >= farmSizeHa,
        };
      })
    );

    // Filter providers that can handle the farm size and have valid ranking
    const filtered = scored
      .filter((p) => p.canHandle && p.rankingScore > 0)
      .sort((a, b) => b.rankingScore - a.rankingScore);

    return filtered;
  } catch (err) {
    console.error('[RecommendationEngine] Error getting recommendations:', err.message);
    throw err;
  }
}

/**
 * Get available time slots for selected provider on specific date
 */
async function getProviderAvailableSlots(providerId, date) {
  try {
    const slots = await getAvailableSlots(providerId, date);
    return slots;
  } catch (err) {
    console.error('[RecommendationEngine] Error getting slots:', err.message);
    throw err;
  }
}

module.exports = {
  getRecommendedProviders,
  getProviderAvailableSlots,
  calculateReputationScore,
  checkAvailability,
};
