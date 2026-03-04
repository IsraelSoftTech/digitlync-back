/**
 * Farm plots API - multiple GPS locations per farmer (SRS: multiple plots supported)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');

// GET /api/farm-plots?farmer_id=1
router.get('/', async (req, res) => {
  const { farmer_id } = req.query;
  if (!farmer_id) return res.status(400).json({ error: 'farmer_id required' });
  try {
    const r = await pool.query(
      'SELECT * FROM farm_plots WHERE farmer_id = $1 ORDER BY id',
      [farmer_id]
    );
    res.json({ plots: r.rows });
  } catch (err) {
    console.error('Farm plots list error:', err);
    res.status(500).json({ error: 'Failed to fetch plots' });
  }
});

// POST /api/farm-plots
router.post('/', async (req, res) => {
  const { farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type } = req.body || {};
  if (!farmer_id || gps_lat == null || gps_lng == null) {
    return res.status(400).json({ error: 'farmer_id, gps_lat, gps_lng required' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO farm_plots (farmer_id, gps_lat, gps_lng, plot_name, plot_size_ha, crop_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        farmer_id,
        parseFloat(gps_lat),
        parseFloat(gps_lng),
        plot_name?.trim() || null,
        plot_size_ha != null ? parseFloat(plot_size_ha) : null,
        crop_type?.trim() || null,
      ]
    );
    const plot = r.rows[0];
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farm plot added for farmer ${farmer_id} (ID ${plot.id})`, entityType: 'farm_plot', entityId: plot.id });
    res.status(201).json(plot);
  } catch (err) {
    console.error('Farm plot create error:', err);
    res.status(500).json({ error: 'Failed to create plot' });
  }
});

// PUT /api/farm-plots/:id
router.put('/:id', async (req, res) => {
  const { gps_lat, gps_lng, plot_name, plot_size_ha, crop_type } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE farm_plots SET
        gps_lat = COALESCE($1, gps_lat), gps_lng = COALESCE($2, gps_lng),
        plot_name = COALESCE($3, plot_name), plot_size_ha = COALESCE($4, plot_size_ha),
        crop_type = COALESCE($5, crop_type)
       WHERE id = $6 RETURNING *`,
      [
        gps_lat != null ? parseFloat(gps_lat) : null,
        gps_lng != null ? parseFloat(gps_lng) : null,
        plot_name !== undefined ? (plot_name?.trim() || null) : null,
        plot_size_ha != null ? parseFloat(plot_size_ha) : null,
        crop_type !== undefined ? (crop_type?.trim() || null) : null,
        req.params.id,
      ]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Plot not found' });
    const plot = r.rows[0];
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farm plot updated (ID ${plot.id})`, entityType: 'farm_plot', entityId: plot.id });
    res.json(plot);
  } catch (err) {
    console.error('Farm plot update error:', err);
    res.status(500).json({ error: 'Failed to update plot' });
  }
});

// DELETE /api/farm-plots/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM farm_plots WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Plot not found' });
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({ adminId, adminUsername, actionType: 'data_edit', action: `Farm plot deleted (ID ${req.params.id})`, entityType: 'farm_plot', entityId: parseInt(req.params.id, 10) });
    res.json({ success: true });
  } catch (err) {
    console.error('Farm plot delete error:', err);
    res.status(500).json({ error: 'Failed to delete plot' });
  }
});

module.exports = router;
