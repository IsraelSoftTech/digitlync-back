/**
 * Admin audit logs API
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// GET /api/audit-logs - list audit logs with filters
router.get('/', async (req, res) => {
  const { admin, type, dateFrom, dateTo, limit = 100 } = req.query;
  try {
    let query = `
      SELECT al.id, al.admin_id, al.admin_username AS admin, al.action_type AS type, al.action, al.entity_type, al.entity_id, al.created_at
      FROM admin_audit_logs al
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    if (admin && admin.trim()) {
      query += ` AND al.admin_username ILIKE $${i}`;
      params.push(`%${admin.trim()}%`);
      i++;
    }
    if (type && type.trim()) {
      query += ` AND al.action_type = $${i}`;
      params.push(type.trim());
      i++;
    }
    if (dateFrom) {
      query += ` AND al.created_at >= $${i}::date`;
      params.push(dateFrom);
      i++;
    }
    if (dateTo) {
      query += ` AND al.created_at <= $${i}::date + interval '1 day'`;
      params.push(dateTo);
      i++;
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${i}`;
    params.push(Math.min(parseInt(limit, 10) || 100, 500));

    const result = await pool.query(query, params);
    const logs = result.rows.map((r) => ({
      id: r.id,
      admin: r.admin || 'System',
      action: r.action,
      type: r.type,
      date: r.created_at ? new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ') : null,
      entityType: r.entity_type,
      entityId: r.entity_id,
    }));
    res.json({ logs });
  } catch (err) {
    console.error('Audit logs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

module.exports = router;
