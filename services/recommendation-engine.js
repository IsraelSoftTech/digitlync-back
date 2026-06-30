/**
 * Provider recommendation engine — operational spec §6.
 * Service match, ±5 day availability, proximity, reputation, budget filter.
 */
const { pool } = require('../config/db');
const { haversineDistanceKm } = require('../utils/geo');
const { calculateServiceEconomics, calculateBookingEconomics } = require('./operational-core');

const AVAILABILITY_WINDOW_DAYS = 5;
const MAX_RECOMMENDATIONS = 10;
/** Default service radius when provider has none set (km). */
const DEFAULT_SERVICE_RADIUS_KM = 75;

function farmerHasGps(farmerLat, farmerLng) {
  const la = farmerLat != null ? parseFloat(farmerLat) : NaN;
  const lo = farmerLng != null ? parseFloat(farmerLng) : NaN;
  return !Number.isNaN(la) && !Number.isNaN(lo) && !(la === 0 && lo === 0);
}

function providerHasGps(prLat, prLng) {
  const la = prLat != null ? parseFloat(prLat) : NaN;
  const lo = prLng != null ? parseFloat(prLng) : NaN;
  return !Number.isNaN(la) && !Number.isNaN(lo) && !(la === 0 && lo === 0);
}

async function calculateReputationScore(providerId) {
  const ratingsRes = await pool.query(
    `SELECT AVG(CAST(rating AS FLOAT)) as avg_rating, COUNT(*) as rating_count
     FROM farmer_ratings WHERE provider_id = $1`,
    [providerId]
  );

  const bookingsRes = await pool.query(
    `SELECT COUNT(*) as total_bookings,
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
  const totalBookings = parseInt(bookingsRes.rows[0]?.total_bookings || 0, 10);
  const completedBookings = parseInt(bookingsRes.rows[0]?.completed_bookings || 0, 10);
  const cancelledBookings = parseInt(bookingsRes.rows[0]?.cancelled_bookings || 0, 10);
  const disputeCount = parseInt(disputesRes.rows[0]?.dispute_count || 0, 10);

  const ratingScore = (avgRating / 5) * 100 * 0.4;
  const completionRate = totalBookings > 0 ? (completedBookings / totalBookings) * 100 * 0.3 : 0;
  const cancellationPenalty =
    totalBookings > 0 ? Math.max(0, (1 - cancelledBookings / totalBookings)) * 100 * 0.2 : 20;
  const disputePenalty = Math.max(0, 10 - disputeCount * 2);
  const totalScore = ratingScore + completionRate + cancellationPenalty + disputePenalty;

  return {
    score: Math.min(100, Math.max(0, totalScore)),
    avgRating: Math.round(avgRating * 10) / 10,
    completionRate: Math.round(totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0),
    ratingCount,
    totalBookings,
  };
}

async function checkAvailability(providerId, requestedDate) {
  const reqDate = new Date(requestedDate);
  const windowStart = new Date(reqDate);
  windowStart.setDate(windowStart.getDate() - AVAILABILITY_WINDOW_DAYS);
  const windowEnd = new Date(reqDate);
  windowEnd.setDate(windowEnd.getDate() + AVAILABILITY_WINDOW_DAYS);

  const res = await pool.query(
    `SELECT MIN(available_date) as first_available,
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

async function getAvailableSlots(providerId, date) {
  const res = await pool.query(
    `SELECT id, start_time, end_time FROM provider_availability_slots
     WHERE provider_id = $1 AND available_date = $2 AND is_booked = FALSE
     ORDER BY start_time`,
    [providerId, date]
  );
  return res.rows;
}

function economicsForProvider(provider, serviceRow, requestedQty) {
  const qty = Number(requestedQty) || 0;
  if (serviceRow) {
    const minQty = serviceRow.min_service_qty != null ? parseFloat(serviceRow.min_service_qty) : 1;
    const basePrice =
      serviceRow.base_price_fcfa != null
        ? parseFloat(serviceRow.base_price_fcfa)
        : serviceRow.base_price_per_ha != null
          ? parseFloat(serviceRow.base_price_per_ha) * (minQty || 1)
          : parseFloat(provider.base_price_per_ha || 0) * (minQty || 1);
    return {
      ...calculateServiceEconomics({
        minServiceQty: minQty || 1,
        basePriceFcfa: basePrice,
        requestedQty: qty,
        baseDurationDays: serviceRow.base_duration_days,
        baseDurationHours: serviceRow.base_duration_hours,
      }),
      providerServiceId: serviceRow.id,
    };
  }
  const legacy = calculateBookingEconomics({
    providerBasePricePerHa: provider.base_price_per_ha,
    farmSizeHa: qty,
  });
  return { ...legacy, providerServiceId: null };
}

function formatDistance(km) {
  if (km == null || Number.isNaN(km)) return '—';
  if (km < 1) return `${Math.round(km * 1000)}m away`;
  return `${Math.round(km * 10) / 10}km away`;
}

/**
 * Rank providers at a GPS location (WhatsApp + admin).
 */
async function getRecommendedProvidersAtLocation(
  farmerLat,
  farmerLng,
  serviceType,
  requestedDate,
  requestedQty,
  budgetMin = null,
  budgetMax = null,
  excludeProviderIds = []
) {
  const svc = String(serviceType || '').trim();
  const qty = Number(requestedQty) || 0;
  const excluded = new Set((excludeProviderIds || []).map((id) => parseInt(id, 10)));

  const providersRes = await pool.query(
    `SELECT DISTINCT ON (p.id) p.*,
            ps.id AS ps_id, ps.service_name AS ps_service_name, ps.min_service_qty,
            ps.base_price_fcfa, ps.base_price_per_ha AS ps_base_price_per_ha,
            ps.base_duration_days, ps.base_duration_hours,
            (SELECT ROUND(AVG(fr.rating)::numeric, 1) FROM farmer_ratings fr WHERE fr.provider_id = p.id) AS avg_rating,
            (SELECT COUNT(DISTINCT fr.id) FROM farmer_ratings fr WHERE fr.provider_id = p.id) AS rating_count
     FROM providers p
     LEFT JOIN provider_services ps ON ps.provider_id = p.id AND ps.service_name ILIKE $1
     WHERE (ps.id IS NOT NULL OR p.services_offered ILIKE $1)
     ORDER BY p.id, ps.id NULLS LAST`,
    [`%${svc}%`]
  );

  const scored = await Promise.all(
    providersRes.rows.map(async (row) => {
      if (excluded.has(row.id)) return null;

      const prLat = parseFloat(row.gps_lat);
      const prLng = parseFloat(row.gps_lng);
      let distance = null;
      const locationRequired = farmerHasGps(farmerLat, farmerLng);
      if (locationRequired) {
        if (!providerHasGps(prLat, prLng)) return null;
        distance = haversineDistanceKm(farmerLat, farmerLng, prLat, prLng);
        const radius = parseFloat(row.service_radius_km) || DEFAULT_SERVICE_RADIUS_KM;
        if (distance > radius) return null;
      } else if (providerHasGps(prLat, prLng)) {
        distance = haversineDistanceKm(farmerLat, farmerLng, prLat, prLng);
      }

      const serviceRow = row.ps_id
        ? {
            id: row.ps_id,
            service_name: row.ps_service_name,
            min_service_qty: row.min_service_qty,
            base_price_fcfa: row.base_price_fcfa,
            base_price_per_ha: row.ps_base_price_per_ha,
            base_duration_days: row.base_duration_days,
            base_duration_hours: row.base_duration_hours,
          }
        : null;

      const econ = economicsForProvider(row, serviceRow, qty);
      const farmerPayable = econ.farmerPayableAmount;
      const budgetMinN = budgetMin != null ? Number(budgetMin) : null;
      const budgetMaxN = budgetMax != null ? Number(budgetMax) : null;
      if (budgetMaxN != null && !Number.isNaN(budgetMaxN) && farmerPayable > budgetMaxN) return null;
      if (budgetMinN != null && !Number.isNaN(budgetMinN) && farmerPayable < budgetMinN) return null;

      const availability = await checkAvailability(row.id, requestedDate);
      const hasAvailability = availability && parseInt(availability.available_days || 0, 10) > 0;
      const reputation = await calculateReputationScore(row.id);

      let rankingScore = 0;
      const distanceScore = distance != null ? Math.max(0, 30 - (distance / 20) * 30) : 15;
      rankingScore += distanceScore;
      rankingScore += hasAvailability ? 25 : 0;
      rankingScore += ((parseFloat(row.avg_rating) || 0) / 5) * 25;
      rankingScore += (reputation.score / 100) * 20;

      return {
        providerId: row.id,
        name: row.full_name,
        phone: row.phone,
        servicesOffered: row.services_offered,
        distanceKm: distance != null ? Math.round(distance * 10) / 10 : null,
        distanceDisplay: formatDistance(distance),
        avgRating: Math.round((parseFloat(row.avg_rating) || 0) * 10) / 10,
        ratingCount: row.rating_count || 0,
        reputation,
        availabilityPeriod: hasAvailability
          ? {
              firstAvailable: availability.first_available,
              lastAvailable: availability.last_available,
              availableDays: availability.available_days,
            }
          : null,
        providerAmount: econ.providerBaseAmount,
        platformFee: econ.platformFeeAmount,
        farmerPayable,
        providerServiceId: econ.providerServiceId,
        estimatedDurationDays: econ.estimatedDurationDays,
        estimatedDurationHours: econ.estimatedDurationHours,
        rankingScore,
        hasAvailability,
      };
    })
  );

  return scored
    .filter(Boolean)
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .slice(0, MAX_RECOMMENDATIONS);
}

/**
 * List all providers offering a service type (farmer self-selection).
 * Matching is by service type only — distance and rating are shown as info, not filters.
 */
async function getProvidersByServiceType(
  farmerLat,
  farmerLng,
  serviceType,
  requestedDate,
  requestedQty,
  excludeProviderIds = []
) {
  const svc = String(serviceType || '').trim();
  const qty = Number(requestedQty) || 0;
  const excluded = new Set((excludeProviderIds || []).map((id) => parseInt(id, 10)));

  const providersRes = await pool.query(
    `SELECT DISTINCT ON (p.id) p.*,
            ps.id AS ps_id, ps.service_name AS ps_service_name, ps.min_service_qty,
            ps.base_price_fcfa, ps.base_price_per_ha AS ps_base_price_per_ha,
            ps.base_duration_days, ps.base_duration_hours,
            (SELECT ROUND(AVG(fr.rating)::numeric, 1) FROM farmer_ratings fr WHERE fr.provider_id = p.id) AS avg_rating,
            (SELECT COUNT(DISTINCT fr.id) FROM farmer_ratings fr WHERE fr.provider_id = p.id) AS rating_count
     FROM providers p
     LEFT JOIN provider_services ps ON ps.provider_id = p.id AND ps.service_name ILIKE $1
     WHERE (ps.id IS NOT NULL OR p.services_offered ILIKE $1)
     ORDER BY p.id, ps.id NULLS LAST`,
    [`%${svc}%`]
  );

  const scored = await Promise.all(
    providersRes.rows.map(async (row) => {
      if (excluded.has(row.id)) return null;

      const prLat = parseFloat(row.gps_lat);
      const prLng = parseFloat(row.gps_lng);
      let distance = null;
      if (farmerHasGps(farmerLat, farmerLng) && providerHasGps(prLat, prLng)) {
        distance = haversineDistanceKm(farmerLat, farmerLng, prLat, prLng);
      }

      const serviceRow = row.ps_id
        ? {
            id: row.ps_id,
            service_name: row.ps_service_name,
            min_service_qty: row.min_service_qty,
            base_price_fcfa: row.base_price_fcfa,
            base_price_per_ha: row.ps_base_price_per_ha,
            base_duration_days: row.base_duration_days,
            base_duration_hours: row.base_duration_hours,
          }
        : null;

      const econ = economicsForProvider(row, serviceRow, qty);
      const availability = requestedDate
        ? await checkAvailability(row.id, requestedDate)
        : null;
      const hasAvailability = availability && parseInt(availability.available_days || 0, 10) > 0;
      const reputation = await calculateReputationScore(row.id);

      let rankingScore = 0;
      const distanceScore = distance != null ? Math.max(0, 30 - (distance / 20) * 30) : 15;
      rankingScore += distanceScore;
      rankingScore += hasAvailability ? 25 : 0;
      rankingScore += ((parseFloat(row.avg_rating) || 0) / 5) * 25;
      rankingScore += (reputation.score / 100) * 20;

      return {
        providerId: row.id,
        name: row.full_name,
        phone: row.phone,
        servicesOffered: row.services_offered,
        serviceRadiusKm: parseFloat(row.service_radius_km) || DEFAULT_SERVICE_RADIUS_KM,
        distanceKm: distance != null ? Math.round(distance * 10) / 10 : null,
        distanceDisplay: formatDistance(distance),
        avgRating: Math.round((parseFloat(row.avg_rating) || 0) * 10) / 10,
        ratingCount: row.rating_count || 0,
        reputation,
        hasAvailability,
        providerAmount: econ.providerBaseAmount,
        platformFee: econ.platformFeeAmount,
        farmerPayable: econ.farmerPayableAmount,
        providerServiceId: econ.providerServiceId,
        estimatedDurationDays: econ.estimatedDurationDays,
        estimatedDurationHours: econ.estimatedDurationHours,
        rankingScore,
      };
    })
  );

  return scored
    .filter(Boolean)
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

async function getRecommendedProviders(
  farmerId,
  serviceType,
  requestedDate,
  farmSizeHa,
  budgetMax = null,
  budgetMin = null
) {
  const farmerRes = await pool.query(`SELECT gps_lat, gps_lng FROM farmers WHERE id = $1`, [farmerId]);
  if (farmerRes.rows.length === 0) throw new Error('Farmer not found');
  const farmer = farmerRes.rows[0];
  let lat = parseFloat(farmer.gps_lat);
  let lng = parseFloat(farmer.gps_lng);
  if (!farmerHasGps(lat, lng)) {
    const plotRes = await pool.query(
      `SELECT gps_lat, gps_lng FROM farm_plots
       WHERE farmer_id = $1 AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL
       ORDER BY id LIMIT 1`,
      [farmerId]
    );
    if (plotRes.rows.length > 0) {
      lat = parseFloat(plotRes.rows[0].gps_lat);
      lng = parseFloat(plotRes.rows[0].gps_lng);
    }
  }
  if (!farmerHasGps(lat, lng)) throw new Error('Farmer location not set');
  return getRecommendedProvidersAtLocation(
    lat,
    lng,
    serviceType,
    requestedDate,
    farmSizeHa,
    budgetMin,
    budgetMax
  );
}

async function getProviderAvailableSlots(providerId, date) {
  return getAvailableSlots(providerId, date);
}

module.exports = {
  getRecommendedProviders,
  getRecommendedProvidersAtLocation,
  getProvidersByServiceType,
  getProviderAvailableSlots,
  calculateReputationScore,
  checkAvailability,
  MAX_RECOMMENDATIONS,
};
