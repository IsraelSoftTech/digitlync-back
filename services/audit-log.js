/**
 * Audit log service - records admin actions for compliance and debugging
 */
const { pool } = require('../config/db');

/**
 * Log an admin action
 * @param {Object} opts
 * @param {number|null} opts.adminId - Admin user ID
 * @param {string|null} opts.adminUsername - Admin username
 * @param {string} opts.actionType - data_edit | booking | suspension | matching | whatsapp | login
 * @param {string} opts.action - Human-readable description
 * @param {string} [opts.entityType] - farmer | provider | booking
 * @param {number} [opts.entityId] - ID of affected entity
 */
async function logAudit({ adminId, adminUsername, actionType, action, entityType, entityId }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, admin_username, action_type, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId || null,
        adminUsername || null,
        actionType || 'data_edit',
        String(action || ''),
        entityType || null,
        entityId != null ? parseInt(entityId, 10) : null,
      ]
    );
  } catch (err) {
    console.error('[Audit] Failed to log:', err.message);
  }
}

/**
 * Extract admin context from request headers (X-Admin-Id, X-Admin-Username)
 */
function getAdminFromRequest(req) {
  const adminId = req.headers['x-admin-id'];
  const adminUsername = req.headers['x-admin-username'];
  return {
    adminId: adminId ? parseInt(adminId, 10) : null,
    adminUsername: adminUsername || null,
  };
}

module.exports = { logAudit, getAdminFromRequest };
