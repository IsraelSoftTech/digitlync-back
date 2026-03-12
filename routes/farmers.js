const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');

// GET /api/farmers/map-data - farmers + farm_plots for admin map (multiple plots supported)
router.get('/map-data', async (req, res) => {
  try {
    const farmersRes = await pool.query('SELECT id, full_name, village, region, district, gps_lat, gps_lng, crop_type, phone FROM farmers');
    let plotsRes = { rows: [] };
    try {
      plotsRes = await pool.query('SELECT id, farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type FROM farm_plots');
    } catch (_) {
      // farm_plots table may not exist yet
    }
    res.json({ farmers: farmersRes.rows, plots: plotsRes.rows });
  } catch (err) {
    console.error('Map data error:', err);
    res.status(500).json({ error: 'Failed to fetch map data' });
  }
});

// GET /api/farmers - list all farmers (with optional search)
router.get('/', async (req, res) => {
  const { search, village, crop, region, district } = req.query;
  try {
    let query = 'SELECT * FROM farmers WHERE 1=1';
    const params = [];
    let i = 1;

    if (search) {
      query += ` AND (full_name ILIKE $${i} OR phone ILIKE $${i} OR village ILIKE $${i} OR region ILIKE $${i} OR district ILIKE $${i} OR crop_type ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    if (village) {
      query += ` AND village ILIKE $${i}`;
      params.push(`%${village}%`);
      i++;
    }
    if (crop) {
      query += ` AND crop_type ILIKE $${i}`;
      params.push(`%${crop}%`);
      i++;
    }
    if (region) {
      query += ` AND region ILIKE $${i}`;
      params.push(`%${region}%`);
      i++;
    }
    if (district) {
      query += ` AND district ILIKE $${i}`;
      params.push(`%${district}%`);
      i++;
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ farmers: result.rows });
  } catch (err) {
    console.error('Farmers list error:', err);
    res.status(500).json({ error: 'Failed to fetch farmers' });
  }
});

// GET /api/farmers/:id - get single farmer
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM farmers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Farmer not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Farmer get error:', err);
    res.status(500).json({ error: 'Failed to fetch farmer' });
  }
});

function parseFarmerBody(body) {
  const b = body || {};
  const num = (v) => (v != null && v !== '' ? parseFloat(v) : null);
  const int = (v) => (v != null && v !== '' ? parseInt(v, 10) : null);
  const bool = (v) => (v === true || v === 'true' || v === 'yes' || v === 1 ? true : v === false || v === 'false' || v === 'no' || v === 0 ? false : null);
  const str = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
  return {
    full_name: str(b.full_name) || '',
    phone: str(b.phone) || '',
    country: str(b.country),
    region: str(b.region),
    division: str(b.division),
    subdivision: str(b.subdivision),
    district: str(b.district),
    village: str(b.village),
    location: str(b.location),
    gps_lat: num(b.gps_lat),
    gps_lng: num(b.gps_lng),
    farm_size_ha: num(b.farm_size_ha),
    crop_type: str(b.crop_type),
    service_needs: Array.isArray(b.service_needs) && b.service_needs.length > 0 ? b.service_needs : null,
    notes: str(b.notes),
    number_of_plots: int(b.number_of_plots),
    soil_type: str(b.soil_type),
    irrigation_type: str(b.irrigation_type),
    planting_season: str(b.planting_season),
    expected_harvest_month: str(b.expected_harvest_month),
    estimated_yield_per_ha: num(b.estimated_yield_per_ha),
    previous_yield: num(b.previous_yield),
    seed_variety: str(b.seed_variety),
    fertilizer_use: str(b.fertilizer_use),
    pest_disease_challenges: str(b.pest_disease_challenges),
    bank_account_access: bool(b.bank_account_access),
    mobile_money_access: bool(b.mobile_money_access),
    seasonal_revenue: num(b.seasonal_revenue),
    existing_loans: num(b.existing_loans),
    cooperative_membership: bool(b.cooperative_membership),
    current_buyers: str(b.current_buyers),
    storage_method: str(b.storage_method),
    post_harvest_loss_percent: num(b.post_harvest_loss_percent),
    land_ownership: str(b.land_ownership),
    years_farming: int(b.years_farming),
    access_to_tractor_services: bool(b.access_to_tractor_services),
    access_to_labour: bool(b.access_to_labour),
    storage_capacity: str(b.storage_capacity),
    mechanization_level: str(b.mechanization_level),
    geo_tagged_farm_photos: str(b.geo_tagged_farm_photos),
    national_id: str(b.national_id),
    next_of_kin: str(b.next_of_kin),
    consent_to_data_use: bool(b.consent_to_data_use),
  };
}

// POST /api/farmers - create farmer
router.post('/', async (req, res) => {
  const { full_name, phone } = req.body || {};
  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Full name and phone are required' });
  }
  const f = parseFarmerBody(req.body);

  try {
    const result = await pool.query(
      `INSERT INTO farmers (full_name, phone, country, region, division, subdivision, district, village, location, gps_lat, gps_lng, farm_size_ha, crop_type, service_needs, notes,
        number_of_plots, soil_type, irrigation_type, planting_season, expected_harvest_month, estimated_yield_per_ha, previous_yield, seed_variety, fertilizer_use, pest_disease_challenges,
        bank_account_access, mobile_money_access, seasonal_revenue, existing_loans, cooperative_membership, current_buyers, storage_method, post_harvest_loss_percent,
        land_ownership, years_farming, access_to_tractor_services, access_to_labour, storage_capacity, mechanization_level,
        geo_tagged_farm_photos, national_id, next_of_kin, consent_to_data_use)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45)
       RETURNING *`,
      [f.full_name, f.phone, f.country, f.region, f.division, f.subdivision, f.district, f.village, f.location, f.gps_lat, f.gps_lng, f.farm_size_ha, f.crop_type, f.service_needs, f.notes,
        f.number_of_plots, f.soil_type, f.irrigation_type, f.planting_season, f.expected_harvest_month, f.estimated_yield_per_ha, f.previous_yield, f.seed_variety, f.fertilizer_use, f.pest_disease_challenges,
        f.bank_account_access, f.mobile_money_access, f.seasonal_revenue, f.existing_loans, f.cooperative_membership, f.current_buyers, f.storage_method, f.post_harvest_loss_percent,
        f.land_ownership, f.years_farming, f.access_to_tractor_services, f.access_to_labour, f.storage_capacity, f.mechanization_level,
        f.geo_tagged_farm_photos, f.national_id, f.next_of_kin, f.consent_to_data_use]
    );
    const farmer = result.rows[0];
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farmer created: ${farmer.full_name} (ID ${farmer.id})`, entityType: 'farmer', entityId: farmer.id });
    res.status(201).json(farmer);
  } catch (err) {
    console.error('Farmer create error:', err);
    res.status(500).json({ error: 'Failed to create farmer' });
  }
});

