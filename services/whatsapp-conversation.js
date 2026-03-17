/**
 * DigiLync WhatsApp Bot – Structured Flow
 * Batched messaging, low cost, fast onboarding, structured data.
 */
const { pool } = require('../config/db');
const { sendText } = require('./whatsapp-sender');
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
      await sendText(provider.phone,
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

function getMainMenu(existing = null) {
  return (
    'Welcome to DigiLync 🌱\n\n' +
    'What would you like to do?\n\n' +
    '1. Register as Farmer\n' +
    '2. Register as Service Provider\n' +
    '3. Request a Service\n' +
    '4. My Requests\n' +
    '5. Help'
  );
}

function getHelpMessage() {
  return (
    '📘 *DigiLync Help*\n\n' +
    '• *Register* – Sign up as farmer or service provider\n' +
    '• *Request* – Order farm services (ploughing, spraying, etc.)\n' +
    '• *My Requests* – View your bookings\n\n' +
    'Reply *MENU* to go back.'
  );
}

async function handleIncoming(waFrom, body, latitude, longitude, profileName) {
  const phone = normalizePhone(waFrom);
  const text = (body || '').trim();
  const textLower = text.toLowerCase();
  const existing = await findExistingUser(phone);
  const session = await getSession(waFrom);
  const data = typeof session.data === 'object' ? session.data : (session.data ? JSON.parse(session.data) : {});

  // Main menu triggers
  if (['hi', 'hello', 'menu', 'start', '0', '5'].includes(textLower)) {
    if (textLower === '5') return getHelpMessage();
    return getMainMenu(existing);
  }

  // Registered user: handle menu options
  if (existing) {
    if (text === '4') return handleMyRequests(waFrom, existing);
    if (text === '5') return getHelpMessage();
    if (existing.type === 'farmer' && text === '3') {
      await updateSession(waFrom, { step: 'request_input', data: { farmer_id: existing.id } });
      return getRequestInputMessage();
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

  // Unregistered: handle menu
  if (!existing) {
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

function getFarmerBasicMessage() {
  return (
    'Welcome to DigiLync 🌱\n' +
    "Let's register your farm.\n\n" +
    'Please reply in this format:\n\n' +
    'Name:\n' +
    'Region:\n' +
    'Division:\n' +
    'Subdivision:\n' +
    'District:\n\n' +
    'Location:\n' +
    '1 = Send latitude, longitude\n' +
    '2 = Send in degrees and minutes\n' +
    '3 = Share location from phone\n\n' +
    '*Example:*\n' +
    'Name: John\n' +
    'Region: South West\n' +
    'Division: Meme\n' +
    'Subdivision: Kumba\n' +
    'District: Kumba 1\n' +
    'Location: 1'
  );
}

function parseKeyValueBlock(text) {
  const result = {};
  const lines = text.split(/\n/).map((l) => l.trim());
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
      result[key] = match[2].trim();
    }
  }
  return result;
}

async function handleFarmerFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  switch (session.step) {
    case 'farmer_basic': {
      const kv = parseKeyValueBlock(text);
      const name = kv.name || kv.full_name;
      const locationOpt = kv.location || '';
      if (!name) return 'Please include *Name:* in your reply. Example:\nName: John\nRegion: South West\n...';
      const locNum = parseInt(locationOpt, 10);
      if ([1, 2, 3].includes(locNum)) {
        await updateSession(waFrom, {
          step: locNum === 3 ? 'farmer_gps_share' : 'farmer_gps_coords',
          data: {
            full_name: name,
            region: kv.region || '',
            division: kv.division || '',
            subdivision: kv.subdivision || '',
            district: kv.district || '',
            location_opt: locNum,
          },
        });
        if (locNum === 3) {
          return 'Please *share your location* (tap 📍) to set your farm location.';
        }
        return 'Please enter your GPS coordinates:\n\nFormat: Latitude, Longitude\n\n*Example:*\n4.6382, 9.4469';
      }
      await updateSession(waFrom, {
        step: 'farmer_farm_details',
        data: {
          ...data,
          full_name: name,
          region: kv.region || '',
          division: kv.division || '',
          subdivision: kv.subdivision || '',
          district: kv.district || '',
          gps_lat: null,
          gps_lng: null,
        },
      });
      return getFarmerFarmDetailsMessage();
    }

    case 'farmer_gps_share':
      if (latitude != null && longitude != null) {
        await updateSession(waFrom, {
          step: 'farmer_farm_details',
          data: {
            ...data,
            gps_lat: parseFloat(latitude),
            gps_lng: parseFloat(longitude),
          },
        });
        return getFarmerFarmDetailsMessage();
      }
      return 'Please share your location (tap 📍) or reply *SKIP* to continue.';

    case 'farmer_gps_coords': {
      const match = text.match(/^(-?\d+\.?\d*)\s*[,]\s*(-?\d+\.?\d*)$/);
      if (!match) return 'Use format: Latitude, Longitude\nExample: 4.6382, 9.4469';
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return 'Invalid coordinates.';
      await updateSession(waFrom, {
        step: 'farmer_farm_details',
        data: { ...data, gps_lat: lat, gps_lng: lng },
      });
      return getFarmerFarmDetailsMessage();
    }

    case 'farmer_farm_details': {
      const kv = parseKeyValueBlock(text);
      const farmSize = parseFloat(kv.farm_size || kv.farm_size_hectares || '');
      const crop = kv.crop || kv.crops || '';
      const servicesRaw = kv.services || kv.service || '';
      if (isNaN(farmSize) || farmSize < 0) return 'Please include *Farm size:* (number). Example: Farm size: 2.5';
      const serviceNums = servicesRaw.replace(/[^\d,]/g, '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= 9);
      const services = serviceNums.map((n) => SERVICE_LIST[n - 1]).filter(Boolean);
      const hasOther = serviceNums.includes(9);
      await updateSession(waFrom, {
        step: hasOther ? 'farmer_other_services' : 'farmer_multi_farm',
        data: {
          ...data,
          farm_size_ha: farmSize,
          crop_type: crop || 'Not specified',
          services,
          service_nums: serviceNums,
        },
      });
      if (hasOther) return 'You selected "Other".\n\nPlease type additional service(s):\n*Example:*\nDrone spraying, Soil testing';
      return getFarmerMultiFarmMessage();
    }

    case 'farmer_other_services':
      const otherServices = text.trim();
      await updateSession(waFrom, {
        step: 'farmer_multi_farm',
        data: {
          ...data,
          services: [...(data.services || []), otherServices].filter(Boolean),
        },
      });
      return getFarmerMultiFarmMessage();

    case 'farmer_multi_farm':
      if (text === '1' || text.toLowerCase() === 'yes') {
        await updateSession(waFrom, { step: 'farmer_farm_details', data: { ...data, farms: [...(data.farms || []), { farm_size_ha: data.farm_size_ha, crop_type: data.crop_type, services: data.services }] } });
        return getFarmerFarmDetailsMessage();
      }
      if (text === '2' || text.toLowerCase() === 'no') {
        await updateSession(waFrom, { step: 'farmer_confirm', data: data });
        return getFarmerConfirmMessage(data);
      }
      return 'Reply *1* for Yes or *2* for No.';

    case 'farmer_confirm':
      if (text === '1' || text.toLowerCase() === 'confirm') {
        try {
          const village = [data.region, data.division, data.district].filter(Boolean).join(', ') || data.district || data.region || 'Not specified';
          const serviceNeeds = data.services && data.services.length ? data.services : [data.crop_type || 'General'];
          await pool.query(
            `INSERT INTO farmers (full_name, phone, region, division, subdivision, district, village, location, gps_lat, gps_lng, farm_size_ha, crop_type, service_needs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
            [
              data.full_name,
              phone,
              data.region || null,
              data.division || null,
              data.subdivision || null,
              data.district || null,
              village,
              village,
              data.gps_lat || null,
              data.gps_lng || null,
              data.farm_size_ha || null,
              data.crop_type || null,
              serviceNeeds,
            ]
          );
          await updateSession(waFrom, { step: 'main_menu', user_type: 'unknown', data: {} });
          return '✅ *Registration complete!* You are now a DigiLync farmer.\n\nReply *MENU* for options.';
        } catch (err) {
          console.error('Farmer registration error:', err);
          return 'Sorry, registration failed. Please try again.';
        }
      }
      if (text === '2' || text.toLowerCase() === 'edit') {
        await updateSession(waFrom, { step: 'farmer_basic', data: {} });
        return getFarmerBasicMessage();
      }
      return 'Reply *1* to Confirm or *2* to Edit.';

    default:
      await updateSession(waFrom, { step: 'main_menu', data: {} });
      return getMainMenu();
  }
}

function getFarmerFarmDetailsMessage() {
  return (
    'Now enter your farm details:\n\n' +
    'Farm size (hectares):\n' +
    'Crop(s):\n\n' +
    'Select services needed (reply with numbers separated by comma):\n\n' +
    '1. Ploughing\n2. Planting\n3. Spraying\n4. Irrigation\n5. Harvesting\n' +
    '6. Processing\n7. Storage\n8. Transport\n9. Other\n\n' +
    '*Example:*\n' +
    'Farm size: 2.5\n' +
    'Crop: Maize, Cassava\n' +
    'Services: 1,3,5'
  );
}

function getFarmerMultiFarmMessage() {
  return 'Do you have another farm?\n\n1. Yes\n2. No';
}

function getFarmerConfirmMessage(data) {
  const loc = data.gps_lat ? `${data.gps_lat}, ${data.gps_lng}` : 'Not set';
  return (
    'Please confirm your details:\n\n' +
    `Name: ${data.full_name}\n` +
    `Location: ${data.district || data.region || '—'}\n` +
    `Farm size: ${data.farm_size_ha} ha\n` +
    `Crop: ${data.crop_type || '—'}\n` +
    `Services: ${(data.services || []).join(', ') || '—'}\n` +
    `GPS: ${loc}\n\n` +
    '1. Confirm\n2. Edit'
  );
}

function getProviderBatchedMessage() {
  return (
    'Register as a Service Provider:\n\n' +
    'Name:\n' +
    'Base Location (GPS or share pin):\n' +
    'Service Radius (km):\n' +
    'Price per hectare (FCFA):\n' +
    'Work capacity (ha/day):\n\n' +
    'Select services offered (comma separated):\n\n' +
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

async function handleProviderFlow(waFrom, session, data, text, latitude, longitude) {
  const phone = normalizePhone(waFrom);

  if (session.step === 'provider_batched') {
    const kv = parseKeyValueBlock(text);
    const name = kv.name || kv.full_name;
    if (!name) return 'Please include *Name:* in your reply.';
    const radius = parseFloat(kv.radius || kv.service_radius || '');
    const price = parseFloat(kv.price || kv.price_per_hectare || '');
    const capacity = parseFloat(kv.capacity || kv.work_capacity || '');
    if (isNaN(radius) || radius < 0) return 'Please include *Radius:* (km). Example: Radius: 10';
    if (isNaN(price) || price < 0) return 'Please include *Price:* (FCFA/ha). Example: Price: 12000';
    const serviceNums = (kv.services || '').replace(/[^\d,]/g, '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= 9);
    const services = serviceNums.map((n) => SERVICE_LIST[n - 1]).filter(Boolean);
    let gpsLat = data.gps_lat;
    let gpsLng = data.gps_lng;
    if (latitude != null && longitude != null) {
      gpsLat = parseFloat(latitude);
      gpsLng = parseFloat(longitude);
    } else {
      const coordMatch = (kv.base_location || kv.location || text).match(/(-?\d+\.?\d*)\s*[,]\s*(-?\d+\.?\d*)/);
      if (coordMatch) {
        gpsLat = parseFloat(coordMatch[1]);
        gpsLng = parseFloat(coordMatch[2]);
      }
    }
    const haPerHour = isNaN(capacity) ? null : capacity / 8;
    try {
      await pool.query(
        `INSERT INTO providers (full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, service_radius_km, gps_lat, gps_lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [name, phone, (services.length ? services : ['General']).join(', '), haPerHour, price, radius, gpsLat || null, gpsLng || null]
      );
      await updateSession(waFrom, { step: 'main_menu', user_type: 'unknown', data: {} });
      return '✅ *Registration complete!* You are now a DigiLync service provider.\n\nReply *MENU* for options.';
    } catch (err) {
      console.error('Provider registration error:', err);
      return 'Sorry, registration failed. Please try again.';
    }
  }

  await updateSession(waFrom, { step: 'main_menu', data: {} });
  return getMainMenu();
}

function getRequestInputMessage() {
  return (
    '*Request a Service*\n\n' +
    'Select service (number):\n' +
    'Enter farm size:\n' +
    'Confirm location:\n\n' +
    '*Example:*\n' +
    'Service: 1\n' +
    'Farm size: 2\n' +
    'Location: share pin\n\n' +
    'Services: 1.Ploughing 2.Planting 3.Spraying 4.Irrigation 5.Harvesting 6.Processing 7.Storage 8.Transport'
  );
}

async function handleRequestFlow(waFrom, session, data, text, latitude, longitude, existing) {
  if (!existing || existing.type !== 'farmer') {
    await updateSession(waFrom, { step: 'main_menu', data: {} });
    return getMainMenu();
  }

  switch (session.step) {
    case 'request_input': {
      const kv = parseKeyValueBlock(text);
      const serviceNum = parseInt(kv.service || '', 10);
      const farmSize = parseFloat(kv.farm_size || '');
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
      let gpsLat = data.gps_lat;
      let gpsLng = data.gps_lng;
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
      await sendText(b.farmer_phone, `✅ *Booking confirmed!*\n\nProvider *${existing.name}* has accepted your request.\nService: ${b.service_type}\n\nReply *MENU* for options.`);
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
};
