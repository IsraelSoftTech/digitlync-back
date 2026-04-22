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

function parseSessionData(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * After structured registration + confirmation — insert farmer, all plots, notify WhatsApp.
 */
async function insertFarmerFullFromPending(waPhone, pending) {
  const farms = pending.farms || [];
  if (farms.length === 0) return { ok: false, error: 'no_farms' };
  const latN = parseFloat(farms[0].gps_lat);
  const lngN = parseFloat(farms[0].gps_lng);
  if (Number.isNaN(latN) || Number.isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return { ok: false, error: 'invalid_coords' };
  }
  const phoneCanonical = normalizePhone(waPhone);
  const digits = phoneDigits(phoneCanonical);
  const dup = await pool.query(
    "SELECT id FROM farmers WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1",
    [digits]
  );
  if (dup.rows.length > 0) return { ok: false, error: 'duplicate' };

  const village =
    [pending.district, pending.subdivision].filter(Boolean).join(', ') ||
    (pending.region || '').trim() ||
    'Not specified';
  const locationLabel = village;
  const totalHa = farms.reduce((s, f) => s + (parseFloat(f.plot_size_ha) || 0), 0);
  const allCrops = farms.map((f) => (f.crop_type || '').trim()).filter(Boolean).join('; ') || 'Not specified';
  const serviceSet = new Set();
  farms.forEach((f) => (f.service_labels || []).forEach((x) => serviceSet.add(x)));
  const serviceNeeds = Array.from(serviceSet);
  const otherBits = farms.map((f) => f.other_services).filter(Boolean);
  const notesParts = ['Registered via DigiLync WhatsApp (structured flow).'];
  if (otherBits.length) notesParts.push(`Other services: ${otherBits.join(' | ')}`);

  try {
    const ins = await pool.query(
      `INSERT INTO farmers (full_name, phone, region, division, subdivision, district, village, location, gps_lat, gps_lng, farm_size_ha, crop_type, service_needs, consent_to_data_use, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        String(pending.full_name).trim(),
        phoneCanonical,
        (pending.region || '').trim() || null,
        (pending.division || '').trim() || null,
        (pending.subdivision || '').trim() || null,
        (pending.district || '').trim() || null,
        village,
        locationLabel,
        latN,
        lngN,
        totalHa,
        allCrops,
        serviceNeeds.length ? serviceNeeds : ['Not specified'],
        true,
        notesParts.join('\n'),
      ]
    );
    const farmerId = ins.rows[0].id;
    for (let i = 0; i < farms.length; i++) {
      const f = farms[i];
      const plat = parseFloat(f.gps_lat);
      const plng = parseFloat(f.gps_lng);
      await pool.query(
        `INSERT INTO farm_plots (farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [farmerId, plat, plng, `Farm ${i + 1}`, f.plot_size_ha, (f.crop_type || '').trim() || 'Not specified']
      );
    }
    await updateSession(waPhone, { step: 'main_menu', user_type: 'unknown', data: {} });
    const existing = await findExistingUser(phoneCanonical);
    const menu = getMainMenu(existing);
    const body = `Registration Successful\n\n${menu}`;
    await sendBrandedText(`whatsapp:${digits}`, body);
    return { ok: true, farmer_id: farmerId };
  } catch (err) {
    console.error('insertFarmerFullFromPending:', err);
    return { ok: false, error: 'db' };
  }
}

/**
 * Web or WhatsApp: GPS captured mid-registration — store draft, prompt farm details (no DB insert yet).
 */
async function applyFarmerGpsCapture(waPhone, lat, lng) {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (Number.isNaN(latN) || Number.isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return { ok: false, error: 'invalid_coords' };
  }
  const session = await getSession(waPhone);
  const data = parseSessionData(session.data);
  if (session.step !== 'farmer_await_gps_web' || !data.pending_farmer || data.pending_farmer.registration_flow !== 'v2') {
    return { ok: false, error: 'bad_step' };
  }
  const pending = { ...data.pending_farmer, plot_draft: { gps_lat: latN, gps_lng: lngN } };
  await updateSession(waPhone, {
    step: 'farmer_farm_details',
    user_type: 'farmer',
    data: { ...data, pending_farmer: pending },
  });
  const digits = phoneDigits(normalizePhone(waPhone));
  await sendBrandedText(`whatsapp:${digits}`, getFarmerFarmDetailsMessage());
  return { ok: true };
}

/** @deprecated Use applyFarmerGpsCapture + insertFarmerFullFromPending — kept for any legacy callers */
async function finalizeFarmerRegistrationFromPendingGps(waPhone, pending, lat, lng, { source: _source = 'web' } = {}) {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (Number.isNaN(latN) || Number.isNaN(lngN)) return { ok: false, error: 'invalid_coords' };
  const farmSize = parseFloat(pending.farm_size_ha);
  const crop = (pending.crop_type || 'Not specified').trim();
  const full = {
    full_name: pending.full_name,
    region: pending.region || '',
    division: pending.division || '',
    subdivision: pending.subdivision || '',
    district: pending.district || '',
    farms: [
      {
        gps_lat: latN,
        gps_lng: lngN,
        plot_size_ha: Number.isNaN(farmSize) ? 0 : farmSize,
        crop_type: crop,
        service_labels: [crop],
      },
    ],
  };
  return insertFarmerFullFromPending(waPhone, full);
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
        if (a.distance_km != null && b.distance_km != null && a.distance_km !== b.distance_km) {
          return a.distance_km - b.distance_km;
        }
        if (a.distance_km != null && b.distance_km == null) return -1;
        if (b.distance_km != null && a.distance_km == null) return 1;
        const pa = parseFloat(a.base_price_per_ha) || 0;
        const pb = parseFloat(b.base_price_per_ha) || 0;
        if (pa !== pb) return pa - pb;
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
        `*New Request:*\n\n` +
        `Service: ${data.service_type}\n` +
        `Farm size: ${farmSize} ha\n` +
        `Distance: ${provider.distance_km != null ? provider.distance_km.toFixed(1) + ' km' : '—'}\n` +
        `Total Earnings: ${estTotal.toLocaleString()} FCFA\n\n` +
        `1. Accept\n2. Reject\n\n` +
        `If you have several requests, reply *ACCEPT ${bookingId}* or *REJECT ${bookingId}*.`
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

function getMainMenu(existing = null) {
  let msg =
    'Welcome to DigiLync \u{1F331}\n\n' +
    'What would you like to do?\n\n' +
    '1. Register as Farmer\n' +
    '2. Register as Service Provider\n' +
    '3. Request a Service\n' +
    '4. My Requests\n' +
    '5. Help';
  if (existing) {
    msg += '\n6. Unsubscribe\n7. Recap';
  }
  return msg;
}

/** Base URL for web app links (GPS capture page). Uses FRONTEND_URL from .env (same as CORS). */
function getFrontendBaseUrl() {
  const u = process.env.FRONTEND_URL || 'https://digilync.net';
  return String(u).replace(/\/$/, '');
}

function getFarmerBasicMessage() {
  return (
    'Welcome to DigiLync \u{1F331}\n' +
    "Let's register your farm.\n\n" +
    'Please reply in this format:\n\n' +
    'Name:\n' +
    'Region:\n' +
    'Division:\n' +
    'Subdivision:\n' +
    'District:\n\n' +
    'Next step: we will send you a *link* to capture your farm GPS on a short web page (location on).\n\n' +
    '*Example:*\n' +
    'Name: John\n' +
    'Region: South West\n' +
    'Division: Meme\n' +
    'Subdivision: Kumba\n' +
    'District: Kumba 1'
  );
}

function parseFarmerBasicForm(text) {
  const kv = parseKeyValueBlock(text);
  const fullName = (kv.name || kv.full_name || '').trim();
  const region = (kv.region || '').trim();
  const division = (kv.division || '').trim();
  const subdivision = (kv.subdivision || '').trim();
  const district = (kv.district || '').trim();
  return { fullName, region, division, subdivision, district };
}

function getFarmerFarmDetailsMessage() {
  return (
    'Now enter your farm details:\n\n' +
    'Farm size (hectares):\n' +
    'Crop(s):\n\n' +
    'Select services needed (reply with numbers separated by comma):\n\n' +
    '1. Ploughing\n' +
    '2. Planting\n' +
    '3. Spraying\n' +
    '4. Irrigation\n' +
    '5. Harvesting\n' +
    '6. Processing\n' +
    '7. Storage\n' +
    '8. Transport\n' +
    '9. Other (specify)\n\n' +
    '*Example:*\n' +
    'Farm size: 2.5\n' +
    'Crop: Maize; Cassava\n' +
    'Services: 1,3,5'
  );
}

function getFarmerOtherServicesMessage() {
  return (
    'You selected "Other".\n\n' +
    'Please type additional service(s):\n\n' +
    '*Example:*\n' +
    'Drone spraying; Soil testing'
  );
}

function getFarmerMultiFarmMessage() {
  return (
    'Do you have another farm?\n\n' +
    '1. Yes\n' +
    '2. No'
  );
}

function getFarmerAwaitGpsMessage(gpsUrl) {
  return (
    '\u{1F4CD} *Farm GPS*\n\n' +
    'Open this link on your phone, turn on location, and save your pin:\n\n' +
    `🔗 ${gpsUrl}\n\n` +
    'Reply *1* to resend the link.\n' +
    'Reply *MENU* to cancel.'
  );
}

function buildFarmerConfirmationMessage(pending) {
  const district = (pending.district || pending.subdivision || '—').trim() || '—';
  const lines = ['Please confirm your details:\n'];
  lines.push(`Name: ${(pending.full_name || '').trim() || '—'}`);
  lines.push(`Location: ${district}`);
  const farms = pending.farms || [];
  farms.forEach((f, i) => {
    const svc = (f.service_labels || []).join(', ') || '—';
    lines.push(
      `Farm ${i + 1}: ${f.plot_size_ha} ha — ${(f.crop_type || '—').trim()} — ${svc}`
    );
  });
  lines.push('\n1. Confirm\n2. Edit');
  return lines.join('\n');
}

function parseFarmDetailsBatch(text) {
  const kv = parseKeyValueBlock(text);
  const farmSize = parseFloat(kv.farm_size || kv['farm_size_(hectares)'] || '');
  const crop = (kv.crop || kv.crops || kv.crop_type || kv['crop(s)'] || '').trim();
  const serviceNums = (kv.services || '')
    .replace(/[^\d,]/g, '')
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 9);
  const serviceLabels = serviceNums.map((n) => SERVICE_LIST[n - 1]).filter(Boolean);
  return { farmSize, crop, serviceNums, serviceLabels };
}

function getHelpMessage() {
  return (
    '\u{1F4D8} *Help*\n\n' +
    '• *1 Farmer* — Admin areas + *GPS link* for your farm pin\n' +
    '• *2 Provider* — Your rates & services, then *GPS link* for base location\n' +
    '• *3 Request* — Pick a service & size, then *GPS link* to confirm the job location\n' +
    '• *4 My Requests* — Your bookings / jobs\n' +
    '• *5* — This help\n' +
    '• *6 Unsubscribe* — Remove your Digilync registration (registered users)\n' +
    '• *7 Recap* — See your profile / farms and next actions (registered users)\n\n' +
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
        session.step === 'privacy_consent_new' ||
        session.step === 'unsubscribe_confirm' ||
        session.step === 'recap_options' ||
        session.step === 'add_farm_details' ||
        session.step === 'edit_farm_select' ||
        session.step === 'edit_farm_input')) ||
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

  if (session.step === 'unsubscribe_confirm' && existing) {
    return handleUnsubscribeConfirm(waFrom, existing, text);
  }

  if (session.step === 'recap_options' && existing && existing.type === 'farmer') {
    return handleRecapOptionsFlow(waFrom, existing, text, data);
  }

  if (session.step === 'add_farm_details' && existing && existing.type === 'farmer') {
    return handleAddFarmDetails(waFrom, existing, text, data);
  }

  if (session.step === 'edit_farm_select' && existing && existing.type === 'farmer') {
    return handleEditFarmSelect(waFrom, existing, text, data);
  }

  if (session.step === 'edit_farm_input' && existing && existing.type === 'farmer') {
    return handleEditFarmInput(waFrom, existing, text, data);
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
      return getFarmerAwaitGpsMessage(gpsUrl);
    }
    if (session.step === 'provider_await_gps_web' && t === '1' && data.gps_token && data.pending_provider) {
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token)}&role=provider`;
      return getProviderAwaitGpsWebMessage(gpsUrl);
    }
    if (session.step === 'request_await_gps_web' && t === '1' && data.request_gps_token) {
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.request_gps_token)}&purpose=request`;
      return (
        '\u{1F517} *Confirm location*\n\n' +
        `Open this link:\n${gpsUrl}\n\n` +
        'Reply *MENU* to cancel.'
      );
    }
    if (t === '2' && session.step === 'farmer_basic') {
      await updateSession(waFrom, { user_type: 'provider', step: 'provider_batched', data: {} });
      return 'Switched to *Service Provider* registration.\n\n' + getProviderBatchedMessage();
    }
    if (t === '1' && session.step === 'provider_batched') {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_basic', data: {} });
      return 'Switched to *Farmer* registration.\n\n' + getFarmerBasicMessage();
    }
    if (t === '2' && session.step === 'farmer_await_gps_web') {
      await updateSession(waFrom, { user_type: 'provider', step: 'provider_batched', data: {} });
      return 'Cancelled the farmer GPS step. Starting *Service Provider* registration.\n\n' + getProviderBatchedMessage();
    }
    if (t === '2' && session.step === 'provider_await_gps_web') {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_basic', data: {} });
      return 'Cancelled the provider GPS step. Starting *Farmer* registration.\n\n' + getFarmerBasicMessage();
    }
  }

  // Registered user: main-menu shortcuts only (do not steal 3–7 during request / provider-pick flows)
  if (existing && !inActiveFlow) {
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
      return getRequestInputMessage({
        farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha,
        farm_gps_lat: farm?.gps_lat,
        farm_gps_lng: farm?.gps_lng,
      });
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
        session.step.startsWith('request_'));
    if (!inOnboarding) {
      if (text === '1') {
        await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_basic', data: {} });
        return getFarmerBasicMessage();
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
      if (text === '6' || text === '7') {
        return 'That option is available after you register. Reply *1* (Farmer) or *2* (Provider), or *MENU*.';
      }
    }
  }

  // In-flow handlers
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

