/**
 * Digilync WhatsApp Bot – Structured Flow
 * Batched messaging, low cost, fast onboarding, structured data.
 */
const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendBrandedText } = require('./whatsapp-sender');
const { haversineDistanceKm } = require('../utils/geo');

const SERVICE_LIST = [
  'Ploughing', 'Planting', 'Spraying', 'Irrigation', 'Harvesting',
  'Processing', 'Storage', 'Transport', 'Other',
];

function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

async function getSession(waPhone) {
  const phone = normalizePhone(waPhone);
  const r = await pool.query(`SELECT * FROM whatsapp_sessions WHERE wa_phone = $1`, [phone]);
  if (r.rows.length > 0) return r.rows[0];
  await pool.query(
    `INSERT INTO whatsapp_sessions (wa_phone, user_type, step, data) VALUES ($1, 'unknown', 'main_menu', '{}') ON CONFLICT (wa_phone) DO NOTHING`,
    [phone]
  );
  const r2 = await pool.query(`SELECT * FROM whatsapp_sessions WHERE wa_phone = $1`, [phone]);
  return r2.rows[0] || { wa_phone: phone, user_type: 'unknown', step: 'main_menu', data: {} };
}

async function updateSession(waFrom, updates) {
  const phone = normalizePhone(waFrom);
  const { user_type, step, data } = updates;
  const dataJson = typeof data === 'object' ? JSON.stringify(data) : (data || '{}');
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = COALESCE($1, user_type), step = COALESCE($2, step), data = COALESCE($3::jsonb, data), updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $4`,
    [user_type || null, step || null, dataJson, phone]
  );
}

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function findExistingUser(phone) {
  const p = normalizePhone(phone);
  const digits = phoneDigits(p);
  const farmer = await pool.query(
    "SELECT id, full_name FROM farmers WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1",
    [digits]
  );
  if (farmer.rows.length > 0) return { type: 'farmer', id: farmer.rows[0].id, name: farmer.rows[0].full_name };
  const provider = await pool.query(
    "SELECT id, full_name FROM providers WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1",
    [digits]
  );
  if (provider.rows.length > 0) return { type: 'provider', id: provider.rows[0].id, name: provider.rows[0].full_name };
  return null;
}

/**
 * Insert farmer + plot, notify on WhatsApp. Used by web GPS POST and optional WhatsApp location pin.
 */
async function finalizeFarmerRegistrationFromPendingGps(waPhone, pending, lat, lng, { source = 'web' } = {}) {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (Number.isNaN(latN) || Number.isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return { ok: false, error: 'invalid_coords' };
  }
  const digits = phoneDigits(normalizePhone(waPhone));
  const dup = await pool.query(
    "SELECT id FROM farmers WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1",
    [digits]
  );
  if (dup.rows.length > 0) {
    return { ok: false, error: 'duplicate' };
  }
  const phoneCanonical = normalizePhone(waPhone);
  const village = (pending.village || '').trim() || 'Not specified';
  const notesParts = [];
  if (pending.phone_entered && phoneDigits(pending.phone_entered) !== digits) {
    notesParts.push(`Phone (as entered): ${pending.phone_entered}`);
  }
  notesParts.push(
    source === 'whatsapp'
      ? 'Registered via WhatsApp + location pin.'
      : 'Registered via WhatsApp + web GPS capture.'
  );
  const notes = notesParts.join('\n');
  const cropType = (pending.crop_type || '').trim() || 'Not specified';
  const serviceNeeds = [cropType];
  try {
    const ins = await pool.query(
      `INSERT INTO farmers (full_name, phone, village, location, gps_lat, gps_lng, farm_size_ha, crop_type, service_needs, consent_to_data_use, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        String(pending.full_name).trim(),
        phoneCanonical,
        village,
        village,
        latN,
        lngN,
        pending.farm_size_ha,
        cropType,
        serviceNeeds,
        true,
        notes,
      ]
    );
    const farmerId = ins.rows[0].id;
    await pool.query(
      `INSERT INTO farm_plots (farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [farmerId, latN, lngN, 'Farm 1', pending.farm_size_ha, cropType]
    );
    await updateSession(waPhone, { step: 'main_menu', user_type: 'unknown', data: {} });
    const existing = await findExistingUser(phoneCanonical);
    const menu = getMainMenu(existing);
    const body = `Registration Successful\n\n${menu}`;
    const to = `whatsapp:${digits}`;
    await sendBrandedText(to, body);
    return { ok: true, farmer_id: farmerId };
  } catch (err) {
    console.error('finalizeFarmerRegistrationFromPendingGps:', err);
    return { ok: false, error: 'db' };
  }
}

/**
 * Insert provider after GPS (web or WhatsApp) or SKIP. Sends privacy consent on WhatsApp.
 */
async function finalizeProviderRegistrationFromPendingGps(waPhone, pending, lat, lng, { source = 'web', skipGps = false } = {}) {
  const phoneCanonical = normalizePhone(waPhone);
  const digits = phoneDigits(phoneCanonical);
  const dup = await pool.query(
    "SELECT id FROM providers WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1",
    [digits]
  );
  if (dup.rows.length > 0) {
    return { ok: false, error: 'duplicate' };
  }
  let gpsLat = null;
  let gpsLng = null;
  if (!skipGps) {
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    if (Number.isNaN(latN) || Number.isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      return { ok: false, error: 'invalid_coords' };
    }
    gpsLat = latN;
    gpsLng = lngN;
  }
  const haPerHour = pending.capacity / 8;
  try {
    const ins = await pool.query(
      `INSERT INTO providers (full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, service_radius_km, gps_lat, gps_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [pending.name, phoneCanonical, pending.services.join(', '), haPerHour, pending.price, pending.radius, gpsLat, gpsLng]
    );
    const providerId = ins.rows[0].id;
    await updateSession(waPhone, {
      step: 'privacy_consent_new',
      user_type: 'unknown',
      data: { privacy_pending: { role: 'provider', id: providerId } },
    });
    const to = `whatsapp:${digits}`;
    await sendBrandedText(to, getPrivacyConsentPostRegisterMessage());
    return { ok: true, provider_id: providerId };
  } catch (err) {
    console.error('finalizeProviderRegistrationFromPendingGps:', err);
    return { ok: false, error: 'db' };
  }
}

