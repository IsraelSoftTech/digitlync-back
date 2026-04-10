/**
 * Public endpoints: complete farmer or provider registration after GPS capture on web app.
 * POST /api/public/farmer-register-gps
 * POST /api/public/provider-register-gps
 * WhatsApp GPS links use FRONTEND_URL (see app CORS) so /gps matches your deployed site.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const {
  finalizeFarmerRegistrationFromPendingGps,
  finalizeProviderRegistrationFromPendingGps,
} = require('../services/whatsapp-conversation');

router.post('/farmer-register-gps', async (req, res) => {
  const { token, gps_lat, gps_lng, consent } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }
  if (gps_lat == null || gps_lng == null) {
    return res.status(400).json({ error: 'gps_lat and gps_lng are required' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'You must consent to save your farm location before continuing.' });
  }

  const lat = parseFloat(gps_lat);
  const lng = parseFloat(gps_lng);
  if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const sess = await pool.query(
      `SELECT wa_phone, data FROM whatsapp_sessions WHERE data->>'gps_token' = $1 LIMIT 1`,
      [token.trim()]
    );
    if (sess.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired link. Start registration again from WhatsApp.' });
    }

    const waPhone = sess.rows[0].wa_phone;
    const raw = sess.rows[0].data;
    const data = typeof raw === 'object' && raw !== null ? raw : JSON.parse(raw || '{}');
    const pending = data.pending_farmer;
    if (!pending || !pending.full_name) {
      return res.status(400).json({ error: 'Session expired. Start registration again from WhatsApp.' });
    }

    const result = await finalizeFarmerRegistrationFromPendingGps(waPhone, pending, lat, lng, { source: 'web' });
    if (!result.ok) {
      if (result.error === 'duplicate') {
        return res.status(409).json({ error: 'This WhatsApp number is already registered as a farmer.' });
      }
      return res.status(500).json({ error: 'Could not save registration. Please try again.' });
    }

    res.json({ success: true, farmer_id: result.farmer_id });
  } catch (err) {
    console.error('farmer-register-gps error:', err);
    res.status(500).json({ error: 'Could not save registration. Please try again.' });
  }
});

/** Provider registration — same session token shape as farmer but pending_provider + role=provider on /gps */
router.post('/provider-register-gps', async (req, res) => {
  const { token, gps_lat, gps_lng, consent } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }
  if (gps_lat == null || gps_lng == null) {
    return res.status(400).json({ error: 'gps_lat and gps_lng are required' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'You must consent to save your base location before continuing.' });
  }

  const lat = parseFloat(gps_lat);
  const lng = parseFloat(gps_lng);
  if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const sess = await pool.query(
      `SELECT wa_phone, data FROM whatsapp_sessions WHERE data->>'gps_token' = $1 LIMIT 1`,
      [token.trim()]
    );
    if (sess.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired link. Start registration again from WhatsApp.' });
    }

    const waPhone = sess.rows[0].wa_phone;
    const raw = sess.rows[0].data;
    const data = typeof raw === 'object' && raw !== null ? raw : JSON.parse(raw || '{}');
    const pending = data.pending_provider;
    if (!pending || !pending.name) {
      return res.status(400).json({ error: 'Session expired. Start registration again from WhatsApp.' });
    }

    const result = await finalizeProviderRegistrationFromPendingGps(waPhone, pending, lat, lng, { source: 'web' });
    if (!result.ok) {
      if (result.error === 'duplicate') {
        return res.status(409).json({ error: 'This WhatsApp number is already registered as a provider.' });
      }
      return res.status(500).json({ error: 'Could not save registration. Please try again.' });
    }

    res.json({ success: true, provider_id: result.provider_id });
  } catch (err) {
    console.error('provider-register-gps error:', err);
    res.status(500).json({ error: 'Could not save registration. Please try again.' });
  }
});

module.exports = router;
