/**
 * Reputation calculator service
 * Calculates provider reputation scores based on multiple factors
 */

const { pool } = require('../config/db');

/**
 * Calculate provider reputation score (0-100)
 * Formula:
 * - Average rating: 40% (normalized 0-5 to 0-100)
 * - Completion rate: 30%
 * - Low cancellation rate: 20%
 * - Low dispute rate: 10%
 */
async function calculateProviderReputation(providerId) {
  try {
    // Get rating metrics
    const ratingsRes = await pool.query(
      `SELECT AVG(CAST(rating AS FLOAT)) as avg_rating, COUNT(*) as rating_count
       FROM farmer_ratings WHERE provider_id = $1`,
      [providerId]
    );

    // Get completion metrics
    const bookingsRes = await pool.query(
      `SELECT 
         COUNT(*) as total_bookings,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
       FROM bookings WHERE provider_id = $1 AND status IN ('completed', 'cancelled')`,
      [providerId]
    );

    // Get dispute metrics
    const disputesRes = await pool.query(
      `SELECT COUNT(*) as total_disputes
       FROM booking_disputes bd
       JOIN bookings b ON bd.booking_id = b.id
       WHERE b.provider_id = $1 AND bd.status = 'resolved'`,
      [providerId]
    );

    const avgRating = ratingsRes.rows[0]?.avg_rating || 0;
    const ratingCount = ratingsRes.rows[0]?.rating_count || 0;

    const totalBookings = parseInt(bookingsRes.rows[0]?.total_bookings || 0);
    const completedBookings = parseInt(bookingsRes.rows[0]?.completed || 0);
    const cancelledBookings = parseInt(bookingsRes.rows[0]?.cancelled || 0);

    const totalDisputes = parseInt(disputesRes.rows[0]?.total_disputes || 0);

    // Calculate score components
    const ratingScore = (avgRating / 5) * 100 * 0.4; // Normalize 5-star to 100, apply 40% weight
    const completionRate = totalBookings > 0 ? (completedBookings / totalBookings) * 100 * 0.3 : 0; // 30% weight
    const cancellationScore = totalBookings > 0 ? Math.max(0, 1 - cancelledBookings / totalBookings) * 100 * 0.2 : 20; // 20% weight
    const disputeScore = Math.max(0, 10 - totalDisputes * 1.5); // 10% weight, lose 1.5 points per dispute

    const totalScore = ratingScore + completionRate + cancellationScore + disputeScore;

    return {
      providerId,
      score: Math.min(100, Math.max(0, totalScore)),
      avgRating: Math.round(avgRating * 10) / 10,
      ratingCount,
      completionRate: totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0,
      totalBookings,
      completedBookings,
      cancelledBookings,
      cancellationRate: totalBookings > 0 ? Math.round((cancelledBookings / totalBookings) * 100) : 0,
      totalDisputes,
      breakdown: {
        ratingScore: Math.round(ratingScore * 10) / 10,
        completionScore: Math.round(completionRate * 10) / 10,
        cancellationScore: Math.round(cancellationScore * 10) / 10,
        disputeScore: Math.round(disputeScore * 10) / 10,
      },
    };
  } catch (err) {
    console.error('[ReputationCalculator] Error calculating reputation:', err.message);
    throw err;
  }
}

/**
 * Rank providers by reputation (used by recommendation engine)
 */
async function rankProvidersByReputation(providerIds) {
  const ranked = await Promise.all(providerIds.map((id) => calculateProviderReputation(id)));
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Get top N providers by reputation
 */
async function getTopProviders(limit = 10) {
  try {
    const providersRes = await pool.query(
      `SELECT id FROM providers ORDER BY id LIMIT $1`,
      [limit * 2] // Get more to compensate for any filtering
    );

    const ranked = await rankProvidersByReputation(providersRes.rows.map((r) => r.id));
    return ranked.slice(0, limit);
  } catch (err) {
    console.error('[ReputationCalculator] Error getting top providers:', err.message);
    throw err;
  }
}

module.exports = {
  calculateProviderReputation,
  rankProvidersByReputation,
  getTopProviders,
};