async function applyServiceRequestGpsFromWeb(waPhone, lat, lng) {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (Number.isNaN(latN) || Number.isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return { ok: false, error: 'invalid_coords' };
  }
  const phone = normalizePhone(waPhone);
  const digits = phoneDigits(phone);

  const existing = await findExistingUser(phone);
  if (!existing || existing.type !== 'farmer') {
    return { ok: false, error: 'bad_user' };
  }

  const client = await pool.connect();
  let session;
  let data;
  let serviceType;
  let farmSizeNum;
  let providers;

  try {
    await client.query('BEGIN');
    const sr = await client.query(
      `SELECT * FROM whatsapp_sessions WHERE wa_phone = $1 FOR UPDATE`,
      [phone]
    );
    session = sr.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'bad_step' };
    }
    data = parseSessionData(session.data);
    if (session.step === 'request_choose_provider') {
      await client.query('ROLLBACK');
      return { ok: true, already_completed: true };
    }
    if (session.step !== 'request_await_gps_web' || !data.request_pending) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'bad_step' };
    }

    const rp = data.request_pending;
    serviceType = rp.service_type;
    farmSizeNum = parseFloat(rp.farm_size_ha);
    providers = await findMatchingProviders(serviceType, latN, lngN);

    if (providers.length === 0) {
      await client.query(
        `INSERT INTO bookings (farmer_id, provider_id, service_type, status, farm_size_ha) VALUES ($1, NULL, $2, 'pending', $3) RETURNING id`,
        [existing.id, serviceType, farmSizeNum]
      );
      await client.query(
        `UPDATE whatsapp_sessions SET step = $2, data = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $1`,
        [phone, 'main_menu', '{}']
      );
      await client.query('COMMIT');
      try {
        await sendBrandedText(
          `whatsapp:${digits}`,
          '\u2705 *Request received!* No providers matched. Admin will assign one soon. Reply *MENU* for options.'
        );
      } catch (err) {
        console.error('applyServiceRequestGpsFromWeb no-match notify:', err);
      }
      return { ok: true, no_match: true };
    }

    const newData = {
      farmer_id: existing.id,
      service_type: serviceType,
      farm_size_ha: farmSizeNum,
      matched_providers: providers,
    };
    await client.query(
      `UPDATE whatsapp_sessions SET step = $2, data = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $1`,
      [phone, 'request_choose_provider', JSON.stringify(newData)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('applyServiceRequestGpsFromWeb transaction:', err);
    return { ok: false, error: 'db' };
  } finally {
    client.release();
  }

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
  try {
    await sendBrandedText(`whatsapp:${digits}`, msg);
  } catch (err) {
    console.error('applyServiceRequestGpsFromWeb provider list send:', err);
    return { ok: false, error: 'send_failed' };
  }
  return { ok: true };
}