async function findMatchingProviders(serviceType, farmerLat, farmerLng) {
  const r = await pool.query(
    `SELECT p.id, p.full_name, p.phone, p.services_offered, p.base_price_per_ha, p.service_radius_km,
            p.work_capacity_ha_per_hour, p.gps_lat, p.gps_lng,
            (SELECT ROUND(AVG(fr.rating)::numeric, 1) FROM farmer_ratings fr WHERE fr.provider_id = p.id) AS avg_rating
     FROM providers p
     WHERE p.services_offered ILIKE $1
     ORDER BY p.id ASC`,
    ['%' + (serviceType || '').trim() + '%']
  );
  let rows = r.rows;
  if (farmerLat != null && farmerLng != null) {
    rows = rows
      .filter((pr) => {
        const prLat = parseFloat(pr.gps_lat);
        const prLng = parseFloat(pr.gps_lng);
        if (isNaN(prLat) || isNaN(prLng)) return true;
        const radius = parseFloat(pr.service_radius_km) || 999;
        return haversineDistanceKm(farmerLat, farmerLng, prLat, prLng) <= radius;
      })
      .map((pr) => {
        const prLat = parseFloat(pr.gps_lat);
        const prLng = parseFloat(pr.gps_lng);
        const dist = (prLat != null && !isNaN(prLat) && prLng != null && !isNaN(prLng))
          ? haversineDistanceKm(farmerLat, farmerLng, prLat, prLng) : null;
        return { ...pr, distance_km: dist };
      })
      .sort((a, b) => {
        if (a.distance_km != null && b.distance_km != null) return a.distance_km - b.distance_km;
        if (a.distance_km != null) return -1;
        if (b.distance_km != null) return 1;
        return (parseFloat(b.avg_rating) || 0) - (parseFloat(a.avg_rating) || 0);
      });
  }
  return rows.slice(0, 10);
}

async function createBookingAndNotify(waFrom, existing, provider, data) {
  let bookingId;
  try {
    const ins = await pool.query(
      `INSERT INTO bookings (farmer_id, provider_id, service_type, status, scheduled_date, farm_size_ha)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING id`,
      [existing.id, provider.id, data.service_type, data.scheduled_date || null, data.farm_size_ha]
    );
    bookingId = ins.rows[0].id;
    await updateSession(waFrom, { step: 'main_menu', data: {} });

    const priceHa = parseFloat(provider.base_price_per_ha) || 0;
    const farmSize = data.farm_size_ha || 0;
    const estTotal = Math.round(priceHa * farmSize);

    try {
      await sendBrandedText(provider.phone,
        `🔔 *New Request*\n\n` +
        `Service: ${data.service_type}\n` +
        `Farm size: ${farmSize} ha\n` +
        `Distance: ${provider.distance_km != null ? provider.distance_km.toFixed(1) + ' km' : '—'}\n` +
        `Total Earnings: ${estTotal.toLocaleString()} FCFA\n\n` +
        `1. Accept\n2. Reject\n\n` +
        `Reply *ACCEPT ${bookingId}* or *REJECT ${bookingId}*`
      );
    } catch (e) {
      console.error('WhatsApp notify provider failed:', e);
    }

    return '✅ *Request submitted!*\n\n' +
      `Provider *${provider.full_name}* has been notified.\n` +
      `Total Cost: ${estTotal.toLocaleString()} FCFA\n\n` +
      'Reply *MENU* for options.';
  } catch (err) {
    console.error('Booking create error:', err);
    return 'Sorry, the request could not be submitted. Please try again.';
  }
}

function getMainMenu(_existing = null) {
  return (
    'Welcome\n\n' +
    'What would you like to do?\n\n' +
    '1. Register as Farmer\n' +
    '2. Register as Service Provider\n' +
    '3. Request a Service\n' +
    '4. My Requests\n' +
    '5. Help\n' +
    '6. Unsubscribe / Delete Account\n' +
    '7. Recap (View My Data)'
  );
}

/** Base URL for web app links (GPS capture page). Uses FRONTEND_URL from .env (same as CORS). */
function getFrontendBaseUrl() {
  const u = process.env.FRONTEND_URL || 'https://digilync.net';
  return String(u).replace(/\/$/, '');
}

function getFarmerWaRegistrationPrompt() {
  return (
    'Enter Your Full Name:\n' +
    'Enter Your Phone Number:\n' +
    'Enter Your Village/Location:\n\n' +
    'Enter Farm Size:\n' +
    'Enter Crop Type:\n\n' +
    'Send one message with each line filled in, e.g. *Full Name:* Jane … *Phone Number:* …'
  );
}

function parseFarmerWaRegistrationForm(text) {
  const kv = parseKeyValueBlock(text);
  const fullName = (
    kv.full_name ||
    kv.name ||
    kv.enter_your_full_name ||
    ''
  ).trim();
  const phoneEntered = (
    kv.phone_number ||
    kv.phone ||
    kv.enter_your_phone_number ||
    ''
  ).trim();
  const village = (
    kv.village_location ||
    kv.village ||
    kv.location ||
    kv['village/location'] ||
    kv['enter_your_village/location'] ||
    kv.enter_your_village_location ||
    ''
  ).trim();
  const farmSizeRaw = kv.farm_size || kv.enter_farm_size || '';
  const crop = (
    kv.crop_type ||
    kv.crop ||
    kv.enter_crop_type ||
    ''
  ).trim();
  return { fullName, phoneEntered, village, farmSizeRaw, crop };
}

function getHelpMessage() {
  return (
    '📘 *Help*\n\n' +
    '• *1 Farmer* – Send your details, then open the *GPS link* to drop your farm pin\n' +
    '• *2 Provider* – Reply with your service profile, then open the *GPS link* for your base location\n' +
    '• *3 Request* – Book a service (farmers only)\n' +
    '• *4 My Requests* – Your bookings / jobs\n' +
    '• *7 Recap* – See your saved farms or profile\n' +
    '• *6 Unsubscribe* – Remove your account\n\n' +
    'Reply *MENU* to go back.'
  );
}

/** Shown immediately after farmer/provider registration; Agree completes onboarding, Disagree removes the new record. */
function getPrivacyConsentPostRegisterMessage() {
  return (
    '🔒 *Your privacy matters*\n\n' +
    'Digilync takes your personal information seriously. We use it only to deliver and improve our services: coordinating agricultural services, enabling access to service-based credit where applicable, and supporting secure transactions.\n\n' +
    'We do not sell your data. We do not share it with third parties without your permission, except where necessary to provide the service or to meet legal obligations.\n\n' +
    'By continuing, you agree to the collection and use of your data as described above and in our Privacy Policy (digilync.com/privacy).\n\n' +
    '*Do you consent?*\n\n' +
    '1. Agree\n' +
    '2. Disagree'
  );
}

