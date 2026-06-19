const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');
const { sendBrandedText } = require('../services/whatsapp-sender');
const { ensureOperationalSchema } = require('../services/operational-core');

// Simple HTML portals returned for farmer/provider confirmations.
router.get('/farmer', async (req, res) => {
  const token = String(req.query.t || req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing token');
  try {
    await ensureOperationalSchema();
    const q = await pool.query('SELECT booking_id, used, expires_at FROM booking_confirmation_tokens WHERE token = $1', [token]);
    if (q.rows.length === 0) return res.status(404).send('Invalid token');
    const row = q.rows[0];
    if (row.used) return res.send('<h3>This link has already been used.</h3>');
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.send('<h3>Link expired.</h3>');
    const br = await pool.query(
      `SELECT b.id, b.service_type, b.farmer_id, f.full_name AS farmer_name, b.provider_id, p.full_name AS provider_name
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [row.booking_id]
    );
    if (br.rows.length === 0) return res.status(404).send('Booking not found');
    const booking = br.rows[0];
    const html = `
      <html><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <body style="font-family:Arial,Helvetica,sans-serif;padding:16px;">
      <h2>Confirm Work</h2>
      <p>Booking #${booking.id} — Provider: <strong>${booking.provider_name || 'Unassigned'}</strong></p>
      <form method="POST" action="/api/booking-portals/farmer/submit">
        <input type="hidden" name="token" value="${token}" />
        <label for="decision">Decision</label>
        <select id="decision" name="decision">
          <option value="confirm">Confirm</option>
          <option value="reject">Reject</option>
        </select>
        <div style="margin-top:12px;"><button type="submit">Submit</button></div>
      </form>
      </body></html>`;
    res.send(html);
  } catch (err) {
    console.error('farmer portal error:', err);
    res.status(500).send('Server error');
  }
});

// JSON info for frontend apps
router.get('/json/info', async (req, res) => {
  const token = String(req.query.t || req.query.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });
  try {
    await ensureOperationalSchema();
    const q = await pool.query('SELECT id, booking_id, role, used, expires_at FROM booking_confirmation_tokens WHERE token = $1', [token]);
    if (q.rows.length === 0) return res.status(404).json({ ok: false, error: 'invalid_token' });
    const row = q.rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'expired' });
    const br = await pool.query(
      `SELECT b.id, b.service_type, b.farmer_id, f.full_name AS farmer_name, b.provider_id, p.full_name AS provider_name, b.status
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [row.booking_id]
    );
    if (br.rows.length === 0) return res.status(404).json({ ok: false, error: 'booking_not_found' });
    return res.json({ ok: true, token: token, role: row.role, used: row.used, booking: br.rows[0] });
  } catch (err) {
    console.error('json info error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/farmer/submit', express.urlencoded({ extended: true }), async (req, res) => {
  const token = String(req.body.token || '').trim();
  const decision = String(req.body.decision || '').trim();
  if (!token || !decision) return res.status(400).send('Missing token or decision');
  try {
    await ensureOperationalSchema();
    const tQ = await pool.query('SELECT * FROM booking_confirmation_tokens WHERE token = $1 FOR UPDATE', [token]);
    if (tQ.rows.length === 0) return res.status(404).send('Invalid token');
    const t = tQ.rows[0];
    if (t.used) return res.send('<h3>This link has already been used.</h3>');
    if (t.expires_at && new Date(t.expires_at) < new Date()) return res.send('<h3>Link expired.</h3>');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const br = await client.query('SELECT id, status, farmer_id, provider_id FROM bookings WHERE id = $1 FOR UPDATE', [t.booking_id]);
      if (br.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('Booking not found');
      }
      const booking = br.rows[0];
      if (decision === 'confirm') {
        await client.query(`UPDATE bookings SET status = 'completed', completion_verified_at = CURRENT_TIMESTAMP WHERE id = $1`, [booking.id]);
        // Ensure booking_payments exists (held state)
        await client.query(`INSERT INTO booking_payments (booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status, created_at, updated_at)
          VALUES ($1, 0, 0, 0, 'held', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (booking_id) DO NOTHING`, [booking.id]);
        await client.query(
          `INSERT INTO booking_job_events (booking_id, actor_type, event_type, note) VALUES ($1, 'farmer', 'confirmed', 'Farmer confirmed via portal')`,
          [booking.id]
        );
      } else {
        await client.query(`UPDATE bookings SET status = 'disputed' WHERE id = $1`, [booking.id]);
        await client.query(`INSERT INTO booking_job_events (booking_id, actor_type, event_type, note) VALUES ($1, 'farmer', 'rejected', 'Farmer rejected via portal')`, [booking.id]);
      }

      await client.query(`UPDATE booking_confirmation_tokens SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1`, [t.id]);

      // If confirmed, notify provider with link to submit payout
      if (decision === 'confirm' && booking.provider_id) {
        const prov = await client.query('SELECT phone, full_name FROM providers WHERE id = $1', [booking.provider_id]);
        if (prov.rows.length > 0) {
          const provider = prov.rows[0];
          const providerToken = crypto.randomUUID();
          await client.query(
            `INSERT INTO booking_confirmation_tokens (token, booking_id, role, expires_at) VALUES ($1, $2, 'provider', (CURRENT_TIMESTAMP + INTERVAL '7 days'))`,
            [providerToken, booking.id]
          );
          const link = `${process.env.FRONTEND_URL || ''}/provider-payout?t=${encodeURIComponent(providerToken)}`;
          try {
            await sendBrandedText(provider.phone, `✅ Your service has been confirmed by the farmer. Please provide your payout method here: ${link}`);
          } catch (e) {
            console.error('Failed to notify provider portal link:', e.message);
          }
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    res.send('<h3>Thank you — your decision has been submitted. Admin will review and process payment.</h3>');
  } catch (err) {
    console.error('farmer submit portal error:', err);
    res.status(500).send('Server error');
  }
});

// JSON farmer submit (for SPA)
router.post('/json/farmer/submit', express.json(), async (req, res) => {
  const token = String(req.body.token || '').trim();
  const decision = String(req.body.decision || '').trim();
  if (!token || !decision) return res.status(400).json({ ok: false, error: 'missing_fields' });
  try {
    await ensureOperationalSchema();
    const tQ = await pool.query('SELECT * FROM booking_confirmation_tokens WHERE token = $1 FOR UPDATE', [token]);
    if (tQ.rows.length === 0) return res.status(404).json({ ok: false, error: 'invalid_token' });
    const t = tQ.rows[0];
    if (t.used) return res.status(409).json({ ok: false, error: 'already_used' });
    if (t.expires_at && new Date(t.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'expired' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const br = await client.query('SELECT id, status, farmer_id, provider_id FROM bookings WHERE id = $1 FOR UPDATE', [t.booking_id]);
      if (br.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'booking_not_found' });
      }
      const booking = br.rows[0];
      if (decision === 'confirm') {
        await client.query(
          `INSERT INTO booking_job_events (booking_id, actor_type, event_type, note) VALUES ($1, 'farmer', 'confirmed', 'Farmer confirmed via portal')`,
          [booking.id]
        );
      } else {
        await client.query(`UPDATE bookings SET status = 'disputed' WHERE id = $1`, [booking.id]);
        await client.query(
          `INSERT INTO booking_job_events (booking_id, actor_type, event_type, note) VALUES ($1, 'farmer', 'rejected', 'Farmer rejected via portal')`,
          [booking.id]
        );
      }

      await client.query(`UPDATE booking_confirmation_tokens SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1`, [t.id]);
      await client.query('COMMIT');

      if (decision === 'confirm') {
        try {
          const { confirmWorkAndReleasePayment } = require('../services/matching-flow');
          await confirmWorkAndReleasePayment(booking.id, booking.farmer_id);
        } catch (releaseErr) {
          console.error('Portal confirm work release error:', releaseErr.message);
        }
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('json farmer submit error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/provider', async (req, res) => {
  const token = String(req.query.t || req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing token');
  try {
    await ensureOperationalSchema();
    const q = await pool.query('SELECT booking_id, used, expires_at FROM booking_confirmation_tokens WHERE token = $1', [token]);
    if (q.rows.length === 0) return res.status(404).send('Invalid token');
    const row = q.rows[0];
    if (row.used) return res.send('<h3>This link has already been used.</h3>');
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.send('<h3>Link expired.</h3>');
    const br = await pool.query(
      `SELECT b.id, b.service_type, b.farmer_id, f.full_name AS farmer_name, b.provider_id, p.full_name AS provider_name
       FROM bookings b
       LEFT JOIN farmers f ON b.farmer_id = f.id
       LEFT JOIN providers p ON b.provider_id = p.id
       WHERE b.id = $1`,
      [row.booking_id]
    );
    if (br.rows.length === 0) return res.status(404).send('Booking not found');
    const booking = br.rows[0];
    const html = `
      <html><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <body style="font-family:Arial,Helvetica,sans-serif;padding:16px;">
      <h2>Provide Payout Details</h2>
      <p>Booking #${booking.id} — Farmer: <strong>${booking.farmer_name || '—'}</strong></p>
      <form method="POST" action="/api/booking-portals/provider/submit">
        <input type="hidden" name="token" value="${token}" />
        <label for="method">Payment method</label>
        <select id="method" name="method">
          <option value="mtn_momo">MTN Momo</option>
          <option value="orange_money">Orange Money</option>
        </select>
        <div style="margin-top:8px;"><label for="number">Phone number (include country code)</label><br/>
        <input id="number" name="number" placeholder="+2376xxxxxxx" /></div>
        <div style="margin-top:12px;"><button type="submit">Submit</button></div>
      </form>
      </body></html>`;
    res.send(html);
  } catch (err) {
    console.error('provider portal get error:', err);
    res.status(500).send('Server error');
  }
});

router.post('/provider/submit', express.urlencoded({ extended: true }), async (req, res) => {
  const token = String(req.body.token || '').trim();
  const method = String(req.body.method || '').trim();
  const number = String(req.body.number || '').trim();
  if (!token || !method || !number) return res.status(400).send('Missing fields');
  try {
    await ensureOperationalSchema();
    const tQ = await pool.query('SELECT * FROM booking_confirmation_tokens WHERE token = $1 FOR UPDATE', [token]);
    if (tQ.rows.length === 0) return res.status(404).send('Invalid token');
    const t = tQ.rows[0];
    if (t.used) return res.send('<h3>This link has already been used.</h3>');
    if (t.expires_at && new Date(t.expires_at) < new Date()) return res.send('<h3>Link expired.</h3>');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const br = await client.query('SELECT id, provider_id FROM bookings WHERE id = $1 FOR UPDATE', [t.booking_id]);
      if (br.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('Booking not found');
      }
      const booking = br.rows[0];
      // Upsert booking_payments with payout info
      await client.query(
        `INSERT INTO booking_payments (booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status, payout_method, payout_reference, created_at, updated_at)
         VALUES ($1, 0, 0, 0, 'held', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (booking_id) DO UPDATE SET payout_method = EXCLUDED.payout_method, payout_reference = EXCLUDED.payout_reference, updated_at = CURRENT_TIMESTAMP`,
        [booking.id, method, number.replace(/\D/g, '')]
      );

      await client.query(`UPDATE booking_confirmation_tokens SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1`, [t.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
    res.send('<h3>Thanks — your payout details have been submitted. Admin will review and release payment.</h3>');
  } catch (err) {
    console.error('provider submit portal error:', err);
    res.status(500).send('Server error');
  }
});

// JSON provider submit (for SPA)
router.post('/json/provider/submit', express.json(), async (req, res) => {
  const token = String(req.body.token || '').trim();
  const method = String(req.body.method || '').trim();
  const number = String(req.body.number || '').trim();
  if (!token || !method || !number) return res.status(400).json({ ok: false, error: 'missing_fields' });
  try {
    await ensureOperationalSchema();
    const tQ = await pool.query('SELECT * FROM booking_confirmation_tokens WHERE token = $1 FOR UPDATE', [token]);
    if (tQ.rows.length === 0) return res.status(404).json({ ok: false, error: 'invalid_token' });
    const t = tQ.rows[0];
    if (t.used) return res.status(409).json({ ok: false, error: 'already_used' });
    if (t.expires_at && new Date(t.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'expired' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const br = await client.query('SELECT id, provider_id FROM bookings WHERE id = $1 FOR UPDATE', [t.booking_id]);
      if (br.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'booking_not_found' });
      }
      const booking = br.rows[0];
      await client.query(
        `INSERT INTO booking_payments (booking_id, escrow_amount_fcfa, provider_amount_fcfa, platform_fee_amount_fcfa, payment_status, payout_method, payout_reference, created_at, updated_at)
         VALUES ($1, 0, 0, 0, 'held', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (booking_id) DO UPDATE SET payout_method = EXCLUDED.payout_method, payout_reference = EXCLUDED.payout_reference, updated_at = CURRENT_TIMESTAMP`,
        [booking.id, method, number.replace(/\D/g, '')]
      );

      await client.query(`UPDATE booking_confirmation_tokens SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1`, [t.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('json provider submit error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