async function handleFarmerFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  switch (session.step) {
    case 'farmer_basic': {
      const p = parseFarmerBasicForm(text);
      if (!p.fullName || !p.region || !p.division || !p.subdivision || !p.district) {
        return (
          'Please send all fields: Name, Region, Division, Subdivision, District.\n\n' +
          getFarmerBasicMessage()
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
            registration_flow: 'v2',
            full_name: p.fullName,
            region: p.region,
            division: p.division,
            subdivision: p.subdivision,
            district: p.district,
            farms: [],
          },
        },
      });
      return getFarmerAwaitGpsMessage(gpsUrl);
    }

    case 'farmer_await_gps_web': {
      const pending = data.pending_farmer;
      if (!pending || pending.registration_flow !== 'v2') {
        await updateSession(waFrom, { step: 'main_menu', data: {} });
        return getMainMenu(await findExistingUser(phone));
      }
      let latN = latitude != null ? parseFloat(latitude) : null;
      let lngN = longitude != null ? parseFloat(longitude) : null;
      if ((latN == null || lngN == null) && text) {
        const coordMatch = String(text).trim().match(/(-?\d+\.?\d*)\s*[,]\s*(-?\d+\.?\d*)/);
        if (coordMatch) {
          latN = parseFloat(coordMatch[1]);
          lngN = parseFloat(coordMatch[2]);
        }
      }
      if (latN != null && lngN != null) {
        const r = await applyFarmerGpsCapture(phone, latN, lngN);
        if (r.ok) return null;
        if (r.error === 'bad_step') {
          return 'Session expired. Reply *MENU* to start again.';
        }
        return 'We could not save your GPS. Try the link again or reply *MENU*.';
      }
      if (text.trim() === '1' && data.gps_token) {
        const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token)}`;
        return getFarmerAwaitGpsMessage(gpsUrl);
      }
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token || '')}`;
      return getFarmerAwaitGpsMessage(gpsUrl);
    }

    case 'farmer_farm_details': {
      const pending = data.pending_farmer;
      const draft = pending?.plot_draft;
      if (!draft || draft.gps_lat == null) {
        const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token || '')}`;
        return 'We need your farm GPS first.\n\n' + getFarmerAwaitGpsMessage(gpsUrl);
      }
      const b = parseFarmDetailsBatch(text);
      if (Number.isNaN(b.farmSize) || b.farmSize < 0 || !b.crop || b.serviceNums.length === 0) {
        return 'Please send farm size (number), crop(s), and services (numbers).\n\n' + getFarmerFarmDetailsMessage();
      }
      const draftFarm = {
        gps_lat: draft.gps_lat,
        gps_lng: draft.gps_lng,
        plot_size_ha: b.farmSize,
        crop_type: b.crop,
        service_labels: b.serviceLabels,
        other_services: null,
      };
      if (b.serviceNums.includes(9)) {
        await updateSession(waFrom, {
          step: 'farmer_other_spec',
          user_type: 'farmer',
          data: { ...data, pending_farmer: { ...pending, plot_draft: draftFarm } },
        });
        return getFarmerOtherServicesMessage();
      }
      const farms = [...(pending.farms || []), draftFarm];
      const next = { ...pending, farms, plot_draft: undefined };
      await updateSession(waFrom, { step: 'farmer_multi_prompt', user_type: 'farmer', data: { ...data, pending_farmer: next } });
      return getFarmerMultiFarmMessage();
    }

    case 'farmer_other_spec': {
      const more = text.trim();
      if (!more) return getFarmerOtherServicesMessage();
      const pending = data.pending_farmer;
      const d = pending.plot_draft;
      if (!d) {
        await updateSession(waFrom, { step: 'main_menu', data: {} });
        return getMainMenu(await findExistingUser(phone));
      }
      d.other_services = more;
      const farms = [...(pending.farms || []), d];
      const next = { ...pending, farms, plot_draft: undefined };
      await updateSession(waFrom, { step: 'farmer_multi_prompt', user_type: 'farmer', data: { ...data, pending_farmer: next } });
      return getFarmerMultiFarmMessage();
    }

    case 'farmer_multi_prompt': {
      const t = text.trim();
      if (t === '1') {
        const token = crypto.randomUUID();
        const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(token)}`;
        const pending = data.pending_farmer;
        await updateSession(waFrom, {
          step: 'farmer_await_gps_web',
          user_type: 'farmer',
          data: { ...data, gps_token: token, pending_farmer: { ...pending, plot_draft: undefined } },
        });
        return getFarmerAwaitGpsMessage(gpsUrl);
      }
      if (t === '2') {
        await updateSession(waFrom, { step: 'farmer_confirm_registration', user_type: 'farmer', data });
        return buildFarmerConfirmationMessage(data.pending_farmer);
      }
      return getFarmerMultiFarmMessage();
    }

    case 'farmer_confirm_registration': {
      if (text === '1' || text.toLowerCase() === 'confirm') {
        const r = await insertFarmerFullFromPending(phone, data.pending_farmer);
        if (r.ok) return null;
        if (r.error === 'duplicate') {
          return 'This WhatsApp number is already registered as a farmer. Reply *MENU* for options.';
        }
        return 'Registration could not be completed. Reply *MENU* to try again.';
      }
      if (text === '2' || text.toLowerCase() === 'edit') {
        await updateSession(waFrom, { step: 'farmer_basic', user_type: 'farmer', data: {} });
        return getFarmerBasicMessage();
      }
      return buildFarmerConfirmationMessage(data.pending_farmer);
    }

    default:
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu(await findExistingUser(phone));
  }
}