async function handlePrivacyConsentPostRegister(waFrom, text, data) {
  const pending = data.privacy_pending;
  const phone = normalizePhone(waFrom);
  const t = text.trim().toLowerCase();
  if (['help', '?'].includes(t)) {
    return getHelpMessage();
  }
  if (!pending || !pending.role || !pending.id) {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    const existing = await findExistingUser(phone);
    return getMainMenu(existing);
  }
  const agreed = t === '1' || t === 'agree' || t === 'yes' || t === 'i agree';
  const disagreed = t === '2' || t === 'disagree' || t === 'no';

  if (disagreed) {
    try {
      if (pending.role === 'farmer') {
        await pool.query('DELETE FROM farm_plots WHERE farmer_id = $1', [pending.id]);
        await pool.query('DELETE FROM bookings WHERE farmer_id = $1', [pending.id]);
        await pool.query('DELETE FROM farmers WHERE id = $1', [pending.id]);
      } else if (pending.role === 'provider') {
        await pool.query('UPDATE bookings SET provider_id = NULL WHERE provider_id = $1', [pending.id]);
        await pool.query('DELETE FROM providers WHERE id = $1', [pending.id]);
      }
    } catch (err) {
      console.error('Privacy consent reject cleanup error:', err);
      return 'Sorry, something went wrong. Please contact contact@digilync.com.';
    }
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return (
      'We cannot keep your account without your consent. Your registration has been removed.\n\n' +
      'You can register again anytime if you change your mind. Reply *MENU* for options.'
    );
  }

  if (agreed) {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    if (pending.role === 'farmer') {
      return '✅ *Registration complete!* You are now a Digilync farmer.\n\nReply *MENU* for options.';
    }
    return '✅ *Registration complete!* You are now a Digilync service provider.\n\nReply *MENU* for options.';
  }

  return 'Please reply *1* to Agree or *2* to Disagree.';
}

async function getFarmerFarms(farmerId) {
  const farmerRes = await pool.query(
    'SELECT village FROM farmers WHERE id = $1',
    [farmerId]
  );
  const village = farmerRes.rows[0]?.village || null;
  const plotsRes = await pool.query(
    'SELECT id, plot_name, plot_size_ha, crop_type, gps_lat, gps_lng FROM farm_plots WHERE farmer_id = $1 ORDER BY id',
    [farmerId]
  );
  if (plotsRes.rows.length > 0) {
    return plotsRes.rows.map((p) => ({ ...p, location: village }));
  }
  const fRes = await pool.query(
    'SELECT farm_size_ha, crop_type, gps_lat, gps_lng FROM farmers WHERE id = $1',
    [farmerId]
  );
  const f = fRes.rows[0];
  if (!f) return [];
  return [{
    id: null,
    plot_name: 'Farm 1',
    plot_size_ha: f.farm_size_ha,
    crop_type: f.crop_type,
    gps_lat: f.gps_lat,
    gps_lng: f.gps_lng,
    location: village,
  }];
}

function getRequestSelectFarmMessage(farms) {
  let msg = '*Select the farm:*\n\n';
  farms.forEach((farm, i) => {
    const loc = farm.location || farm.plot_name || '—';
    const crop = farm.crop_type || '—';
    const size = farm.plot_size_ha ?? farm.farm_size_ha ?? '—';
    msg += `${i + 1}. Farm ${i + 1} (${loc} – ${crop} – ${size} ha)\n`;
  });
  msg += '\nReply with the number.';
  return msg;
}

