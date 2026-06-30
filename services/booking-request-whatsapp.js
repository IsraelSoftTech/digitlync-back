/**
 * WhatsApp farmer service request — farmer selects provider by service type.
 * All providers offering the requested service are listed with key info;
 * only the farmer's chosen provider receives the booking request.
 */
const { pool } = require('../config/db');
const { getProvidersByServiceType } = require('./recommendation-engine');
const {
  createAwaitingProviderBooking,
  notifyProviderBookingRequest,
} = require('./matching-flow');
const { sendBrandedText, sendBotReply } = require('./whatsapp-sender');
const { buildOptionListReply } = require('./whatsapp-interactive');
const { logAudit } = require('./audit-log');

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

function buildFarmerSelectionCompleteMessage(completedBookings, noMatchServices = []) {
  let msg = '✅ *Request submitted*\n\n';
  if (completedBookings.length > 0) {
    msg += 'Your provider choices:\n\n';
    completedBookings.forEach((m, i) => {
      msg += `${i + 1}. *${m.serviceType}*\n`;
      msg += `   Provider: ${m.providerName}\n`;
      msg += `   Booking #${m.bookingId}\n`;
      msg += `   Est. total: ${m.farmerPayable.toLocaleString()} FCFA\n\n`;
    });
    msg +=
      'Each provider has been notified and must accept before you pay to escrow.\n' +
      'You will receive a payment prompt after each provider accepts.\n\n';
  }
  if (noMatchServices.length > 0) {
    msg += '⚠️ *No providers found for:*\n';
    noMatchServices.forEach((s) => {
      msg += `• ${s} — saved for admin assignment\n`;
    });
    msg += '\n';
  }
  msg += 'Reply *5* (My Requests) to track status. Reply *MENU* for options.';
  return msg;
}

function buildProviderListMessage(serviceType, providers, serviceIndex, serviceCount) {
  const lines = providers.slice(0, 10).map((p, i) => {
    const rating = p.avgRating ? `★${p.avgRating}` : 'No rating yet';
    const dist = p.distanceDisplay || 'Distance N/A';
    const avail = p.hasAvailability ? 'Available' : 'Check schedule';
    return (
      `${i + 1}. *${p.name}*\n` +
      `   Price: ${p.farmerPayable.toLocaleString()} FCFA · ${rating} · ${dist}\n` +
      `   ${avail}`
    );
  });
  return (
    `*${serviceType}* — choose your provider (${serviceIndex + 1}/${serviceCount}):\n\n` +
    lines.join('\n\n') +
    '\n\nSelect a provider from the list below.'
  );
}

async function presentProviderSelection(waPhone, farmer, lat, lng, sessionData, updateSession) {
  const requestPending = sessionData.request_pending;
  const serviceTypes = sessionData.service_types || serviceTypesFromRequest(requestPending);
  const serviceIndex = sessionData.service_index || 0;
  const serviceType = serviceTypes[serviceIndex];
  const allTypes = serviceTypesFromRequest(requestPending);
  const budget = perServiceBudget(requestPending, allTypes.length);

  const providers = await getProvidersByServiceType(
    lat,
    lng,
    serviceType,
    requestPending.scheduled_date,
    requestPending.farm_size_ha,
    sessionData.rejected_provider_ids || []
  );

  if (!providers.length) {
    await createPendingAdminBooking(farmer.id, requestPending, serviceType);
    await logAudit({
      adminId: null,
      adminUsername: 'system',
      actionType: 'matching',
      action: `No providers for ${serviceType} (farmer #${farmer.id}) — admin assignment`,
      entityType: 'booking',
      entityId: null,
    });
    const noMatch = [...(sessionData.no_match_services || []), serviceType];
    const nextIndex = serviceIndex + 1;
    if (nextIndex < serviceTypes.length) {
      const nextData = {
        ...sessionData,
        service_index: nextIndex,
        no_match_services: noMatch,
        provider_candidates: null,
      };
      await updateSession(waPhone, { step: 'request_choose_provider', data: nextData });
      return presentProviderSelection(waPhone, farmer, lat, lng, nextData, updateSession);
    }
    await updateSession(waPhone, { step: 'main_menu', data: {} });
    const msg = buildFarmerSelectionCompleteMessage(sessionData.completed_bookings || [], noMatch);
    await sendBrandedText(waPhone, msg);
    return { ok: true, completed: sessionData.completed_bookings || [], noMatchServices: noMatch };
  }

  const nextData = {
    ...sessionData,
    service_types: serviceTypes,
    service_index: serviceIndex,
    current_service_type: serviceType,
    provider_candidates: providers,
    request_pending: {
      ...requestPending,
      budget_min_fcfa: budget.min,
      budget_max_fcfa: budget.max,
    },
  };
  await updateSession(waPhone, { step: 'request_choose_provider', data: nextData });

  const rows = providers.slice(0, 10).map((p) => ({
    id: `pick_prov_${p.providerId}`,
    title: String(p.name).slice(0, 24),
    description: `${p.farmerPayable.toLocaleString()} FCFA · ★${p.avgRating || '—'} · ${p.distanceDisplay || 'nearby'}`.slice(0, 72),
  }));

  const list = buildOptionListReply(
    buildProviderListMessage(serviceType, providers, serviceIndex, serviceTypes.length),
    rows
  );
  await sendBotReply(waPhone, list);
  return { ok: true, awaiting_selection: true, serviceType };
}