function getProviderBatchedMessage() {
  return (
    'Register as a Service Provider:\n\n' +
    'Name:\n' +
    'Service Radius (km):\n' +
    'Price per hectare (FCFA):\n' +
    'Work capacity (ha/day):\n\n' +
    'Select services offered (comma separated numbers):\n\n' +
    '1. Ploughing\n' +
    '2. Planting\n' +
    '3. Spraying\n' +
    '4. Irrigation\n' +
    '5. Harvesting\n' +
    '6. Processing\n' +
    '7. Storage\n' +
    '8. Transport\n' +
    '9. Other\n\n' +
    '*Example:*\n' +
    'Name: John\n' +
    'Radius: 10\n' +
    'Price: 12000\n' +
    'Capacity: 3\n' +
    'Services: 1,5\n\n' +
    'After you send this, you will get a *link* to set your base location on the map.'
  );
}

function getProviderAwaitGpsWebMessage(gpsUrl) {
  return (
    '\u{1F4CD} *Base location*\n\n' +
    'Open this link on your phone, turn on location, and save your base pin:\n\n' +
    `🔗 ${gpsUrl}\n\n` +
    'Reply *1* to resend the link.\n' +
    'Reply *MENU* to cancel.'
  );
}

/** True when this farm plot has a real pin we can use for matching (skip redundant web GPS step). */
function hasUsableFarmGps(lat, lng) {
  const la = lat != null ? parseFloat(lat) : NaN;
  const lo = lng != null ? parseFloat(lng) : NaN;
  if (Number.isNaN(la) || Number.isNaN(lo)) return false;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return false;
  if (la === 0 && lo === 0) return false;
  return true;
}

