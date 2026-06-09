const { pool } = require('../config/db');

/** Require a valid admin (X-Admin-Id header must match an admins row). */
async function requireAdmin(req, res, next) {
  const adminId = parseInt(req.headers['x-admin-id'], 10);
  if (!adminId || Number.isNaN(adminId)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  try {
    const result = await pool.query('SELECT id, username FROM admins WHERE id = $1', [adminId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid admin session' });
    }
    req.admin = result.rows[0];
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

module.exports = { requireAdmin };