async function handleIncoming(waFrom, body, latitude, longitude, profileName) {
  const phone = normalizePhone(waFrom);
  const text = (body || '').trim();
  const textLower = text.toLowerCase();
  const existing = await findExistingUser(phone);
  const session = await getSession(waFrom);
  const data = typeof session.data === 'object' ? session.data : (session.data ? JSON.parse(session.data) : {});

  const inActiveFlow =
    (session.step &&
      (session.step.startsWith('farmer_') ||
        session.step.startsWith('provider_') ||
        session.step.startsWith('request_') ||
        session.step === 'add_farm_details' ||
        session.step === 'unsubscribe_confirm' ||
        session.step === 'recap_options' ||
        session.step === 'privacy_consent_new')) ||
    false;

  // Reset to main menu from anywhere (including exiting privacy consent)
  if (['menu', 'start', '0', 'hi', 'hello'].includes(textLower)) {
    if (session.step === 'privacy_consent_new' && data.privacy_pending?.role && data.privacy_pending?.id) {
      try {
        if (data.privacy_pending.role === 'farmer') {
          await pool.query('DELETE FROM farm_plots WHERE farmer_id = $1', [data.privacy_pending.id]);
          await pool.query('DELETE FROM bookings WHERE farmer_id = $1', [data.privacy_pending.id]);
          await pool.query('DELETE FROM farmers WHERE id = $1', [data.privacy_pending.id]);
        } else if (data.privacy_pending.role === 'provider') {
          await pool.query('UPDATE bookings SET provider_id = NULL WHERE provider_id = $1', [data.privacy_pending.id]);
          await pool.query('DELETE FROM providers WHERE id = $1', [data.privacy_pending.id]);
        }
      } catch (e) {
        console.error('Menu exit privacy cleanup error:', e);
      }
    }
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    const ex = await findExistingUser(phone);
    return getMainMenu(ex);
  }

  if (session.step === 'privacy_consent_new') {
    return handlePrivacyConsentPostRegister(waFrom, text, data);
  }

  if (['help', '?'].includes(textLower)) {
    return getHelpMessage();
  }

  // Help: "5" only when not in a flow where "5" might be real input (e.g. farm size)
  if (textLower === '5' && !inActiveFlow) {
    return getHelpMessage();
  }

  // Unregistered: switch Farmer ↔ Provider signup or resend GPS link
  if (!existing) {
    const t = text.trim();
    if (session.step === 'farmer_await_gps_web' && t === '1' && data.gps_token && data.pending_farmer) {
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token)}`;
      return (
        `🔗 *Click to enter GPS:*\n${gpsUrl}\n\n` +
        'Or send your *location pin* in WhatsApp (📎 → Location).\n\n' +
        'Reply *MENU* to cancel.'
      );
    }
    if (session.step === 'provider_await_gps_web' && t === '1' && data.gps_token && data.pending_provider) {
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token)}&role=provider`;
      return (
        `🔗 *Click to set your base location:*\n${gpsUrl}\n\n` +
        'Or send your *location pin* in WhatsApp (📎 → Location).\n\n' +
        'Reply *MENU* to cancel.'
      );
    }
    if (t === '2' && session.step === 'farmer_wa_form') {
      await updateSession(waFrom, { user_type: 'provider', step: 'provider_batched', data: {} });
      return 'Switched to *Service Provider* registration.\n\n' + getProviderBatchedMessage();
    }
    if (t === '1' && session.step === 'provider_batched') {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_wa_form', data: {} });
      return 'Switched to *Farmer* registration.\n\n' + getFarmerWaRegistrationPrompt();
    }
    if (t === '2' && session.step === 'farmer_await_gps_web') {
      await updateSession(waFrom, { user_type: 'provider', step: 'provider_batched', data: {} });
      return 'Cancelled the farmer GPS step. Starting *Service Provider* registration.\n\n' + getProviderBatchedMessage();
    }
    if (t === '2' && session.step === 'provider_await_gps_web') {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_wa_form', data: {} });
      return 'Cancelled the provider GPS step. Starting *Farmer* registration.\n\n' + getFarmerWaRegistrationPrompt();
    }
  }

  // In-flow handlers (must run BEFORE main menu option checks, so "1" in unsubscribe_confirm is not mistaken for "Register as Farmer")
  if (session.step === 'unsubscribe_confirm' && existing) {
    return handleUnsubscribeConfirm(waFrom, existing, text);
  }
  if (session.step === 'recap_options' && existing) {
    if (text === '1') {
      const farms = (data.farms && data.farms.length) ? data.farms : await getFarmerFarms(existing.id);
      if (farms.length > 1) {
        await updateSession(waFrom, { step: 'request_select_farm', data: { farmer_id: existing.id, farms } });
        return getRequestSelectFarmMessage(farms);
      }
      const farm = farms[0];
      await updateSession(waFrom, {
        step: 'request_input',
        data: {
          farmer_id: existing.id,
          farm_plot_id: farm?.id,
          farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha,
          farm_gps_lat: farm?.gps_lat,
          farm_gps_lng: farm?.gps_lng,
        },
      });
      return getRequestInputMessage({ farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha });
    }
    if (text === '2') {
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return 'To edit farm details, please contact the admin team or use the Digilync web portal.\n\nReply *MENU* for options.';
    }
    if (text === '3') {
      return handleAddAnotherFarm(waFrom, existing);
    }
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return getMainMenu(existing);
  }

  // Registered user: handle menu options
  if (existing) {
    if (text === '4') return handleMyRequests(waFrom, existing);
    if (text === '5') return getHelpMessage();
    if (text === '6') return handleUnsubscribeFlow(waFrom, existing);
    if (text === '7') return handleRecap(waFrom, existing, true);
    if (text === '1' && existing.type === 'provider') {
      return (
        'You are already registered as a *service provider*. To register as a farmer, use a different WhatsApp number or contact support.\n\n' +
        'Reply *MENU* for options.'
      );
    }
    if (text === '2' && existing.type === 'farmer') {
      return (
        'You are already registered as a *farmer*. To sign up as a service provider, use a different WhatsApp number or contact support.\n\n' +
        'Reply *MENU* for options.'
      );
    }
    if (existing.type === 'farmer' && text === '3') {
      const farms = await getFarmerFarms(existing.id);
      if (farms.length === 0) {
        return 'No farm registered yet. Please complete your registration first. Reply *MENU* for options.';
      }
      if (farms.length > 1) {
        await updateSession(waFrom, { step: 'request_select_farm', data: { farmer_id: existing.id, farms } });
        return getRequestSelectFarmMessage(farms);
      }
      const farm = farms[0];
      await updateSession(waFrom, {
        step: 'request_input',
        data: {
          farmer_id: existing.id,
          farm_plot_id: farm?.id,
          farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha,
          farm_gps_lat: farm?.gps_lat,
          farm_gps_lng: farm?.gps_lng,
        },
      });
      return getRequestInputMessage({ farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha });
    }
    if (existing.type === 'provider' && text === '3') {
      return 'Please register as a farmer to request services. Reply *MENU* for options.';
    }
    if (text === '1' && existing.type === 'farmer') {
      return 'You are already registered as a farmer. Reply *3* to request a service or *MENU* for options.';
    }
    if (text === '2' && existing.type === 'provider') {
      return 'You are already registered as a provider. Reply *4* for your jobs or *MENU* for options.';
    }
  }

  // Unregistered: main-menu shortcuts only (do not steal "1"/"2" while mid-registration)
  if (!existing) {
    const inOnboarding =
      session.step &&
      (session.step.startsWith('farmer_') ||
        session.step.startsWith('provider_') ||
        session.step.startsWith('request_') ||
        session.step === 'add_farm_details');
    if (!inOnboarding) {
      if (text === '1') {
        await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_wa_form', data: {} });
        return getFarmerWaRegistrationPrompt();
      }
      if (text === '2') {
        await updateSession(waFrom, { user_type: 'provider', step: 'provider_batched', data: {} });
        return getProviderBatchedMessage();
      }
      if (text === '3') {
        return 'Please register as a farmer first (reply *1*). Reply *MENU* for options.';
      }
      if (text === '4') {
        return 'Please register first. Reply *1* for Farmer or *2* for Provider.';
      }
      if (text === '6') {
        return 'You are not registered. Reply *1* for Farmer or *2* for Provider to register.';
      }
      if (text === '7') {
        return 'Please register first to view your data. Reply *1* for Farmer or *2* for Provider.';
      }
    }
  }

  // In-flow handlers
  if (session.step === 'add_farm_details' && existing?.type === 'farmer') {
    return handleAddFarmDetails(waFrom, existing, text, data);
  }
  if (session.step && session.step.startsWith('farmer_')) {
    return handleFarmerFlow(waFrom, session, data, text, latitude, longitude);
  }
  if (session.step && session.step.startsWith('provider_')) {
    return handleProviderFlow(waFrom, session, data, text, latitude, longitude);
  }
  if (session.step && session.step.startsWith('request_')) {
    return handleRequestFlow(waFrom, session, data, text, latitude, longitude, existing);
  }

  // Provider accept/reject
  if (existing?.type === 'provider') {
    const acceptMatch = text.match(/^1\s*$/);
    const rejectMatch = text.match(/^2\s*$/);
    const jobMatch = text.match(/^accept\s*(\d+)$/i) || text.match(/^reject\s*(\d+)$/i);
    if (jobMatch) {
      const id = parseInt(jobMatch[1], 10);
      return jobMatch[0].toLowerCase().startsWith('accept')
        ? handleProviderAcceptJob(waFrom, existing, id)
        : handleProviderRejectJob(waFrom, existing, id);
    }
  }

  return getMainMenu(existing);
}