function getRequestInputMessage(data = {}) {
  const hasPresetFarm = data.farm_size_ha != null;
  const useSavedPin = hasUsableFarmGps(data.farm_gps_lat, data.farm_gps_lng);
  const followUp = useSavedPin
    ? 'After you send this, we use your *saved farm pin* to match nearby providers.'
    : 'After you send this, you will get a *link* to confirm the job location on the map.';
  let msg =
    '*Request a Service*\n\n' +
    'Select service (number):\n' +
    'Enter farm size:\n\n' +
    '*Example:*\n' +
    'Service: 1\n' +
    'Farm size: 2\n\n' +
    `${followUp}\n\n` +
    'Services:\n' +
    '1. Ploughing\n' +
    '2. Planting\n' +
    '3. Spraying\n' +
    '4. Irrigation\n' +
    '5. Harvesting\n' +
    '6. Processing\n' +
    '7. Storage\n' +
    '8. Transport\n' +
    '9. Other';
  if (hasPresetFarm) {
    msg =
      '*Request a Service*\n\n' +
      'Select service (number):\n\n' +
      `Farm size on file: ${data.farm_size_ha} ha\n\n` +
      '*Example:*\n' +
      'Service: 1\n\n' +
      `${followUp}\n\n` +
      'Services: 1–9 as in the main menu help.';
  }
  return msg;
}
async function handleRequestFlow(waFrom, session, data, text, latitude, longitude, existing) {
  if (!existing || existing.type !== 'farmer') {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return getMainMenu();
  }

  const phone = normalizePhone(waFrom);

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
      return getRequestInputMessage({
        farm_size_ha: selectedFarmSize,
        farm_gps_lat: farm.gps_lat,
        farm_gps_lng: farm.gps_lng,
      });
    }

    case 'request_input': {
      const kv = parseKeyValueBlock(text);
      const serviceNum = parseInt(kv.service || '', 10);
      const farmSizeRaw = parseFloat(kv.farm_size || '');
      const farmSize = !isNaN(farmSizeRaw) && farmSizeRaw >= 0 ? farmSizeRaw : (data.farm_size_ha != null ? parseFloat(data.farm_size_ha) : NaN);
      if (isNaN(serviceNum) || serviceNum < 1 || serviceNum > 9) return 'Please include *Service:* (1-9). Example: Service: 1';
      if (isNaN(farmSize) || farmSize < 0) return 'Please include *Farm size:* (ha). Example: Farm size: 2';
      const requestPending = {
        farmer_id: existing.id,
        farm_plot_id: data.farm_plot_id ?? null,
        service_type: SERVICE_LIST[serviceNum - 1],
        farm_size_ha: farmSize,
      };
      const farmLat = data.farm_gps_lat != null ? parseFloat(data.farm_gps_lat) : NaN;
      const farmLng = data.farm_gps_lng != null ? parseFloat(data.farm_gps_lng) : NaN;
      if (hasUsableFarmGps(farmLat, farmLng)) {
        await updateSession(waFrom, {
          step: 'request_await_gps_web',
          data: { request_pending: requestPending },
        });
        const r = await applyServiceRequestGpsFromWeb(phone, farmLat, farmLng);
        if (r.ok) return null;
        await updateSession(waFrom, {
          step: 'request_input',
          data: {
            farmer_id: existing.id,
            farm_plot_id: data.farm_plot_id ?? null,
            farm_size_ha: data.farm_size_ha,
            farm_gps_lat: data.farm_gps_lat,
            farm_gps_lng: data.farm_gps_lng,
          },
        });
        if (r.error === 'send_failed') {
          return 'We could not send the provider list. Reply *MENU* and try *3* again.';
        }
        return 'Something went wrong while matching providers. Reply *MENU* to try again.';
      }
      const token = crypto.randomUUID();
      const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(token)}&purpose=request`;
      await updateSession(waFrom, {
        step: 'request_await_gps_web',
        data: {
          request_gps_token: token,
          request_pending: requestPending,
        },
      });
      return (
        '\u{1F517} *Confirm location*\n\n' +
        `Open this link to drop the pin for this request:\n${gpsUrl}\n\n` +
        'Reply *1* to resend the link.\n' +
        'Reply *MENU* to cancel.'
      );
    }

    case 'request_await_gps_web': {
      if (text.trim() === '1' && data.request_gps_token) {
        const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.request_gps_token)}&purpose=request`;
        return (
          '\u{1F517} *Confirm location*\n\n' +
          `Open this link:\n${gpsUrl}\n\n` +
          'Reply *MENU* to cancel.'
        );
      }
      // Avoid spamming the same reminder on every stray message while the user opens the GPS page.
      const REMINDER_COOLDOWN_MS = 90_000;
      const last = typeof data._gps_link_reminder_at === 'number' ? data._gps_link_reminder_at : 0;
      const now = Date.now();
      if (now - last < REMINDER_COOLDOWN_MS) {
        return null;
      }
      await updateSession(waFrom, {
        step: 'request_await_gps_web',
        data: { ...data, _gps_link_reminder_at: now },
      });
      return 'Open the GPS link we sent, then return here. Reply *1* to resend. Reply *MENU* to cancel.';
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

