const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');

// GET /api/providers/map-data - providers with GPS for admin map
router.get('/map-data', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, phone, services_offered, gps_lat, gps_lng, service_radius_km FROM providers WHERE gps_lat IS NOT NULL AND gps_lng IS NOT NULL'
    );
    res.json({ providers: result.rows });
  } catch (err) {
    console.error('Providers map data error:', err);
    res.status(500).json({ error: 'Failed to fetch providers map data' });
  }
});

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

function parseProviderBody(body) {
  const b = body || {};
  const num = (v) => (v != null && v !== '' ? parseFloat(v) : null);
  const int = (v) => (v != null && v !== '' ? parseInt(v, 10) : null);
  const bool = (v) => (v === true || v === 'true' || v === 'yes' || v === 1 ? true : v === false || v === 'false' || v === 'no' || v === 0 ? false : null);
  const str = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
  return {
    full_name: str(b.full_name) || '',
    phone: str(b.phone) || '',
    services_offered: str(b.services_offered),
    work_capacity_ha_per_hour: num(b.work_capacity_ha_per_hour),
    base_price_per_ha: num(b.base_price_per_ha),
    equipment_type: str(b.equipment_type),
    service_radius_km: num(b.service_radius_km),
    notes: str(b.notes),
    gps_lat: num(b.gps_lat),
    gps_lng: num(b.gps_lng),
    number_of_machines: int(b.number_of_machines),
    equipment_condition: str(b.equipment_condition),
    fuel_type: str(b.fuel_type),
    backup_equipment_available: bool(b.backup_equipment_available),
    years_operating: int(b.years_operating),
    willingness_to_travel: bool(b.willingness_to_travel),
    travel_surcharge_per_km: num(b.travel_surcharge_per_km),
    labour_provided: bool(b.labour_provided),
    number_of_workers: int(b.number_of_workers),
    skilled_vs_unskilled: str(b.skilled_vs_unskilled),
    ability_to_scale_large_farms: bool(b.ability_to_scale_large_farms),
    minimum_booking_size_ha: num(b.minimum_booking_size_ha),
    minimum_charge_ha: num(b.minimum_charge_ha),
    fuel_included: bool(b.fuel_included),
    advance_payment_percent: num(b.advance_payment_percent),
    accepted_payment_methods: str(b.accepted_payment_methods),
    cancellation_policy: str(b.cancellation_policy),
    days_available_per_week: int(b.days_available_per_week),
    peak_season_capacity: str(b.peak_season_capacity),
    required_booking_lead_time_days: int(b.required_booking_lead_time_days),
    national_id: str(b.national_id),
    equipment_ownership_proof: str(b.equipment_ownership_proof),
    reference_contact: str(b.reference_contact),
    consent_platform_rules: bool(b.consent_platform_rules),
    agreement_no_show_penalties: bool(b.agreement_no_show_penalties),
    on_time_completion_rate: num(b.on_time_completion_rate),
    job_success_rate: num(b.job_success_rate),
    dispute_frequency: int(b.dispute_frequency),
    repeat_client_percent: num(b.repeat_client_percent),
  };
}

