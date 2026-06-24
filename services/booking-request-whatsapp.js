/**
 * WhatsApp farmer service request — automatic multi-service matching (operational §5–7).
 * Ranks providers by service offered, location, availability, and reputation;
 * creates one booking per service (preferring different providers) and notifies both parties.
 */
const { pool } = require('../config/db');
const { getRecommendedProvidersAtLocation } = require('./recommendation-engine');
const {
  createAwaitingProviderBooking,
  notifyProviderBookingRequest,
} = require('./matching-flow');
const { sendBrandedText } = require('./whatsapp-sender');

function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

function serviceTypesFromRequest(requestPending) {
  if (Array.isArray(requestPending.service_types) && requestPending.service_types.length > 0) {
    return requestPending.service_types;
  }
  if (requestPending.service_type) return [requestPending.service_type];
  return [];
}

function perServiceBudget(requestPending, serviceCount) {
  const n = Math.max(1, serviceCount || 1);
  return {
    min: requestPending.budget_min_fcfa != null ? requestPending.budget_min_fcfa / n : null,
    max: requestPending.budget_max_fcfa != null ? requestPending.budget_max_fcfa / n : null,
  };
}

async function createPendingAdminBooking(farmerId, requestPending, serviceType = null) {
  const svc = serviceType || requestPending.service_type;
  const ins = await pool.query(
    `INSERT INTO bookings (
       farmer_id, provider_id, service_type, status, farm_size_ha, scheduled_date, scheduled_time,
       budget_min_fcfa, budget_max_fcfa, requested_qty
     ) VALUES ($1, NULL, $2, 'pending', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      farmerId,
      svc,
      requestPending.farm_size_ha,
      requestPending.scheduled_date || null,
      requestPending.scheduled_time || null,
      requestPending.budget_min_fcfa || null,
      requestPending.budget_max_fcfa || null,
      requestPending.farm_size_ha,
    ]
  );
  return ins.rows[0].id;
}

async function getSlotsNearDate(providerId, preferredDate) {
  const base = new Date(String(preferredDate).slice(0, 10));
  const dates = [];
  for (let d = -5; d <= 5; d++) {
    const dt = new Date(base);
    dt.setDate(dt.getDate() + d);
    dates.push(dt.toISOString().slice(0, 10));
  }
  const res = await pool.query(
    `SELECT id, available_date, start_time, end_time FROM provider_availability_slots
     WHERE provider_id = $1 AND is_booked = FALSE AND available_date = ANY($2::date[])
     ORDER BY available_date, start_time LIMIT 20`,
    [providerId, dates]
  );
  return res.rows;
}

function slotTimeMinutes(t) {
  const s = String(t || '08:00').slice(0, 8);
  const parts = s.split(':').map((x) => parseInt(x, 10));
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/** Pick the open slot closest to the farmer's preferred date and time. */
async function pickBestSlot(providerId, scheduledDate, scheduledTime) {
  const slots = await getSlotsNearDate(providerId, scheduledDate);
  if (!slots.length) return null;
  const targetDate = String(scheduledDate).slice(0, 10);
  const targetMins = slotTimeMinutes(scheduledTime);
  let best = null;
  let bestScore = Infinity;
  for (const s of slots) {
    const dateStr = String(s.available_date).slice(0, 10);
    const dayDiff = Math.abs(new Date(dateStr) - new Date(targetDate)) / 86400000;
    const timeDiff = Math.abs(slotTimeMinutes(s.start_time) - targetMins);
    const score = dayDiff * 1000 + timeDiff;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

function buildFarmerAutoMatchMessage(matches, noMatchServices) {
  let msg = '✅ *Services matched automatically*\n\n';
  if (matches.length > 0) {
    msg += 'We found providers for your request:\n\n';
    matches.forEach((m, i) => {
      const dateStr = m.scheduledDate || 'TBD';
      const timeStr = m.scheduledTime ? String(m.scheduledTime).slice(0, 5) : '';
      msg += `${i + 1}. *${m.serviceType}*\n`;
      msg += `   Provider: ${m.providerName}\n`;
      msg += `   Booking #${m.bookingId} · ${dateStr}${timeStr ? ` ${timeStr}` : ''}\n`;
      msg += `   Est. total: ${m.farmerPayable.toLocaleString()} FCFA\n\n`;
    });
    msg +=
      'Each provider has been notified and must accept before you pay to escrow.\n' +
      'You will receive a payment prompt after each provider accepts.\n\n';
  }
  if (noMatchServices.length > 0) {
    msg += '⚠️ *No automatic match yet for:*\n';
    noMatchServices.forEach((s) => {
      msg += `• ${s} — saved for admin assignment\n`;
    });
    msg += '\n';
  }
  msg += 'Reply *5* (My Requests) to track status. Reply *MENU* for options.';
  return msg;
}

/**
 * Auto-match a single service to the best available provider (excluding already-used providers).
 */