async function handleProviderFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  if (session.step === 'provider_batched') {
    const kv = parseKeyValueBlock(text);
    const name = kv.name || kv.full_name;
    if (!name) return 'Please include *Name:* and the other fields.\n\n' + getProviderBatchedMessage();
    const radius = parseFloat(
      kv.radius || kv.service_radius || kv.service_radius_km || kv['service_radius_(km)'] || ''
    );
    const price = parseFloat(
      kv.price || kv.price_per_hectare || kv['price_per_hectare_(fcfa)'] || ''
    );
    const capacity = parseFloat(
      kv.capacity || kv.work_capacity || kv['work_capacity_(ha/day)'] || ''
    );
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
    return 'Profile received.\n\n' + getProviderAwaitGpsWebMessage(gpsUrl);
  }

  if (session.step === 'provider_await_gps_web') {
    const pending = data.pending_provider;
    if (!pending || !pending.name) {
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu(await findExistingUser(phone));
    }
    const gpsUrl = `${getFrontendBaseUrl()}/gps?t=${encodeURIComponent(data.gps_token || '')}&role=provider`;
    let gpsLat = null;
    let gpsLng = null;
    if (latitude != null && longitude != null) {
      gpsLat = parseFloat(latitude);
      gpsLng = parseFloat(longitude);
    }
    if (gpsLat != null && gpsLng != null) {
      if (gpsLat < -90 || gpsLat > 90 || gpsLng < -180 || gpsLng > 180) {
        return 'Invalid coordinates.\n\n' + getProviderAwaitGpsWebMessage(gpsUrl);
      }
      const r = await finalizeProviderRegistrationFromPendingGps(phone, pending, gpsLat, gpsLng, { source: 'whatsapp' });
      if (r.ok) return null;
      if (r.error === 'duplicate') {
        return 'This WhatsApp number is already registered as a provider. Reply *MENU* for options.';
      }
      return 'We could not save your location. Try the web link again or send *MENU*.';
    }
    if (text.trim() === '1' && data.gps_token) {
      return getProviderAwaitGpsWebMessage(gpsUrl);
    }
    return getProviderAwaitGpsWebMessage(gpsUrl);
  }

  await updateSession(waFrom, { step: 'main_menu', data: {} });
  return getMainMenu();
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
  const crop = kv.crop || kv.crops || kv.crop_type || '';
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