// PUT /api/farmers/:id - update farmer
router.put('/:id', async (req, res) => {
  const { full_name, phone } = req.body || {};
  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Full name and phone are required' });
  }
  const f = parseFarmerBody(req.body);

  try {
    const result = await pool.query(
      `UPDATE farmers SET
        full_name = $1, phone = $2, country = $3, region = $4, division = $5, subdivision = $6, district = $7,
        village = $8, location = $9, gps_lat = $10, gps_lng = $11, farm_size_ha = $12, crop_type = $13, service_needs = $14, notes = $15,
        number_of_plots = $16, soil_type = $17, irrigation_type = $18, planting_season = $19, expected_harvest_month = $20, estimated_yield_per_ha = $21, previous_yield = $22, seed_variety = $23, fertilizer_use = $24, pest_disease_challenges = $25,
        bank_account_access = $26, mobile_money_access = $27, seasonal_revenue = $28, existing_loans = $29, cooperative_membership = $30, current_buyers = $31, storage_method = $32, post_harvest_loss_percent = $33,
        land_ownership = $34, years_farming = $35, access_to_tractor_services = $36, access_to_labour = $37, storage_capacity = $38, mechanization_level = $39,
        geo_tagged_farm_photos = $40, national_id = $41, next_of_kin = $42, consent_to_data_use = $43,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $44 RETURNING *`,
      [f.full_name, f.phone, f.country, f.region, f.division, f.subdivision, f.district, f.village, f.location, f.gps_lat, f.gps_lng, f.farm_size_ha, f.crop_type, f.service_needs, f.notes,
        f.number_of_plots, f.soil_type, f.irrigation_type, f.planting_season, f.expected_harvest_month, f.estimated_yield_per_ha, f.previous_yield, f.seed_variety, f.fertilizer_use, f.pest_disease_challenges,
        f.bank_account_access, f.mobile_money_access, f.seasonal_revenue, f.existing_loans, f.cooperative_membership, f.current_buyers, f.storage_method, f.post_harvest_loss_percent,
        f.land_ownership, f.years_farming, f.access_to_tractor_services, f.access_to_labour, f.storage_capacity, f.mechanization_level,
        f.geo_tagged_farm_photos, f.national_id, f.next_of_kin, f.consent_to_data_use,
        req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Farmer not found' });
    }
    const farmer = result.rows[0];
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farmer profile updated: ${farmer.full_name} (ID ${farmer.id})`, entityType: 'farmer', entityId: farmer.id });
    res.json(farmer);
  } catch (err) {
    console.error('Farmer update error:', err);
    res.status(500).json({ error: 'Failed to update farmer' });
  }
});

// DELETE /api/farmers/:id
router.delete('/:id', async (req, res) => {
  try {
    const getResult = await pool.query('SELECT full_name FROM farmers WHERE id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM farmers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Farmer not found' });
    }
    const name = getResult.rows[0]?.full_name || 'Unknown';
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farmer deleted: ${name} (ID ${req.params.id})`, entityType: 'farmer', entityId: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (err) {
    console.error('Farmer delete error:', err);
    res.status(500).json({ error: 'Failed to delete farmer' });
  }
});

module.exports = router;