async function beginProviderSelection(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession) {
  const serviceTypes = serviceTypesFromRequest(requestPending);
  if (!serviceTypes.length) {
    return { ok: false, error: 'no_services' };
  }

  const sessionData = {
    request_pending: requestPending,
    farm_gps_lat: lat,
    farm_gps_lng: lng,
    service_index: 0,
    service_types: serviceTypes,
    completed_bookings: [],
    no_match_services: [],
    rejected_provider_ids: sessionExtras.rejected_provider_ids || [],
  };

  return presentProviderSelection(waPhone, farmer, lat, lng, sessionData, updateSession);
}

async function farmerSelectProvider(waPhone, farmer, sessionData, providerId, updateSession) {
  const requestPending = sessionData.request_pending;
  const serviceType = sessionData.current_service_type;
  const lat = sessionData.farm_gps_lat;
  const lng = sessionData.farm_gps_lng;
  const candidates = sessionData.provider_candidates || [];
  const rec = candidates.find((p) => p.providerId === providerId);
  if (!rec || !serviceType) {
    return { ok: false, error: 'invalid_provider' };
  }

  const allTypes = serviceTypesFromRequest(requestPending);
  const budget = perServiceBudget(requestPending, allTypes.length);
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
      budget_min_fcfa: budget.min,
      budget_max_fcfa: budget.max,
    },
    economics,
    slot ? slot.id : null,
    rec.providerServiceId
  );

  const provider = { full_name: rec.name, phone: rec.phone };
  const farmerUser = { full_name: farmer.name, phone: farmer.phone || normalizePhone(waPhone) };
  await notifyProviderBookingRequest(booking, farmerUser, provider);

  await logAudit({
    adminId: null,
    adminUsername: 'system',
    actionType: 'matching',
    action: `Farmer chose ${rec.name} for ${serviceType} (booking #${booking.id}, ${rec.farmerPayable.toLocaleString()} FCFA)`,
    entityType: 'booking',
    entityId: booking.id,
  });

  const completed = [
    ...(sessionData.completed_bookings || []),
    {
      serviceType,
      providerId: rec.providerId,
      providerName: rec.name,
      bookingId: booking.id,
      farmerPayable: rec.farmerPayable,
      scheduledDate,
      scheduledTime,
    },
  ];

  const serviceTypes = sessionData.service_types || serviceTypesFromRequest(requestPending);
  const nextIndex = (sessionData.service_index || 0) + 1;

  if (nextIndex < serviceTypes.length) {
    const nextData = {
      ...sessionData,
      service_index: nextIndex,
      completed_bookings: completed,
      provider_candidates: null,
      current_service_type: null,
    };
    await updateSession(waPhone, { step: 'request_choose_provider', data: nextData });
    await sendBrandedText(
      waPhone,
      `✅ *${serviceType}* — booking #${booking.id} sent to *${rec.name}*.\n\nNow choose a provider for your next service.`
    );
    return presentProviderSelection(waPhone, farmer, lat, lng, nextData, updateSession);
  }

  await updateSession(waPhone, { step: 'main_menu', data: {} });
  const msg = buildFarmerSelectionCompleteMessage(completed, sessionData.no_match_services || []);
  await sendBrandedText(waPhone, msg);
  return { ok: true, completed };
}

async function autoMatchServiceRequest(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession) {
  return beginProviderSelection(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession);
}

async function reofferAfterProviderReject(farmerPhone, farmer, requestPending, lat, lng, rejectedIds, updateSession) {
  const sessionData = {
    request_pending: requestPending,
    farm_gps_lat: lat,
    farm_gps_lng: lng,
    service_index: 0,
    service_types: [requestPending.service_type],
    completed_bookings: [],
    no_match_services: [],
    rejected_provider_ids: rejectedIds,
  };
  await sendBrandedText(
    farmerPhone,
    `⚠️ Your provider declined *${requestPending.service_type}*.\n\nPlease choose another provider from the list below.`
  );
  await updateSession(farmerPhone, { step: 'request_choose_provider', data: sessionData });
  return presentProviderSelection(
    farmerPhone,
    { ...farmer, phone: normalizePhone(farmerPhone) },
    lat,
    lng,
    sessionData,
    updateSession
  );
}

module.exports = {
  beginProviderSelection,
  farmerSelectProvider,
  presentProviderSelection,
  autoMatchServiceRequest,
  reofferAfterProviderReject,
  getSlotsNearDate,
  pickBestSlot,
  buildFarmerSelectionCompleteMessage,
  serviceTypesFromRequest,
};