async function autoMatchSingleService(farmer, lat, lng, serviceType, requestPending, excludeProviderIds = []) {
  const allTypes = serviceTypesFromRequest(requestPending);
  const budget = perServiceBudget(requestPending, allTypes.length);

  const recs = await getRecommendedProvidersAtLocation(
    lat,
    lng,
    serviceType,
    requestPending.scheduled_date,
    requestPending.farm_size_ha,
    budget.min,
    budget.max,
    excludeProviderIds
  );

  if (!recs.length) {
    return { ok: false, no_match: true, serviceType };
  }

  const sorted = [...recs].sort((a, b) => {
    if (a.hasAvailability && !b.hasAvailability) return -1;
    if (!a.hasAvailability && b.hasAvailability) return 1;
    return b.rankingScore - a.rankingScore;
  });

  const rec = sorted[0];
  const slot = await pickBestSlot(rec.providerId, requestPending.scheduled_date, requestPending.scheduled_time);
  const scheduledDate = slot ? String(slot.available_date).slice(0, 10) : requestPending.scheduled_date;
  const scheduledTime = slot ? String(slot.start_time).slice(0, 8) : requestPending.scheduled_time;
  const economics = {
    providerBaseAmount: rec.providerAmount,
    platformFeeAmount: rec.platformFee,
    farmerPayableAmount: rec.farmerPayable,
    estimatedDurationDays: rec.estimatedDurationDays,
    estimatedDurationHours: rec.estimatedDurationHours,
  };

  const booking = await createAwaitingProviderBooking(
    farmer.id,
    rec.providerId,
    {
      ...requestPending,
      service_type: serviceType,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      requested_qty: requestPending.farm_size_ha,
    },
    economics,
    slot ? slot.id : null,
    rec.providerServiceId
  );

  const provider = { full_name: rec.name, phone: rec.phone };
  const farmerUser = { full_name: farmer.name, phone: farmer.phone || null };
  await notifyProviderBookingRequest(booking, farmerUser, provider);

  return {
    ok: true,
    serviceType,
    providerId: rec.providerId,
    providerName: rec.name,
    bookingId: booking.id,
    farmerPayable: rec.farmerPayable,
    scheduledDate,
    scheduledTime,
    booking,
  };
}

/**
 * Auto-match all requested services — one provider per service when possible.
 * @param {object} updateSession - (waFrom, updates) => Promise
 */
async function autoMatchServiceRequest(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession) {
  const serviceTypes = serviceTypesFromRequest(requestPending);
  if (!serviceTypes.length) {
    return { ok: false, error: 'no_services' };
  }

  const usedProviderIds = [...(sessionExtras.rejected_provider_ids || [])];
  const matches = [];
  const noMatchServices = [];

  for (const serviceType of serviceTypes) {
    try {
      const result = await autoMatchSingleService(
        { ...farmer, phone: normalizePhone(waPhone) },
        lat,
        lng,
        serviceType,
        requestPending,
        usedProviderIds
      );
      if (result.ok) {
        matches.push(result);
        usedProviderIds.push(result.providerId);
      } else {
        await createPendingAdminBooking(farmer.id, requestPending, serviceType);
        noMatchServices.push(serviceType);
      }
    } catch (err) {
      console.error(`autoMatchServiceRequest (${serviceType}):`, err.message);
      await createPendingAdminBooking(farmer.id, requestPending, serviceType).catch(() => {});
      noMatchServices.push(serviceType);
    }
  }

  await updateSession(waPhone, { step: 'main_menu', data: {} });

  if (matches.length === 0) {
    await sendBrandedText(
      waPhone,
      '✅ *Request saved.* No providers match your services, budget, or location right now. Admin will assign providers soon.\n\nReply *MENU* for options.'
    );
    return { ok: true, no_match: true, matches: [], noMatchServices };
  }

  await sendBrandedText(waPhone, buildFarmerAutoMatchMessage(matches, noMatchServices));
  return { ok: true, matches, noMatchServices };
}

/** @deprecated alias — automatic matching replaces manual provider list selection */
async function beginProviderSelection(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession) {
  return autoMatchServiceRequest(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession);
}

async function reofferAfterProviderReject(farmerPhone, farmer, requestPending, lat, lng, rejectedIds, updateSession) {
  const serviceType = requestPending.service_type;
  const result = await autoMatchSingleService(
    { ...farmer, phone: normalizePhone(farmerPhone) },
    lat,
    lng,
    serviceType,
    requestPending,
    rejectedIds
  );

  if (!result.ok) {
    await createPendingAdminBooking(farmer.id, requestPending, serviceType);
    await sendBrandedText(
      farmerPhone,
      `⚠️ No other providers are available for *${serviceType}* right now. Admin will assign one soon.\n\nReply *MENU* for options.`
    );
    return { ok: true, no_match: true };
  }

  await sendBrandedText(
    farmerPhone,
    `✅ *New match for ${serviceType}*\n\n` +
      `Provider: *${result.providerName}*\n` +
      `Booking #${result.bookingId}\n` +
      `Date: ${result.scheduledDate || 'TBD'} ${result.scheduledTime ? String(result.scheduledTime).slice(0, 5) : ''}\n` +
      `Est. total: ${result.farmerPayable.toLocaleString()} FCFA\n\n` +
      'Waiting for the provider to accept. Reply *MENU* for options.'
  );
  return { ok: true, match: result };
}

module.exports = {
  autoMatchServiceRequest,
  autoMatchSingleService,
  beginProviderSelection,
  reofferAfterProviderReject,
  getSlotsNearDate,
  pickBestSlot,
  buildFarmerAutoMatchMessage,
};
