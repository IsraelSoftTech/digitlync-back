const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/', async (req, res) => {
  const { search } = req.query;
  try {
    let query = 'SELECT * FROM providers WHERE 1=1';
    const params = [];
    if (search) {
      query += ' AND (full_name ILIKE $1 OR phone ILIKE $1 OR services_offered ILIKE $1)';
      params.push(`%${search}%`);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ providers: result.rows });
  } catch (err) {
    console.error('Providers list error:', err);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    const provider = providerResult.rows[0];

    try {
      const servicesResult = await pool.query(
        `SELECT ps.*, (
          SELECT COALESCE(json_agg(json_build_object('id', pse.id, 'equipment_name', pse.equipment_name)), '[]'::json)
          FROM provider_service_equipment pse WHERE pse.provider_service_id = ps.id
        ) AS equipment
        FROM provider_services ps WHERE ps.provider_id = $1 ORDER BY ps.id`,
        [req.params.id]
      );
      provider.services = servicesResult.rows.map((s) => ({
        ...s,
        equipment: s.equipment && s.equipment.length ? s.equipment : [],
      }));
    } catch (e) {
      provider.services = [];
    }
    res.json(provider);
  } catch (err) {
    console.error('Provider get error:', err);
    res.status(500).json({ error: 'Failed to fetch provider' });
  }
});

router.post('/', async (req, res) => {
  const { full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, equipment_type, service_radius_km, notes, services } = req.body || {};
  if (!full_name || !phone) return res.status(400).json({ error: 'Full name and phone are required' });
  const client = await pool.connect();
  try {
    const providerResult = await client.query(
      `INSERT INTO providers (full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, equipment_type, service_radius_km, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [full_name.trim(), phone.trim(), services_offered?.trim() || null, work_capacity_ha_per_hour != null ? parseFloat(work_capacity_ha_per_hour) : null, base_price_per_ha != null ? parseFloat(base_price_per_ha) : null, equipment_type?.trim() || null, service_radius_km != null ? parseFloat(service_radius_km) : null, notes?.trim() || null]
    );
    const provider = providerResult.rows[0];
    if (Array.isArray(services) && services.length > 0) {
      for (const svc of services) {
        await insertProviderService(client, provider.id, svc);
      }
    }
    res.status(201).json(provider);
  } catch (err) {
    console.error('Provider create error:', err);
    res.status(500).json({ error: 'Failed to create provider' });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  const { full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, equipment_type, service_radius_km, notes, services } = req.body || {};
  if (!full_name || !phone) return res.status(400).json({ error: 'Full name and phone are required' });
  const client = await pool.connect();
  try {
    const providerResult = await client.query(
      `UPDATE providers SET full_name=$1, phone=$2, services_offered=$3, work_capacity_ha_per_hour=$4, base_price_per_ha=$5, equipment_type=$6, service_radius_km=$7, notes=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$9 RETURNING *`,
      [full_name.trim(), phone.trim(), services_offered?.trim() || null, work_capacity_ha_per_hour != null ? parseFloat(work_capacity_ha_per_hour) : null, base_price_per_ha != null ? parseFloat(base_price_per_ha) : null, equipment_type?.trim() || null, service_radius_km != null ? parseFloat(service_radius_km) : null, notes?.trim() || null, req.params.id]
    );
    if (providerResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Provider not found' });
    }
    const provider = providerResult.rows[0];

    if (Array.isArray(services)) {
      await client.query('DELETE FROM provider_services WHERE provider_id = $1', [req.params.id]);
      for (const svc of services) {
        if (svc && svc.service_name) {
          await insertProviderService(client, req.params.id, svc);
        }
      }
    }

    client.release();
    res.json(provider);
  } catch (err) {
    client.release();
    console.error('Provider update error:', err);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

async function insertProviderService(client, providerId, svc) {
  const { service_name, work_capacity_ha_per_hour, base_price_per_ha, country, region, division, subdivision, district, equipment } = svc;
  const svcResult = await client.query(
    `INSERT INTO provider_services (provider_id, service_name, work_capacity_ha_per_hour, base_price_per_ha, country, region, division, subdivision, district)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [providerId, service_name?.trim() || '', work_capacity_ha_per_hour != null ? parseFloat(work_capacity_ha_per_hour) : null, base_price_per_ha != null ? parseFloat(base_price_per_ha) : null, country?.trim() || null, region?.trim() || null, division?.trim() || null, subdivision?.trim() || null, district?.trim() || null]
  );
  const svcId = svcResult.rows[0].id;
  const equipList = Array.isArray(equipment) ? equipment : [];
  for (const eq of equipList) {
    const name = typeof eq === 'string' ? eq : eq?.equipment_name;
    if (name && name.trim()) {
      await client.query('INSERT INTO provider_service_equipment (provider_service_id, equipment_name) VALUES ($1, $2)', [svcId, name.trim()]);
    }
  }
}

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM providers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Provider delete error:', err);
    res.status(500).json({ error: 'Failed to delete provider' });
  }
});

module.exports = router;
