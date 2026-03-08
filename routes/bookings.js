const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');
const { sendText, isEnabled } = require('../services/whatsapp-sender');

router.get('/', async (req, res) => {
  const { status, unassigned } = req.query;
  try {
    let query = `
      SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, p.full_name AS provider_name, p.phone AS provider_phone
      FROM bookings b
      LEFT JOIN farmers f ON b.farmer_id = f.id
      LEFT JOIN providers p ON b.provider_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ` AND b.status = $${params.length}`;
    }
    if (unassigned === '1' || unassigned === 'true') {
      query += ' AND b.provider_id IS NULL';
    }
    query += ' ORDER BY b.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error('Bookings list error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, f.village AS farmer_village, f.district AS farmer_district,
        p.full_name AS provider_name, p.phone AS provider_phone, p.services_offered
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Booking get error:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

router.post('/', async (req, res) => {
  const { farmer_id, provider_id, service_type, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes } = req.body || {};
  if (!farmer_id) return res.status(400).json({ error: 'Farmer is required' });
  try {
    const result = await pool.query(
      `INSERT INTO bookings (farmer_id, provider_id, service_type, status, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8) RETURNING *`,
      [farmer_id, provider_id || null, service_type?.trim() || null, scheduled_date || null, scheduled_time || null, farm_size_ha != null ? parseFloat(farm_size_ha) : null, farm_produce_type?.trim() || null, notes?.trim() || null]
    );
    const booking = result.rows[0];
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking created: farmer ${farmer_id} → provider ${provider_id || 'unassigned'} (ID ${booking.id})`, entityType: 'booking', entityId: booking.id });
    res.status(201).json(booking);
  } catch (err) {
    console.error('Booking create error:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

router.put('/:id', async (req, res) => {
  const { status, scheduled_date, scheduled_time, farm_size_ha, farm_produce_type, notes, provider_id } = req.body || {};
  try {
    const prevResult = await pool.query(
      `SELECT b.*, f.full_name AS farmer_name, f.phone AS farmer_phone, p.full_name AS provider_name, p.phone AS provider_phone
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (prevResult.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const prev = prevResult.rows[0];

    const newProviderId = provider_id !== undefined ? (provider_id || null) : prev.provider_id;
    const result = await pool.query(
      `UPDATE bookings SET status=COALESCE($1, status), scheduled_date=COALESCE($2, scheduled_date),
        scheduled_time=COALESCE($3, scheduled_time), farm_size_ha=COALESCE($4, farm_size_ha),
        farm_produce_type=COALESCE($5, farm_produce_type), notes=COALESCE($6, notes),
        provider_id=$7, updated_at=CURRENT_TIMESTAMP
       WHERE id=$8 RETURNING *`,
      [status || null, scheduled_date || null, scheduled_time || null, farm_size_ha != null ? parseFloat(farm_size_ha) : null, farm_produce_type !== undefined ? farm_produce_type : null, notes !== undefined ? notes : null, newProviderId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const booking = result.rows[0];

    const { adminId, adminUsername } = getAdminFromRequest(req);
    let auditMsg = status ? ` status changed to ${status}` : ' updated';
    if (provider_id != null && !prev.provider_id && booking.provider_id) {
      auditMsg = ` provider assigned (ID ${provider_id})`;
      if (isEnabled()) {
        const p = await pool.query(`SELECT full_name, phone FROM providers WHERE id = $1`, [provider_id]);
        const f = await pool.query(`SELECT full_name, phone FROM farmers WHERE id = $1`, [booking.farmer_id]);
        const providerName = p.rows[0]?.full_name || 'Provider';
        if (p.rows.length > 0 && p.rows[0].phone) {
          try {
            await sendText(p.rows[0].phone,
              `🔔 *New job request*\n\n` +
              `Farmer: ${f.rows[0]?.full_name || prev.farmer_name}\n` +
              `Service: ${booking.service_type}\n` +
              `Size: ${booking.farm_size_ha || '—'} ha\n` +
              `Date: ${booking.scheduled_date || 'TBD'}\n\n` +
              `Reply *ACCEPT ${booking.id}* to accept or *REJECT ${booking.id}* to decline.`
            );
          } catch (e) {
            console.error('[Bookings] WhatsApp notify provider failed:', e);
          }
        }
        if (f.rows.length > 0 && f.rows[0].phone) {
          try {
            await sendText(f.rows[0].phone,
              `✅ *Provider assigned!*\n\n` +
              `*${providerName}* has been assigned to your *${booking.service_type}* request.\n\n` +
              `They will confirm shortly. Reply *MENU* for options.`
            );
          } catch (e) {
            console.error('[Bookings] WhatsApp notify farmer failed:', e);
          }
        }
      }
    }
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking${auditMsg} (ID ${booking.id})`, entityType: 'booking', entityId: booking.id });
    res.json(booking);
  } catch (err) {
    console.error('Booking update error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'booking', action: `Booking deleted (ID ${req.params.id})`, entityType: 'booking', entityId: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (err) {
    console.error('Booking delete error:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

module.exports = router;