function getEditFarmSelectMessage(farms) {
  let msg = '*Which farm would you like to update?*\n\n';
  farms.forEach((farm, i) => {
    const loc = farm.location || farm.plot_name || '—';
    const crop = farm.crop_type || '—';
    const size = farm.plot_size_ha ?? farm.farm_size_ha ?? '—';
    msg += `${i + 1}. ${loc} – ${crop} – ${size} ha\n`;
  });
  msg += '\nReply with the number. Reply *MENU* to cancel.';
  return msg;
}

async function handleRecapOptionsFlow(waFrom, existing, text, data) {
  const t = text.trim();
  if (t === '1') {
    const farms = await getFarmerFarms(existing.id);
    if (farms.length === 0) {
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return 'No farm on file yet. Reply *MENU* for options.';
    }
    if (farms.length > 1) {
      await updateSession(waFrom, {
        step: 'request_select_farm',
        data: { farmer_id: existing.id, farms },
      });
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
    return getRequestInputMessage({
      farm_size_ha: farm?.plot_size_ha ?? farm?.farm_size_ha,
      farm_gps_lat: farm?.gps_lat,
      farm_gps_lng: farm?.gps_lng,
    });
  }
  if (t === '2') {
    const farms = data.farms?.length ? data.farms : await getFarmerFarms(existing.id);
    if (farms.length === 0) {
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return 'No farms to edit. Reply *MENU* for options.';
    }
    await updateSession(waFrom, {
      step: 'edit_farm_select',
      data: { farmer_id: existing.id, farms },
    });
    return getEditFarmSelectMessage(farms);
  }
  if (t === '3') {
    return handleAddAnotherFarm(waFrom, existing);
  }
  return (
    'Reply *1* to request a service, *2* to edit a farm, *3* to add a farm, or *MENU*.\n\n' +
    (await handleRecap(waFrom, existing, false))
  );
}

async function handleEditFarmSelect(waFrom, existing, text, data) {
  const farms = data.farms || [];
  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || num < 1 || num > farms.length) {
    return `Reply with a number from 1 to ${farms.length}.\n\n` + getEditFarmSelectMessage(farms);
  }
  const farm = farms[num - 1];
  await updateSession(waFrom, {
    step: 'edit_farm_input',
    data: {
      farmer_id: existing.id,
      farms,
      edit_farm_plot_id: farm.id,
      edit_farm_legacy: farm.id == null,
      edit_farm_index: num - 1,
    },
  });
  const size = farm.plot_size_ha ?? farm.farm_size_ha ?? '';
  const crop = farm.crop_type || '';
  return (
    `Update *Farm ${num}* (current: ${size} ha — ${crop})\n\n` +
    'Send in this format:\n\n' +
    'Farm size (hectares):\n' +
    'Crop(s):\n\n' +
    '*Example:*\n' +
    'Farm size: 3\n' +
    'Crop: Maize'
  );
}