function parseKeyValueBlock(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    // Slashes (e.g. Village/Location) must become underscores or lookups like kv.village_location miss.
    const key = match[1].trim().toLowerCase().replace(/[\s/]+/g, '_');
    let value = match[2].trim();
    if (value === '' && i + 1 < lines.length) {
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j += 1;
      if (j < lines.length) {
        const next = lines[j];
        if (next && !/^\s*[^:]+:\s*.+$/.test(next)) {
          value = next.trim();
          i = j;
        }
      }
    }
    result[key] = value;
  }
  return result;
}

async function handleFarmerFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  switch (session.step) {
    case 'farmer_wa_form': {
      const parsed = parseFarmerWaRegistrationForm(text);
      const farmSize = parseFloat(parsed.farmSizeRaw);
      if (
        !parsed.fullName ||
        !parsed.phoneEntered ||
        !parsed.village ||
        !parsed.crop ||
        Number.isNaN(farmSize) ||
        farmSize < 0
      ) {
        return (
          'Please send *all* fields: full name, phone, village/location, farm size (number), and crop type.\n\n' +
          getFarmerWaRegistrationPrompt()
        );
      }
      const token = crypto.randomUUID();
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(token)}`;
      await updateSession(waFrom, {
        step: 'farmer_await_gps_web',
        user_type: 'farmer',
        data: {
          gps_token: token,
          pending_farmer: {
            full_name: parsed.fullName,
            phone_entered: parsed.phoneEntered,
            village: parsed.village,
            farm_size_ha: farmSize,
            crop_type: parsed.crop,
          },
        },
      });
      return (
        '✅ Details received.\n\n' +
        `🔗 *Click to enter GPS:*\n${gpsUrl}\n\n` +
        'Open the link, allow location when your browser asks, and your farm pin will be saved automatically.\n\n' +
        'We will confirm here when GPS is saved.\n\n' +
        'Reply *MENU* to cancel.'
      );
    }

    case 'farmer_await_gps_web': {
      if (latitude != null && longitude != null && data.pending_farmer) {
        const r = await finalizeFarmerRegistrationFromPendingGps(phone, data.pending_farmer, latitude, longitude, {
          source: 'whatsapp',
        });
        if (r.ok) return null;
        if (r.error === 'duplicate') {
          return 'This WhatsApp number is already registered as a farmer. Reply *MENU* for options.';
        }
        return 'We could not save your location. Try the web link again or send *MENU*.';
      }
      return (
        '📍 *Waiting for your farm GPS*\n\n' +
        'Use the *Click to enter GPS* link we sent, or send your *location pin* here (📎 → Location).\n\n' +
        'Reply *1* to resend the link. Reply *MENU* to cancel.'
      );
    }

    default:
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu(await findExistingUser(phone));
  }
}

function getProviderBatchedMessage() {
  return (
    'Service provider — reply using these labels (same line or next line after each label):\n\n' +
    'Name:\n' +
    'Radius:\n' +
    'Price:\n' +
    'Capacity:\n' +
    'Services:\n\n' +
    '*Radius* = service radius in km · *Price* = FCFA per hectare · *Capacity* = hectares you can cover per day\n\n' +
    'Service numbers (comma-separated):\n' +
    '1. Ploughing 2. Planting 3. Spraying 4. Irrigation 5. Harvesting\n' +
    '6. Processing 7. Storage 8. Transport 9. Other\n\n' +
    '*Example:*\n' +
    'Name: John\n' +
    'Radius: 10\n' +
    'Price: 12000\n' +
    'Capacity: 3\n' +
    'Services: 1,5'
  );
}

function getProviderAwaitGpsWebMessage() {
  return (
    '📍 *Waiting for your base location*\n\n' +
    'Use the *Click to set your base location* link we sent, or send your *location pin* here (📎 → Location).\n\n' +
    'You can also type coordinates: *4.6382, 9.4469* or reply *SKIP* to register without GPS.\n\n' +
    'Reply *1* to resend the link. Reply *MENU* to cancel.'
  );
}

async function handleProviderFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  if (session.step === 'provider_batched') {
    const kv = parseKeyValueBlock(text);
    const name = kv.name || kv.full_name;
    if (!name) return 'Please include *Name:* and the other fields.\n\n' + getProviderBatchedMessage();
    const radius = parseFloat(kv.radius || kv.service_radius || '');
    const price = parseFloat(kv.price || kv.price_per_hectare || '');
    const capacity = parseFloat(kv.capacity || kv.work_capacity || '');
    if (isNaN(radius) || radius < 0) return 'Please include *Radius:* (km). Example: Radius: 10\n\n' + getProviderBatchedMessage();
    if (isNaN(price) || price < 0) return 'Please include *Price:* (FCFA/ha). Example: Price: 12000\n\n' + getProviderBatchedMessage();
    if (isNaN(capacity) || capacity < 0) return 'Please include *Capacity:* (ha/day). Example: Capacity: 3\n\n' + getProviderBatchedMessage();
    const serviceNums = (kv.services || '').replace(/[^\d,]/g, '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= 9);
    const services = serviceNums.map((n) => SERVICE_LIST[n - 1]).filter(Boolean);
    const token = crypto.randomUUID();
    const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(token)}&role=provider`;
    await updateSession(waFrom, {
      step: 'provider_await_gps_web',
      user_type: 'provider',
      data: {
        gps_token: token,
        pending_provider: {
          name,
          radius,
          price,
          capacity,
          services: services.length ? services : ['General'],
          serviceNums,
        },
      },
    });
    return (
      '✅ Profile received.\n\n' +
      `🔗 *Click to set your base location:*\n${gpsUrl}\n\n` +
      'Open the link, allow location when your browser asks, and your base pin will be saved automatically.\n\n' +
      'We will confirm here when GPS is saved.\n\n' +
      'Reply *1* to resend the link. Reply *MENU* to cancel.'
    );
  }

  if (session.step === 'provider_await_gps_web') {
    const pending = data.pending_provider;
    if (!pending || !pending.name) {
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu(await findExistingUser(phone));
    }
    let gpsLat = null;
    let gpsLng = null;
    if (latitude != null && longitude != null) {
      gpsLat = parseFloat(latitude);
      gpsLng = parseFloat(longitude);
    } else {
      const coordMatch = String(text || '').trim().match(/(-?\d+\.?\d*)\s*[,]\s*(-?\d+\.?\d*)/);
      if (coordMatch) {
        gpsLat = parseFloat(coordMatch[1]);
        gpsLng = parseFloat(coordMatch[2]);
      }
    }
    if (gpsLat != null && gpsLng != null) {
      if (gpsLat < -90 || gpsLat > 90 || gpsLng < -180 || gpsLng > 180) {
        return 'Invalid coordinates. Try again or open the GPS link.\n\n' + getProviderAwaitGpsWebMessage();
      }
      const r = await finalizeProviderRegistrationFromPendingGps(phone, pending, gpsLat, gpsLng, { source: 'whatsapp' });
      if (r.ok) return null;
      if (r.error === 'duplicate') {
        return 'This WhatsApp number is already registered as a provider. Reply *MENU* for options.';
      }
      return 'We could not save your location. Try the web link again or send *MENU*.';
    }
    if (String(text || '').trim().toLowerCase() === 'skip') {
      const r = await finalizeProviderRegistrationFromPendingGps(phone, pending, null, null, { skipGps: true });
      if (r.ok) return null;
      if (r.error === 'duplicate') {
        return 'This WhatsApp number is already registered as a provider. Reply *MENU* for options.';
      }
      return 'We could not complete registration. Please try again.';
    }
    return getProviderAwaitGpsWebMessage();
  }

  await updateSession(waFrom, { step: 'main_menu', data: {} });
  return getMainMenu();
}

