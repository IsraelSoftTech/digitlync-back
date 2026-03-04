/**
 * WhatsApp conversation flow for DigiLync
 * Handles registration (farmer/provider), REQUEST, JOBS, reminders, ratings per SRS.
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

/** Find providers matching a service type (simple ILIKE on services_offered) */
async function findMatchingProviders(serviceType) {
  const r = await pool.query(
    `SELECT id, full_name, phone, services_offered, base_price_per_ha, service_radius_km
     FROM providers
     WHERE services_offered ILIKE $1
     ORDER BY id ASC
     LIMIT 10`,
    ['%' + (serviceType || '').trim() + '%']
  );
  return r.rows;
}

/** Get provider's pending/confirmed bookings */
async function getProviderBookings(providerId) {
  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, b.scheduled_time, b.farm_size_ha, b.status,
        f.full_name AS farmer_name, f.phone AS farmer_phone, f.village
     FROM bookings b
     JOIN farmers f ON b.farmer_id = f.id
     WHERE b.provider_id = $1 AND b.status IN ('pending', 'confirmed')
     ORDER BY b.scheduled_date ASC NULLS LAST, b.id DESC`,
    [providerId]
  );
  return r.rows;
}

/** Get farmer's completed bookings awaiting rating */
async function getFarmerBookingsAwaitingRating(farmerId) {
  const r = await pool.query(
    `SELECT b.id, b.service_type, b.scheduled_date, p.full_name AS provider_name
     FROM bookings b
     JOIN providers p ON b.provider_id = p.id
     LEFT JOIN farmer_ratings fr ON fr.booking_id = b.id
     WHERE b.farmer_id = $1 AND b.status = 'completed' AND fr.id IS NULL
     ORDER BY b.scheduled_date DESC
     LIMIT 5`,
    [farmerId]
  );
  return r.rows;
}

/** Main message handler - returns response text (or null if no reply needed) */
async function handleIncoming(waFrom, body, latitude, longitude, profileName) {
  const phone = normalizePhone(waFrom);
  const text = (body || '').trim();
  const textLower = text.toLowerCase();
  const existing = await findExistingUser(phone);

  // Already registered: show main menu or handle flows
  if (existing) {
    return handleMainMenu(waFrom, phone, text, textLower, existing);
  }

  const session = await getSession(waFrom);
  const data = typeof session.data === 'object' ? session.data : (session.data ? JSON.parse(session.data) : {});

  // Welcome / choose type
  if (session.step === 'welcome' || !session.step) {
    if (['1', 'farmer', 'farm'].includes(textLower)) {
      await updateSession(waFrom, { user_type: 'farmer', step: 'farmer_name', data: {} });
      return 'Welcome! You are registering as a *Farmer*.\n\nPlease send your *full name*:';
    }
    if (['2', 'provider', 'service'].includes(textLower)) {
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

async function handleMainMenu(waFrom, phone, text, textLower, existing) {
  const name = existing.name || 'there';

  if (['hi', 'hello', 'menu', 'start', '0'].includes(textLower)) {
    let msg = `Hello ${name}! 👋\n\n`;
    if (existing.type === 'farmer') {
      msg += '• Reply *REQUEST* – Request a farm service\n';
      msg += '• Reply *CONFIRM* – Mark a service as complete\n';
      msg += '• Reply *PROFILE* – View your profile';
      const awaiting = await getFarmerBookingsAwaitingRating(existing.id);
      if (awaiting.length > 0) {
        msg += '\n• Reply *RATE* – Rate a completed service';
      }
    } else {
      msg += '• Reply *JOBS* – View available jobs\n';
      msg += '• Reply *PROFILE* – View your profile';
    }
    return msg;
  }

  if (textLower === 'request' && existing.type === 'farmer') {
    await updateSession(waFrom, { step: 'request_service', data: { farmer_id: existing.id } });
    return (
      '📋 *Request a service*\n\n' +
      'What service do you need? Examples:\n' +
      '• Plowing\n• Harrowing\n• Planting\n• Spraying\n• Harvesting\n• Threshing\n• Transport\n• Labour\n• Irrigation'
    );
  }

  if (textLower === 'jobs' && existing.type === 'provider') {
    return handleProviderJobs(waFrom, existing);
  }

  if (textLower === 'rate' && existing.type === 'farmer') {
    return handleFarmerRatingPrompt(waFrom, existing);
  }

  if (['confirm', 'done', 'complete'].includes(textLower) && existing.type === 'farmer') {
    return handleFarmerConfirmCompletion(waFrom, existing);
  }

  if (textLower === 'profile') {
    return `You are registered as a *${existing.type}*. Use the admin dashboard to view full profile.`;
  }

  // Check if farmer is in request flow
  const session = await getSession(waFrom);
  const data = typeof session.data === 'object' ? session.data : (session.data ? JSON.parse(session.data) : {});
  if (existing.type === 'farmer' && session.step && session.step.startsWith('request_')) {
    return handleFarmerRequestStep(waFrom, session, data, text, existing);
  }

  // Check if provider is responding to job (ACCEPT 1, REJECT 1)
  if (existing.type === 'provider') {
    const acceptMatch = text.match(/^accept\s*(\d+)$/i);
    const rejectMatch = text.match(/^reject\s*(\d+)$/i);
    if (acceptMatch) return handleProviderAcceptJob(waFrom, existing, parseInt(acceptMatch[1], 10));
    if (rejectMatch) return handleProviderRejectJob(waFrom, existing, parseInt(rejectMatch[1], 10));
  }

  // Check if farmer is in rating flow
  if (existing.type === 'farmer' && session.step === 'rating_booking') {
    return handleFarmerRatingStep(waFrom, session, data, text, existing);
  }

  return `Reply *MENU* for options, or *REQUEST* / *JOBS* for services.`;
}

async function handleFarmerRequestStep(waFrom, session, data, text, existing) {
  switch (session.step) {
    case 'request_service':
      if (!text.trim()) return 'Please send the service type you need (e.g. Plowing, Spraying).';
      await updateSession(waFrom, { step: 'request_size', data: { ...data, service_type: text.trim() } });
      return 'What is your *farm size* in hectares? (e.g. 2.5)';

    case 'request_size': {
      const ha = parseFloat(text);
      if (isNaN(ha) || ha < 0) return 'Please enter a valid number (e.g. 2.5).';
      await updateSession(waFrom, { step: 'request_date', data: { ...data, farm_size_ha: ha } });
      return 'What is your *preferred date*? Reply in format YYYY-MM-DD (e.g. 2025-03-15)';
    }

    case 'request_date': {
      const dateStr = text.trim();
      const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dateMatch) return 'Please use format YYYY-MM-DD (e.g. 2025-03-15).';
      const d = new Date(dateStr);
      if (isNaN(d.getTime()) || d < new Date()) return 'Please enter a valid future date.';
      await updateSession(waFrom, { step: 'request_confirm', data: { ...data, scheduled_date: dateStr } });
      return (
        '📋 *Confirm your request:*\n\n' +
        `Service: ${data.service_type}\n` +
        `Farm size: ${data.farm_size_ha} ha\n` +
        `Date: ${dateStr}\n\n` +
        'Reply *YES* to submit or *NO* to cancel.'
      );
    }

    case 'request_confirm':
      if (['yes', 'y'].includes(text.toLowerCase())) {
        const providers = await findMatchingProviders(data.service_type);
        if (providers.length === 0) {
          await updateSession(waFrom, { step: 'welcome', data: {} });
          return (
            'No providers available for *' + data.service_type + '* at the moment.\n\n' +
            'An admin will contact you. You can also reply *MENU* for options.'
          );
        }
        const provider = providers[0];
        try {
          const ins = await pool.query(
            `INSERT INTO bookings (farmer_id, provider_id, service_type, status, scheduled_date, farm_size_ha)
             VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING id`,
            [existing.id, provider.id, data.service_type, data.scheduled_date, data.farm_size_ha]
          );
          const bookingId = ins.rows[0].id;
          await updateSession(waFrom, { step: 'welcome', data: {} });
          try {
            await sendText(provider.phone,
              `🔔 *New job request*\n\n` +
              `Farmer: ${existing.name}\n` +
              `Service: ${data.service_type}\n` +
              `Size: ${data.farm_size_ha} ha\n` +
              `Date: ${data.scheduled_date}\n\n` +
              `Reply *ACCEPT ${bookingId}* to accept or *REJECT ${bookingId}* to decline.`
            );
          } catch (e) {
            console.error('WhatsApp notify provider failed:', e);
          }
          return (
            '✅ *Request submitted!*\n\n' +
            `Provider *${provider.full_name}* has been notified. They will confirm shortly.\n\n` +
            'Reply *MENU* for options.'
          );
        } catch (err) {
          console.error('Booking create error:', err);
          return 'Sorry, the request could not be submitted. Please try again or contact support.';
        }
      }
      if (['no', 'n'].includes(text.toLowerCase())) {
        await updateSession(waFrom, { step: 'welcome', data: {} });
        return 'Request cancelled. Reply *MENU* for options.';
      }
      return 'Reply *YES* to submit or *NO* to cancel.';

    default:
      await updateSession(waFrom, { step: 'welcome' });
      return 'Reply *REQUEST* to request a service.';
  }
}

async function handleProviderJobs(waFrom, existing) {
  const jobs = await getProviderBookings(existing.id);
  if (jobs.length === 0) {
    return 'You have no pending or confirmed jobs at the moment. Check back later!';
  }
  let msg = '📋 *Your jobs:*\n\n';
  jobs.forEach((j, i) => {
    const dateStr = j.scheduled_date ? new Date(j.scheduled_date).toLocaleDateString() : 'TBD';
    msg += `${i + 1}. *${j.service_type || 'Service'}* – ${j.farmer_name} (${dateStr}) [${j.status}]\n`;
    msg += `   Reply *ACCEPT ${j.id}* or *REJECT ${j.id}*\n\n`;
  });
  return msg;
}

async function handleProviderAcceptJob(waFrom, existing, bookingId) {
  try {
    const r = await pool.query(
      `UPDATE bookings SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND provider_id = $2 AND status = 'pending' RETURNING *, (SELECT phone FROM farmers WHERE id = bookings.farmer_id) AS farmer_phone`,
      [bookingId, existing.id]
    );
    if (r.rows.length === 0) {
      return 'Job not found or already processed. Reply *JOBS* to see your jobs.';
    }
    const b = r.rows[0];
    try {
      await sendText(b.farmer_phone,
        `✅ *Booking confirmed!*\n\n` +
        `Provider *${existing.name}* has accepted your request.\n` +
        `Service: ${b.service_type}\n` +
        `Date: ${b.scheduled_date || 'TBD'}\n\n` +
        'You will receive a reminder before the scheduled date.'
      );
    } catch (e) {
      console.error('WhatsApp notify farmer failed:', e);
    }
    return '✅ Job accepted! The farmer has been notified. Reply *JOBS* to see your jobs.';
  } catch (err) {
    console.error('Accept job error:', err);
    return 'Something went wrong. Reply *JOBS* to try again.';
  }
}

async function handleProviderRejectJob(waFrom, existing, bookingId) {
  try {
    const r = await pool.query(
      `UPDATE bookings SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND provider_id = $2 AND status = 'pending' RETURNING id`,
      [bookingId, existing.id]
    );
    if (r.rows.length === 0) {
      return 'Job not found or already processed. Reply *JOBS* to see your jobs.';
    }
    return 'Job declined. Reply *JOBS* to see other jobs.';
  } catch (err) {
    console.error('Reject job error:', err);
    return 'Something went wrong. Reply *JOBS* to try again.';
  }
}

async function handleFarmerConfirmCompletion(waFrom, existing) {
  const r = await pool.query(
    `SELECT b.id, b.service_type, p.full_name AS provider_name
     FROM bookings b
     JOIN providers p ON b.provider_id = p.id
     WHERE b.farmer_id = $1 AND b.status = 'confirmed'
     ORDER BY b.scheduled_date DESC NULLS LAST
     LIMIT 1`,
    [existing.id]
  );
  if (r.rows.length === 0) {
    return 'No confirmed booking to complete. Reply *MENU* for options.';
  }
  const b = r.rows[0];
  await pool.query(`UPDATE bookings SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [b.id]);
  await updateSession(waFrom, { step: 'rating_booking', data: { booking_id: b.id, provider_name: b.provider_name } });
  return (
    `✅ *Service marked complete!* Thank you.\n\n` +
    `How was your experience with *${b.provider_name}* (${b.service_type})?\n\n` +
    'Reply with a number from *1* to *5* to rate:\n' +
    '1 = Poor, 2 = Fair, 3 = Good, 4 = Very Good, 5 = Excellent'
  );
}

