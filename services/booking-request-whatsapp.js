/**
 * WhatsApp farmer service request — provider list + slot selection (operational §5–7).
 * Meta interactive lists: max 10 rows per message.
 */
const { pool } = require('../config/db');
const {
  getRecommendedProvidersAtLocation,
} = require('./recommendation-engine');
const {
  createAwaitingProviderBooking,
  notifyProviderBookingRequest,
  resolveServiceRate,
} = require('./matching-flow');
const { buildOptionListReply, sendBotReply } = require('./whatsapp-interactive');
const { sendBrandedText } = require('./whatsapp-sender');

function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

async function createPendingAdminBooking(farmerId, requestPending) {
  const ins = await pool.query(
    `INSERT INTO bookings (
       farmer_id, provider_id, service_type, status, farm_size_ha, scheduled_date, scheduled_time,
       budget_min_fcfa, budget_max_fcfa, requested_qty
     ) VALUES ($1, NULL, $2, 'pending', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      farmerId,
      requestPending.service_type,
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

function buildProviderSelectionList(recommendations, serviceType) {
  const rows = recommendations.slice(0, 10).map((r) => {
    const avail =
      r.availabilityPeriod
        ? `${String(r.availabilityPeriod.firstAvailable).slice(0, 10)}–${String(r.availabilityPeriod.lastAvailable).slice(0, 10)}`
        : 'Check slots';
    const desc = `${r.farmerPayable.toLocaleString()} FCFA · ${r.distanceDisplay} · ⭐${r.avgRating || 0} · ${avail}`;
    return {
      id: `pick_prov_${r.providerId}`,
      title: String(r.name).slice(0, 24),
      description: desc.slice(0, 72),
    };
  });
  return buildOptionListReply(
    `Select a provider for *${serviceType}*.\nRanked by distance, availability, and rating (max 10).`,
    rows
  );
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
     ORDER BY available_date, start_time LIMIT 10`,
    [providerId, dates]
  );
  return res.rows;
}

function buildSlotSelectionList(slots, providerName) {
  const rows = slots.slice(0, 10).map((s) => {
    const dateStr = String(s.available_date).slice(0, 10);
    const start = String(s.start_time).slice(0, 5);
    const end = String(s.end_time).slice(0, 5);
    return {
      id: `slot_${s.id}`,
      title: `${dateStr} ${start}-${end}`.slice(0, 24),
      description: providerName.slice(0, 72),
    };
  });
  return buildOptionListReply(`Choose a time slot for *${providerName}* (max 10):`, rows);
}

/**
 * @param {object} updateSession - (waFrom, updates) => Promise
 */
async function beginProviderSelection(waPhone, farmer, lat, lng, requestPending, sessionExtras, updateSession) {
  const rejected = sessionExtras.rejected_provider_ids || [];
  const recs = await getRecommendedProvidersAtLocation(
    lat,
    lng,
    requestPending.service_type,
    requestPending.scheduled_date,
    requestPending.farm_size_ha,
    requestPending.budget_min_fcfa,
    requestPending.budget_max_fcfa,
    rejected
  );

  if (recs.length === 0) {
    await createPendingAdminBooking(farmer.id, requestPending);
    await updateSession(waPhone, { step: 'main_menu', data: {} });
    await sendBrandedText(
      waPhone,
      '✅ *Request saved.* No providers match your budget, availability, or location. Admin will assign one soon.\n\nReply *MENU* for options.'
    );
    return { ok: true, no_match: true };
  }

  const candidates = recs.map((r) => ({
    providerId: r.providerId,
    name: r.name,
    phone: r.phone,
    farmerPayable: r.farmerPayable,
    providerServiceId: r.providerServiceId,
    economics: {
      providerBaseAmount: r.providerAmount,
      platformFeeAmount: r.platformFee,
      farmerPayableAmount: r.farmerPayable,
      estimatedDurationDays: r.estimatedDurationDays,
      estimatedDurationHours: r.estimatedDurationHours,
    },
  }));

  await updateSession(waPhone, {
    step: 'request_choose_provider',
    user_type: 'farmer',
    data: {
      request_pending: requestPending,
      farm_gps_lat: lat,
      farm_gps_lng: lng,
      candidate_providers: candidates,
      rejected_provider_ids: rejected,
    },
  });

  await sendBotReply(waPhone, buildProviderSelectionList(recs, requestPending.service_type));
  return { ok: true, offered: recs.length };
}

async function showSlotsForProvider(waPhone, data, providerId, updateSession) {
  const candidate = (data.candidate_providers || []).find((c) => c.providerId === providerId);
  if (!candidate) {
    return { ok: false, error: 'invalid_provider' };
  }
  const rp = data.request_pending;
  const slots = await getSlotsNearDate(providerId, rp.scheduled_date);
  if (slots.length === 0) {
    return {
      ok: false,
      error: 'no_slots',
      message:
        `*${candidate.name}* has no open slots near ${rp.scheduled_date}. Pick another provider or reply *MENU* to cancel.`,
    };
  }

  await updateSession(waPhone, {
    step: 'request_choose_slot',
    data: {
      ...data,
      selected_provider: candidate,
      available_slots: slots.map((s) => ({
        id: s.id,
        available_date: String(s.available_date).slice(0, 10),
        start_time: String(s.start_time).slice(0, 8),
        end_time: String(s.end_time).slice(0, 8),
      })),
    },
  });

  return { ok: true, reply: buildSlotSelectionList(slots, candidate.name) };
}

async function finalizeSlotAndNotifyProvider(waPhone, farmer, data, slotId, updateSession) {
  const slot = (data.available_slots || []).find((s) => s.id === slotId);
  const selected = data.selected_provider;
  const rp = data.request_pending;
  if (!slot || !selected || !rp) {
    return { ok: false, error: 'invalid_slot' };
  }

  const economics = selected.economics;
  const booking = await createAwaitingProviderBooking(
    farmer.id,
    selected.providerId,
    {
      ...rp,
      scheduled_date: slot.available_date,
      scheduled_time: slot.start_time,
      requested_qty: rp.farm_size_ha,
    },
    economics,
    slotId,
    selected.providerServiceId
  );

  const provider = { full_name: selected.name, phone: selected.phone };
  const farmerUser = { full_name: farmer.name, phone: normalizePhone(waPhone) };
  await notifyProviderBookingRequest(booking, farmerUser, provider);

  await updateSession(waPhone, { step: 'main_menu', data: {} });
  await sendBrandedText(
    waPhone,
    `✅ Request sent to *${selected.name}*.\n` +
      `Date: ${slot.available_date} ${String(slot.start_time).slice(0, 5)}\n` +
      `Total if accepted: ${economics.farmerPayableAmount.toLocaleString()} FCFA\n\n` +
      'We will notify you when the provider responds. Reply *MENU* for options.'
  );
  return { ok: true, bookingId: booking.id };
}

async function reofferAfterProviderReject(farmerPhone, farmer, requestPending, lat, lng, rejectedIds, updateSession) {
  return beginProviderSelection(
    farmerPhone,
    farmer,
    lat,
    lng,
    requestPending,
    { rejected_provider_ids: rejectedIds },
    updateSession
  );
}

module.exports = {
  beginProviderSelection,
  showSlotsForProvider,
  finalizeSlotAndNotifyProvider,
  reofferAfterProviderReject,
  buildProviderSelectionList,
  getSlotsNearDate,
};