function getRequestInputMessage(data = {}) {
  const hasPresetFarm = data.farm_size_ha != null;
  let msg = '*Request a Service*\n\n' +
    'Select service (number):\n';
  if (!hasPresetFarm) {
    msg += 'Enter farm size:\n' +
      'Confirm location:\n\n';
  }
  msg += '*Example:*\n' +
    'Service: 1\n';
  if (!hasPresetFarm) {
    msg += 'Farm size: 2\n' +
      'Location: share pin\n\n';
  }
  msg += 'Services: 1.Ploughing 2.Planting 3.Spraying 4.Irrigation 5.Harvesting 6.Processing 7.Storage 8.Transport';
  return msg;
}

async function handleRequestFlow(waFrom, session, data, text, latitude, longitude, existing) {
  if (!existing || existing.type !== 'farmer') {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return getMainMenu();
  }

  switch (session.step) {
    case 'request_select_farm': {
      const num = parseInt(text.trim(), 10);
      const farms = data.farms || [];
      if (isNaN(num) || num < 1 || num > farms.length) {
        return `Reply with a number from 1 to ${farms.length}.\n\n` + getRequestSelectFarmMessage(farms);
      }
      const farm = farms[num - 1];
      const selectedFarmSize = farm.plot_size_ha ?? farm.farm_size_ha;
      await updateSession(waFrom, {
        step: 'request_input',
        data: {
          farmer_id: existing.id,
          farm_plot_id: farm.id,
          farm_size_ha: selectedFarmSize,
          farm_gps_lat: farm.gps_lat,
          farm_gps_lng: farm.gps_lng,
        },
      });
      return getRequestInputMessage({ farm_size_ha: selectedFarmSize });
    }

    case 'request_input': {
      const kv = parseKeyValueBlock(text);
      const serviceNum = parseInt(kv.service || '', 10);
      const farmSizeRaw = parseFloat(kv.farm_size || '');
      const farmSize = !isNaN(farmSizeRaw) && farmSizeRaw >= 0 ? farmSizeRaw : (data.farm_size_ha != null ? parseFloat(data.farm_size_ha) : NaN);
      if (isNaN(serviceNum) || serviceNum < 1 || serviceNum > 8) return 'Please include *Service:* (1-8). Example: Service: 1';
      if (isNaN(farmSize) || farmSize < 0) return 'Please include *Farm size:* (ha). Example: Farm size: 2';
      const locHint = (kv.location || kv.confirm_location || '').toLowerCase();
      if (locHint.includes('share') || locHint.includes('pin')) {
        await updateSession(waFrom, {
          step: 'request_wait_location',
          data: {
            farmer_id: existing.id,
            service_type: SERVICE_LIST[serviceNum - 1],
            farm_size_ha: farmSize,
          },
        });
        return 'Please *share your location* (tap 📍) to confirm your farm location.';
      }
      const serviceType = SERVICE_LIST[serviceNum - 1];
      let gpsLat = data.gps_lat ?? data.farm_gps_lat;
      let gpsLng = data.gps_lng ?? data.farm_gps_lng;
      if (latitude != null && longitude != null) {
        gpsLat = parseFloat(latitude);
        gpsLng = parseFloat(longitude);
      }
      const farmerRow = await pool.query('SELECT gps_lat, gps_lng FROM farmers WHERE id = $1', [existing.id]);
      const farmerLat = gpsLat ?? (farmerRow.rows[0]?.gps_lat != null ? parseFloat(farmerRow.rows[0].gps_lat) : null);
      const farmerLng = gpsLng ?? (farmerRow.rows[0]?.gps_lng != null ? parseFloat(farmerRow.rows[0].gps_lng) : null);
      const providers = await findMatchingProviders(serviceType, farmerLat, farmerLng);

      if (providers.length === 0) {
        try {
          await pool.query(
            `INSERT INTO bookings (farmer_id, provider_id, service_type, status, farm_size_ha) VALUES ($1, NULL, $2, 'pending', $3) RETURNING id`,
            [existing.id, serviceType, farmSize]
          );
          await updateSession(waFrom, { step: 'main_menu', data: {} });
          return '✅ *Request received!* No providers matched. Admin will assign one soon. Reply *MENU* for options.';
        } catch (err) {
          return 'Sorry, request could not be submitted. Please try again.';
        }
      }

      const farmSizeNum = farmSize;
      let msg = '*Available providers near you:*\n\n';
      providers.forEach((p, i) => {
        const priceHa = parseFloat(p.base_price_per_ha) || 0;
        const estTotal = Math.round(priceHa * farmSizeNum);
        const distStr = p.distance_km != null ? `${p.distance_km.toFixed(1)} km` : '—';
        const ratingStr = p.avg_rating != null ? `⭐ ${p.avg_rating}` : '—';
        msg += `${i + 1}. ${p.full_name}\n`;
        msg += `Price: ${priceHa.toLocaleString()} FCFA/ha\n`;
        msg += `Estimated Total: ${estTotal.toLocaleString()} FCFA\n`;
        msg += `Distance: ${distStr}\n`;
        msg += `Rating: ${ratingStr}\n\n`;
      });
      msg += 'Reply with number to select.';
      await updateSession(waFrom, {
        step: 'request_choose_provider',
        data: {
          farmer_id: existing.id,
          service_type: serviceType,
          farm_size_ha: farmSizeNum,
          matched_providers: providers,
        },
      });
      return msg;
    }

    case 'request_wait_location': {
      const gpsLat = latitude != null ? parseFloat(latitude) : null;
      const gpsLng = longitude != null ? parseFloat(longitude) : null;
      if (text.toLowerCase() === 'skip') {
        const farmerRow = await pool.query('SELECT gps_lat, gps_lng FROM farmers WHERE id = $1', [existing.id]);
        data.gps_lat = farmerRow.rows[0]?.gps_lat != null ? parseFloat(farmerRow.rows[0].gps_lat) : null;
        data.gps_lng = farmerRow.rows[0]?.gps_lng != null ? parseFloat(farmerRow.rows[0].gps_lng) : null;
      } else if (gpsLat != null && gpsLng != null) {
        data.gps_lat = gpsLat;
        data.gps_lng = gpsLng;
      } else {
        return 'Please share your location (tap 📍) or reply *SKIP* to use your saved location.';
      }
      const providers = await findMatchingProviders(data.service_type, data.gps_lat, data.gps_lng);
      if (providers.length === 0) {
        try {
          await pool.query(
            `INSERT INTO bookings (farmer_id, provider_id, service_type, status, farm_size_ha) VALUES ($1, NULL, $2, 'pending', $3) RETURNING id`,
            [existing.id, data.service_type, data.farm_size_ha]
          );
          await updateSession(waFrom, { step: 'main_menu', data: {} });
          return '✅ *Request received!* No providers matched. Admin will assign one soon. Reply *MENU* for options.';
        } catch (err) {
          return 'Sorry, request could not be submitted. Please try again.';
        }
      }
      const farmSizeNum = data.farm_size_ha;
      let msgLoc = '*Available providers near you:*\n\n';
      providers.forEach((p, i) => {
        const priceHa = parseFloat(p.base_price_per_ha) || 0;
        const estTotal = Math.round(priceHa * farmSizeNum);
        const distStr = p.distance_km != null ? `${p.distance_km.toFixed(1)} km` : '—';
        const ratingStr = p.avg_rating != null ? `⭐ ${p.avg_rating}` : '—';
        msgLoc += `${i + 1}. ${p.full_name}\n`;
        msgLoc += `Price: ${priceHa.toLocaleString()} FCFA/ha\n`;
        msgLoc += `Estimated Total: ${estTotal.toLocaleString()} FCFA\n`;
        msgLoc += `Distance: ${distStr}\n`;
        msgLoc += `Rating: ${ratingStr}\n\n`;
      });
      msgLoc += 'Reply with number to select.';
      await updateSession(waFrom, {
        step: 'request_choose_provider',
        data: {
          farmer_id: existing.id,
          service_type: data.service_type,
          farm_size_ha: farmSizeNum,
          matched_providers: providers,
        },
      });
      return msgLoc;
    }

    case 'request_choose_provider': {
      const num = parseInt(text.trim(), 10);
      const providers = data.matched_providers || [];
      if (isNaN(num) || num < 1 || num > providers.length) {
        return `Reply with a number from 1 to ${providers.length}.`;
      }
      const provider = providers[num - 1];
      await updateSession(waFrom, {
        step: 'request_confirm',
        data: { ...data, selected_provider: provider },
      });
      const estTotal = Math.round((parseFloat(provider.base_price_per_ha) || 0) * (data.farm_size_ha || 0));
      return (
        `You selected *${provider.full_name}*\n\n` +
        `Total Cost: ${estTotal.toLocaleString()} FCFA\n\n` +
        '1. Confirm\n2. Cancel'
      );
    }

    case 'request_confirm':
      if (text === '1' || text.toLowerCase() === 'confirm') {
        return await createBookingAndNotify(waFrom, existing, data.selected_provider, data);
      }
      if (text === '2' || text.toLowerCase() === 'cancel') {
        await updateSession(waFrom, { step: 'main_menu', data: {} });
        return 'Request cancelled. Reply *MENU* for options.';
      }
      return 'Reply *1* to Confirm or *2* to Cancel.';

    default:
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu();
  }
}