async function handleEditFarmInput(waFrom, existing, text, data) {
  const kv = parseKeyValueBlock(text);
  const farmSize = parseFloat(kv.farm_size || kv.farm_size_hectares || '');
  const crop = (kv.crop || kv.crops || kv.crop_type || '').trim();
  if (isNaN(farmSize) || farmSize < 0 || !crop) {
    return (
      'Please send *Farm size:* and *Crop:* (both required).\n\n' +
      '*Example:*\n' +
      'Farm size: 3\n' +
      'Crop: Maize'
    );
  }
  try {
    if (data.edit_farm_legacy) {
      await pool.query('UPDATE farmers SET farm_size_ha = $1, crop_type = $2 WHERE id = $3', [
        farmSize,
        crop,
        existing.id,
      ]);
    } else {
      await pool.query(
        'UPDATE farm_plots SET plot_size_ha = $1, crop_type = $2 WHERE id = $3 AND farmer_id = $4',
        [farmSize, crop, data.edit_farm_plot_id, existing.id]
      );
    }
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return '\u2705 *Farm updated.*\n\n' + `${farmSize} ha — ${crop}\n\n` + 'Reply *MENU* for options.';
  } catch (err) {
    console.error('Edit farm error:', err);
    return 'Sorry, we could not update the farm. Try again or reply *MENU*.';
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
      return (
        'Your account has been successfully removed from Digilync.\n\n' +
        'Thank you for using our service.\n\n' +
        'You can start again anytime: reply *MENU* or *hi*.'
      );
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
  applyFarmerGpsCapture,
  applyServiceRequestGpsFromWeb,
  insertFarmerFullFromPending,
};
