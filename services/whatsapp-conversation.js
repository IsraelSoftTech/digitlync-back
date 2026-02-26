/**
 * WhatsApp conversation flow for DigiLync
 * Handles registration (farmer/provider) and main menu per SRS.
 */
const { pool } = require('../config/db');
const { sendText } = require('./whatsapp-sender');

/** Normalize phone: strip whatsapp: prefix, ensure + */
function normalizePhone(waFrom) {
  if (!waFrom) return '';
  const s = String(waFrom).replace(/^whatsapp:/i, '').trim();
  return s.startsWith('+') ? s : `+${s}`;
}

/** Get or create session */
async function getSession(waPhone) {
  const phone = normalizePhone(waPhone);
  const r = await pool.query(
    `SELECT * FROM whatsapp_sessions WHERE wa_phone = $1`,
    [phone]
  );
  if (r.rows.length > 0) return r.rows[0];

  await pool.query(
    `INSERT INTO whatsapp_sessions (wa_phone, user_type, step, data) VALUES ($1, 'unknown', 'welcome', '{}') ON CONFLICT (wa_phone) DO NOTHING`,
    [phone]
  );
  const r2 = await pool.query(`SELECT * FROM whatsapp_sessions WHERE wa_phone = $1`, [phone]);
  return r2.rows[0] || { wa_phone: phone, user_type: 'unknown', step: 'welcome', data: {} };
}

/** Update session */
async function updateSession(waPhone, updates) {
  const phone = normalizePhone(waPhone);
  const { user_type, step, data } = updates;
  const dataJson = typeof data === 'object' ? JSON.stringify(data) : (data || '{}');
  await pool.query(
    `UPDATE whatsapp_sessions SET user_type = COALESCE($1, user_type), step = COALESCE($2, step), data = COALESCE($3::jsonb, data), updated_at = CURRENT_TIMESTAMP WHERE wa_phone = $4`,
    [user_type || null, step || null, dataJson, phone]
  );
}

/** Digits-only for phone matching */
function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Check if user is already registered */
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

/** Main message handler - returns response text (or null if no reply needed) */
async function handleIncoming(waFrom, body, latitude, longitude, profileName) {
  const phone = normalizePhone(waFrom);
  const text = (body || '').trim().toLowerCase();
  const existing = await findExistingUser(phone);

  // Already registered: show main menu
  if (existing) {
    return handleMainMenu(phone, text, existing);
  }

  const session = await getSession(waFrom);
  const data = typeof session.data === 'object' ? session.data : (session.data ? JSON.parse(session.data) : {});

  // Welcome / choose type
  if (session.step === 'welcome' || !session.step) {
    if (['1', 'farmer', 'farm'].includes(text)) {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_name', data: {} });
      return 'Welcome! You are registering as a *Farmer*.\n\nPlease send your *full name*:';
    }
    if (['2', 'provider', 'service'].includes(text)) {
      await updateSession(waFrom, { user_type: 'provider', step: 'provider_name', data: {} });
      return 'Welcome! You are registering as a *Service Provider*.\n\nPlease send your *full name*:';
    }
    return (
      '🌾 *Welcome to DigiLync!*\n\n' +
      'Connect farmers with farm service providers.\n\n' +
      'Are you a *Farmer* or a *Provider*?\n' +
      'Reply:\n• *1* – Farmer (I need farm services)\n• *2* – Provider (I offer farm services)'
    );
  }

  // Farmer registration flow (Layer 1 - Basic Identity)
  if (session.user_type === 'farmer') {
    return handleFarmerStep(waFrom, session, data, text, latitude, longitude, profileName);
  }

  // Provider registration flow (Layer 1)
  if (session.user_type === 'provider') {
    return handleProviderStep(waFrom, session, data, text, profileName);
  }

  return 'Reply *1* for Farmer or *2* for Provider to get started.';
}