async function handleRecap(waFrom, existing, setStep = false) {
  if (existing.type === 'farmer') {
    const farms = await getFarmerFarms(existing.id);
    const farmerRes = await pool.query('SELECT full_name, village FROM farmers WHERE id = $1', [existing.id]);
    const farmer = farmerRes.rows[0];
    let msg = '📋 *Your Registered Farms:*\n\n';
    farms.forEach((farm, i) => {
      const loc = farm.location || farmer?.village || '—';
      const crop = farm.crop_type || '—';
      const size = farm.plot_size_ha ?? farm.farm_size_ha ?? '—';
      msg += `*Farm ${i + 1}:*\n`;
      msg += `Location: ${loc}\n`;
      msg += `Crop: ${crop}\n`;
      msg += `Size: ${size} ha\n\n`;
    });
    msg += 'Options:\n1. Request service for a farm\n2. Edit farm details\n3. Add another farm\n\nReply *MENU* to go back.';
    if (setStep) {
      await updateSession(waFrom, { step: 'recap_options', data: { farmer_id: existing.id, farms } });
    }
    return msg;
  }
  if (existing.type === 'provider') {
    const provRes = await pool.query(
      'SELECT full_name, services_offered, base_price_per_ha, service_radius_km FROM providers WHERE id = $1',
      [existing.id]
    );
    const p = provRes.rows[0];
    if (!p) return getMainMenu();
    let msg = '📋 *Your Provider Profile:*\n\n';
    msg += `Name: ${p.full_name}\n`;
    msg += `Services: ${p.services_offered || '—'}\n`;
    msg += `Price/ha: ${p.base_price_per_ha != null ? p.base_price_per_ha.toLocaleString() + ' FCFA' : '—'}\n`;
    msg += `Radius: ${p.service_radius_km != null ? p.service_radius_km + ' km' : '—'}\n\n`;
    msg += 'Reply *MENU* to go back.';
    return msg;
  }
  return getMainMenu();
}

function getAddFarmDetailsMessage() {
  return (
    'Add another farm:\n\n' +
    'Enter in this format:\n\n' +
    'Farm size (hectares):\n' +
    'Crop(s):\n\n' +
    '*Example:*\n' +
    'Farm size: 2.5\n' +
    'Crop: Maize, Cassava'
  );
}

async function handleAddAnotherFarm(waFrom, existing) {
  await updateSession(waFrom, { step: 'add_farm_details', data: { farmer_id: existing.id } });
  return getAddFarmDetailsMessage();
}