async function handleFarmerRatingPrompt(waFrom, existing) {
  const awaiting = await getFarmerBookingsAwaitingRating(existing.id);
  if (awaiting.length === 0) {
    return 'You have no completed services to rate. Reply *MENU* for options.';
  }
  const b = awaiting[0];
  await updateSession(waFrom, { step: 'rating_booking', data: { booking_id: b.id, provider_name: b.provider_name } });
  return (
    `Rate your completed service with *${b.provider_name}* (${b.service_type}):\n\n` +
    'Reply with a number from *1* to *5*:\n' +
    '1 = Poor, 2 = Fair, 3 = Good, 4 = Very Good, 5 = Excellent'
  );
}

async function handleFarmerRatingStep(waFrom, session, data, text, existing) {
  const rating = parseInt(text.trim(), 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    return 'Please reply with a number from 1 to 5.';
  }
  try {
    const r = await pool.query(
      `SELECT b.provider_id FROM bookings b WHERE b.id = $1 AND b.farmer_id = $2 AND b.status = 'completed'`,
      [data.booking_id, existing.id]
    );
    if (r.rows.length === 0) {
      await updateSession(waFrom, { step: 'welcome', data: {} });
      return 'Booking not found. Reply *MENU* for options.';
    }
    const providerId = r.rows[0].provider_id;
    await pool.query(
      `INSERT INTO farmer_ratings (booking_id, farmer_id, provider_id, rating)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id) DO UPDATE SET rating = $4`,
      [data.booking_id, existing.id, providerId, rating]
    );
    await updateSession(waFrom, { step: 'welcome', data: {} });
    return '✅ Thank you for your rating! Reply *MENU* for options.';
  } catch (err) {
    console.error('Rating error:', err);
    return 'Sorry, the rating could not be saved. Please try again.';
  }
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
      if (text.toLowerCase() === 'skip') {
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
      if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'y') {
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
      if (text.toLowerCase() === 'no' || text.toLowerCase() === 'n') {
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
      if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'y') {
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
      if (text.toLowerCase() === 'no' || text.toLowerCase() === 'n') {
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