function handleMainMenu(phone, text, existing) {
  const name = existing.name || 'there';
  if (['hi', 'hello', 'menu', 'start', '0'].includes(text)) {
    let msg = `Hello ${name}! 👋\n\n`;
    if (existing.type === 'farmer') {
      msg += '• Reply *REQUEST* – Request a farm service\n';
      msg += '• Reply *PROFILE* – View your profile';
    } else {
      msg += '• Reply *JOBS* – View available jobs\n';
      msg += '• Reply *PROFILE* – View your profile';
    }
    return msg;
  }
  if (text === 'request' && existing.type === 'farmer') {
    return 'Service request will be available soon. For now, contact an admin to book a service.';
  }
  if (text === 'jobs' && existing.type === 'provider') {
    return 'Available jobs will appear here. Check back soon!';
  }
  if (text === 'profile') {
    return `You are registered as a *${existing.type}*. Use the admin dashboard to view full profile.`;
  }
  return `Reply *MENU* for options, or *REQUEST* / *JOBS* for services.`;
}

async function handleFarmerStep(waFrom, session, data, text, latitude, longitude, profileName) {
  const phone = normalizePhone(waFrom);

  switch (session.step) {
    case 'farmer_name':
      if (!text) return 'Please send your full name.';
      await updateSession(waFrom, { step: 'farmer_village', data: { ...data, full_name: text } });
      return 'Thanks! What is your *village or location*?';

    case 'farmer_village':
      await updateSession(waFrom, { step: 'farmer_farm_size', data: { ...data, village: text || 'Not specified' } });
      return 'What is your *farm size* in hectares? (e.g. 2.5)';

    case 'farmer_farm_size':
      const ha = parseFloat(text);
      if (isNaN(ha) || ha < 0) {
        return 'Please enter a valid number for farm size (e.g. 2.5).';
      }
      await updateSession(waFrom, { step: 'farmer_crop', data: { ...data, farm_size_ha: ha } });
      return 'What *crop type* do you grow? (e.g. maize, cocoa, cassava)';

    case 'farmer_crop':
      await updateSession(waFrom, { step: 'farmer_location_optional', data: { ...data, crop_type: text } });
      return (
        'Almost done! You can *share your location* now (tap 📍) for GPS mapping, or reply *SKIP* to continue.'
      );

    case 'farmer_location_optional':
      let gpsLat = data.gps_lat;
      let gpsLng = data.gps_lng;
      if (text === 'skip') {
        // User chose to skip location
      } else if (latitude != null && longitude != null) {
        gpsLat = parseFloat(latitude);
        gpsLng = parseFloat(longitude);
      } else if (!text) {
        return 'Share your location (tap 📍) or reply *SKIP* to continue.';
      }
      const finalData = { ...data, gps_lat: gpsLat, gps_lng: gpsLng };
      await updateSession(waFrom, { step: 'farmer_confirm', data: finalData });
      return (
        '📋 *Confirm your registration:*\n\n' +
        `Name: ${finalData.full_name}\n` +
        `Village: ${finalData.village}\n` +
        `Farm size: ${finalData.farm_size_ha} ha\n` +
        `Crop: ${finalData.crop_type}\n` +
        (gpsLat ? `Location: ${gpsLat}, ${gpsLng}\n` : '') +
        '\nReply *YES* to register or *NO* to cancel.'
      );

    case 'farmer_confirm':
      if (text === 'yes' || text === 'y') {
        try {
          await pool.query(
            `INSERT INTO farmers (full_name, phone, village, location, gps_lat, gps_lng, farm_size_ha, crop_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              data.full_name,
              phone,
              data.village || null,
              data.village || null,
              data.gps_lat || null,
              data.gps_lng || null,
              data.farm_size_ha || null,
              data.crop_type || null,
            ]
          );
          await updateSession(waFrom, { step: 'welcome', user_type: 'unknown', data: {} });
          return (
            '✅ *Registration complete!* You are now a DigiLync farmer.\n\n' +
            'Reply *REQUEST* to request a farm service, or *MENU* for options.'
          );
        } catch (err) {
          console.error('Farmer registration error:', err);
          return 'Sorry, registration failed. Please try again or contact support.';
        }
      }
      if (text === 'no' || text === 'n') {
        await updateSession(waFrom, { step: 'welcome', user_type: 'unknown', data: {} });
        return 'Registration cancelled. Reply *1* for Farmer or *2* for Provider to start again.';
      }
      return 'Reply *YES* to register or *NO* to cancel.';

    default:
      await updateSession(waFrom, { step: 'welcome' });
      return 'Reply *1* for Farmer or *2* for Provider to get started.';
  }
}

async function handleProviderStep(waFrom, session, data, text, profileName) {
  const phone = normalizePhone(waFrom);

  switch (session.step) {
    case 'provider_name':
      if (!text) return 'Please send your full name.';
      await updateSession(waFrom, { step: 'provider_services', data: { ...data, full_name: text } });
      return 'What *services* do you offer? (e.g. plowing, spraying, harvesting)';

    case 'provider_services':
      await updateSession(waFrom, { step: 'provider_capacity', data: { ...data, services_offered: text } });
      return 'What is your *work capacity* in hectares per hour? (e.g. 1.5)';

    case 'provider_capacity':
      const cap = parseFloat(text);
      if (isNaN(cap) || cap < 0) return 'Please enter a valid number (e.g. 1.5).';
      await updateSession(waFrom, { step: 'provider_price', data: { ...data, work_capacity_ha_per_hour: cap } });
      return 'What is your *base price per hectare* (in FCFA)? (e.g. 15000)';

    case 'provider_price':
      const price = parseFloat(text);
      if (isNaN(price) || price < 0) return 'Please enter a valid price (e.g. 15000).';
      await updateSession(waFrom, { step: 'provider_equipment', data: { ...data, base_price_per_ha: price } });
      return 'What *equipment* do you use? (e.g. tractor, sprayer)';

    case 'provider_equipment':
      await updateSession(waFrom, { step: 'provider_radius', data: { ...data, equipment_type: text } });
      return 'What is your *service radius* in km? (e.g. 50)';

    case 'provider_radius':
      const radius = parseFloat(text);
      if (isNaN(radius) || radius < 0) return 'Please enter a valid number (e.g. 50).';
      const provData = { ...data, service_radius_km: radius };
      await updateSession(waFrom, { step: 'provider_confirm', data: provData });
      return (
        '📋 *Confirm your registration:*\n\n' +
        `Name: ${provData.full_name}\n` +
        `Services: ${provData.services_offered}\n` +
        `Capacity: ${provData.work_capacity_ha_per_hour} ha/hr\n` +
        `Price: ${provData.base_price_per_ha} FCFA/ha\n` +
        `Equipment: ${provData.equipment_type}\n` +
        `Radius: ${provData.service_radius_km} km\n\n` +
        'Reply *YES* to register or *NO* to cancel.'
      );

    case 'provider_confirm':
      if (text === 'yes' || text === 'y') {
        try {
          await pool.query(
            `INSERT INTO providers (full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, equipment_type, service_radius_km)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              data.full_name,
              phone,
              data.services_offered || null,
              data.work_capacity_ha_per_hour || null,
              data.base_price_per_ha || null,
              data.equipment_type || null,
              data.service_radius_km || null,
            ]
          );
          await updateSession(waFrom, { step: 'welcome', user_type: 'unknown', data: {} });
          return (
            '✅ *Registration complete!* You are now a DigiLync service provider.\n\n' +
            'Reply *JOBS* to see available jobs, or *MENU* for options.'
          );
        } catch (err) {
          console.error('Provider registration error:', err);
          return 'Sorry, registration failed. Please try again or contact support.';
        }
      }
      if (text === 'no' || text === 'n') {
        await updateSession(waFrom, { step: 'welcome', user_type: 'unknown', data: {} });
        return 'Registration cancelled. Reply *1* for Farmer or *2* for Provider to start again.';
      }
      return 'Reply *YES* to register or *NO* to cancel.';

    default:
      await updateSession(waFrom, { step: 'welcome' });
      return 'Reply *1* for Farmer or *2* for Provider to get started.';
  }
}

module.exports = {
  handleIncoming,
  normalizePhone,
  getSession,
  updateSession,
};