async function handleAddFarmDetails(waFrom, existing, text, data) {
  const kv = parseKeyValueBlock(text);
  const farmSize = parseFloat(kv.farm_size || kv.farm_size_hectares || '');
  const crop = kv.crop || kv.crops || '';
  if (isNaN(farmSize) || farmSize < 0) return 'Please include *Farm size:* (number). Example: Farm size: 2.5\n\n' + getAddFarmDetailsMessage();
  try {
    const farmerRes = await pool.query('SELECT gps_lat, gps_lng FROM farmers WHERE id = $1', [existing.id]);
    const f = farmerRes.rows[0];
    const gpsLat = f?.gps_lat != null ? parseFloat(f.gps_lat) : 0;
    const gpsLng = f?.gps_lng != null ? parseFloat(f.gps_lng) : 0;
    const plotsRes = await pool.query('SELECT id FROM farm_plots WHERE farmer_id = $1 ORDER BY id', [existing.id]);
    const plotName = `Farm ${plotsRes.rows.length + 1}`;
    await pool.query(
      `INSERT INTO farm_plots (farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [existing.id, gpsLat, gpsLng, plotName, farmSize, crop || 'Not specified']
    );
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return `✅ *Farm added successfully!*\n\n${plotName}: ${farmSize} ha, ${crop || 'Not specified'}\n\nReply *MENU* for options.`;
  } catch (err) {
    console.error('Add farm error:', err);
    return 'Sorry, we could not add the farm. Please try again.\n\n' + getAddFarmDetailsMessage();
  }
}

async function handleUnsubscribeFlow(waFrom, existing) {
  await updateSession(waFrom, { step: 'unsubscribe_confirm', data: {} });
  return (
    'Are you sure you want to delete your account?\n\n' +
    '1. Yes\n' +
    '2. No'
  );
}

async function handleUnsubscribeConfirm(waFrom, existing, text) {
  if (text === '1' || text.toLowerCase() === 'yes') {
    try {
      if (existing.type === 'farmer') {
        await pool.query('DELETE FROM farm_plots WHERE farmer_id = $1', [existing.id]);
        await pool.query('DELETE FROM bookings WHERE farmer_id = $1', [existing.id]);
        await pool.query('DELETE FROM farmers WHERE id = $1', [existing.id]);
      } else if (existing.type === 'provider') {
        await pool.query('UPDATE bookings SET provider_id = NULL WHERE provider_id = $1', [existing.id]);
        await pool.query('DELETE FROM providers WHERE id = $1', [existing.id]);
      }
      await pool.query('DELETE FROM whatsapp_sessions WHERE wa_phone = $1', [normalizePhone(waFrom)]);
      return 'Your account has been successfully removed from Digilync.\n\nThank you for using our service.';
    } catch (err) {
      console.error('Unsubscribe error:', err);
      return 'Sorry, we could not complete your request. Please try again later.';
    }
  }
  if (text === '2' || text.toLowerCase() === 'no') {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return getMainMenu(existing);
  }
  return 'Reply *1* for Yes or *2* for No.';
}

async function handleMyRequests(waFrom, existing) {
  if (existing.type === 'farmer') {
    const r = await pool.query(
      `SELECT b.id, b.service_type, b.farm_size_ha, b.status, b.scheduled_date, p.full_name AS provider_name
       FROM bookings b
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.farmer_id = $1
       ORDER BY b.created_at DESC
       LIMIT 10`,
      [existing.id]
    );
    if (r.rows.length === 0) return 'You have no requests yet. Reply *3* to request a service.';
    let msg = '📋 *Your Requests:*\n\n';
    r.rows.forEach((b, i) => {
      msg += `${i + 1}. ${b.service_type} – ${b.farm_size_ha} ha [${b.status}]\n`;
      if (b.provider_name) msg += `   Provider: ${b.provider_name}\n`;
      msg += '\n';
    });
    return msg + 'Reply *MENU* for options.';
  }
  if (existing.type === 'provider') {
    const jobs = await pool.query(
      `SELECT b.id, b.service_type, b.farm_size_ha, b.status, f.full_name AS farmer_name
       FROM bookings b
       JOIN farmers f ON b.farmer_id = f.id
       WHERE b.provider_id = $1 AND b.status IN ('pending', 'confirmed')
       ORDER BY b.scheduled_date ASC NULLS LAST`,
      [existing.id]
    );
    if (jobs.rows.length === 0) return 'You have no pending jobs. Reply *MENU* for options.';
    let msg = '📋 *Your Jobs:*\n\n';
    jobs.rows.forEach((j, i) => {
      const estTotal = Math.round((j.farm_size_ha || 0) * 12000);
      msg += `${i + 1}. ${j.service_type} – ${j.farmer_name} (${j.farm_size_ha} ha)\n`;
      msg += `   Reply *ACCEPT ${j.id}* or *REJECT ${j.id}*\n\n`;
    });
    return msg;
  }
  return getMainMenu();
}

async function handleProviderAcceptJob(waFrom, existing, bookingId) {
  try {
    const r = await pool.query(
      `UPDATE bookings SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND provider_id = $2 AND status = 'pending' RETURNING *, (SELECT phone FROM farmers WHERE id = bookings.farmer_id) AS farmer_phone`,
      [bookingId, existing.id]
    );
    if (r.rows.length === 0) return 'Job not found. Reply *4* for your jobs.';
    const b = r.rows[0];
    try {
      await sendBrandedText(b.farmer_phone, `✅ *Booking confirmed!*\n\nProvider *${existing.name}* has accepted your request.\nService: ${b.service_type}\n\nReply *MENU* for options.`);
    } catch (e) {
      console.error('WhatsApp notify farmer failed:', e);
    }
    return '✅ Job accepted! The farmer has been notified. Reply *MENU* for options.';
  } catch (err) {
    return 'Something went wrong. Reply *4* to try again.';
  }
}

async function handleProviderRejectJob(waFrom, existing, bookingId) {
  try {
    const r = await pool.query(
      `UPDATE bookings SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND provider_id = $2 AND status = 'pending' RETURNING id`,
      [bookingId, existing.id]
    );
    if (r.rows.length === 0) return 'Job not found. Reply *4* for your jobs.';
    return 'Job declined. Reply *4* for other jobs.';
  } catch (err) {
    return 'Something went wrong. Reply *4* to try again.';
  }
}

module.exports = {
  handleIncoming,
  normalizePhone,
  getSession,
  updateSession,
  findExistingUser,
  getMainMenu,
  finalizeFarmerRegistrationFromPendingGps,
  finalizeProviderRegistrationFromPendingGps,
};