router.post('/', async (req, res) => {
  const { full_name, phone, services } = req.body || {};
  if (!full_name || !phone) return res.status(400).json({ error: 'Full name and phone are required' });
  const p = parseProviderBody(req.body);
  const client = await pool.connect();
  try {
    const providerResult = await client.query(
      `INSERT INTO providers (full_name, phone, services_offered, work_capacity_ha_per_hour, base_price_per_ha, equipment_type, service_radius_km, notes,
        gps_lat, gps_lng, number_of_machines, equipment_condition, fuel_type, backup_equipment_available, years_operating,
        willingness_to_travel, travel_surcharge_per_km, labour_provided, number_of_workers, skilled_vs_unskilled, ability_to_scale_large_farms, minimum_booking_size_ha,
        minimum_charge_ha, fuel_included, advance_payment_percent, accepted_payment_methods, cancellation_policy,
        days_available_per_week, peak_season_capacity, required_booking_lead_time_days,
        national_id, equipment_ownership_proof, reference_contact, consent_platform_rules, agreement_no_show_penalties,
        on_time_completion_rate, job_success_rate, dispute_frequency, repeat_client_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40) RETURNING *`,
      [p.full_name, p.phone, p.services_offered, p.work_capacity_ha_per_hour, p.base_price_per_ha, p.equipment_type, p.service_radius_km, p.notes,
        p.gps_lat, p.gps_lng, p.number_of_machines, p.equipment_condition, p.fuel_type, p.backup_equipment_available, p.years_operating,
        p.willingness_to_travel, p.travel_surcharge_per_km, p.labour_provided, p.number_of_workers, p.skilled_vs_unskilled, p.ability_to_scale_large_farms, p.minimum_booking_size_ha,
        p.minimum_charge_ha, p.fuel_included, p.advance_payment_percent, p.accepted_payment_methods, p.cancellation_policy,
        p.days_available_per_week, p.peak_season_capacity, p.required_booking_lead_time_days,
        p.national_id, p.equipment_ownership_proof, p.reference_contact, p.consent_platform_rules, p.agreement_no_show_penalties,
        p.on_time_completion_rate, p.job_success_rate, p.dispute_frequency, p.repeat_client_percent]
    );
    const provider = providerResult.rows[0];
    if (Array.isArray(services) && services.length > 0) {
      for (const svc of services) {
        await insertProviderService(client, provider.id, svc);
      }
    }
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Provider created: ${provider.full_name} (ID ${provider.id})`, entityType: 'provider', entityId: provider.id });
    res.status(201).json(provider);
  } catch (err) {
    console.error('Provider create error:', err);
    res.status(500).json({ error: 'Failed to create provider' });
  } finally {
    client.release();
  }
});

// PATCH /api/providers/:id - partial update (e.g. GPS only from map drag)
router.patch('/:id', async (req, res) => {
  const { gps_lat, gps_lng } = req.body || {};
  if (gps_lat == null && gps_lng == null) return res.status(400).json({ error: 'At least one field required' });
  try {
    const updates = [];
    const params = [];
    let i = 1;
    if (gps_lat != null) { updates.push(`gps_lat = $${i++}`); params.push(parseFloat(gps_lat)); }
    if (gps_lng != null) { updates.push(`gps_lng = $${i++}`); params.push(parseFloat(gps_lng)); }
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE providers SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Provider patch error:', err);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

router.put('/:id', async (req, res) => {
  const { full_name, phone } = req.body || {};
  if (!full_name || !phone) return res.status(400).json({ error: 'Full name and phone are required' });
  const p = parseProviderBody(req.body);
  const client = await pool.connect();
  try {
    const providerResult = await client.query(
      `UPDATE providers SET full_name=$1, phone=$2, services_offered=$3, work_capacity_ha_per_hour=$4, base_price_per_ha=$5, equipment_type=$6, service_radius_km=$7, notes=$8,
        gps_lat=$9, gps_lng=$10, number_of_machines=$11, equipment_condition=$12, fuel_type=$13, backup_equipment_available=$14, years_operating=$15,
        willingness_to_travel=$16, travel_surcharge_per_km=$17, labour_provided=$18, number_of_workers=$19, skilled_vs_unskilled=$20, ability_to_scale_large_farms=$21, minimum_booking_size_ha=$22,
        minimum_charge_ha=$23, fuel_included=$24, advance_payment_percent=$25, accepted_payment_methods=$26, cancellation_policy=$27,
        days_available_per_week=$28, peak_season_capacity=$29, required_booking_lead_time_days=$30,
        national_id=$31, equipment_ownership_proof=$32, reference_contact=$33, consent_platform_rules=$34, agreement_no_show_penalties=$35,
        on_time_completion_rate=$36, job_success_rate=$37, dispute_frequency=$38, repeat_client_percent=$39,
        updated_at=CURRENT_TIMESTAMP WHERE id=$40 RETURNING *`,
      [p.full_name, p.phone, p.services_offered, p.work_capacity_ha_per_hour, p.base_price_per_ha, p.equipment_type, p.service_radius_km, p.notes,
        p.gps_lat, p.gps_lng, p.number_of_machines, p.equipment_condition, p.fuel_type, p.backup_equipment_available, p.years_operating,
        p.willingness_to_travel, p.travel_surcharge_per_km, p.labour_provided, p.number_of_workers, p.skilled_vs_unskilled, p.ability_to_scale_large_farms, p.minimum_booking_size_ha,
        p.minimum_charge_ha, p.fuel_included, p.advance_payment_percent, p.accepted_payment_methods, p.cancellation_policy,
        p.days_available_per_week, p.peak_season_capacity, p.required_booking_lead_time_days,
        p.national_id, p.equipment_ownership_proof, p.reference_contact, p.consent_platform_rules, p.agreement_no_show_penalties,
        p.on_time_completion_rate, p.job_success_rate, p.dispute_frequency, p.repeat_client_percent,
        req.params.id]
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

    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Provider profile updated: ${provider.full_name} (ID ${provider.id})`, entityType: 'provider', entityId: provider.id });
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
    const getResult = await pool.query('SELECT full_name FROM providers WHERE id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM providers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Provider not found' });
    const name = getResult.rows[0]?.full_name || 'Unknown';
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Provider deleted: ${name} (ID ${req.params.id})`, entityType: 'provider', entityId: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (err) {
    console.error('Provider delete error:', err);
    res.status(500).json({ error: 'Failed to delete provider' });
  }
});

module.exports = router;
