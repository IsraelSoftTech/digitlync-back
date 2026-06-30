const express = require('express');
const { requireAdmin } = require('../middleware/admin-auth');
const {
  getPlatformSettings,
  updatePlatformSettings,
  updateMaintenanceSignal,
} = require('../services/platform-settings');
const { logAudit, getAdminFromRequest } = require('../services/audit-log');

const router = express.Router();

router.get('/', requireAdmin, async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    res.json({ settings });
  } catch (err) {
    console.error('Settings get error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/', requireAdmin, async (req, res) => {
  const { settings } = req.body || {};
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required' });
  }
  try {
    const result = await updatePlatformSettings(settings, req.admin.id);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({
      adminId,
      adminUsername,
      actionType: 'data_edit',
      action: 'Updated platform settings',
      entityType: 'settings',
      entityId: 1,
    });
    res.json({ success: true, settings: result.settings });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

router.get('/maintenance', requireAdmin, async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    res.json({ maintenanceSignalEnabled: Boolean(settings.maintenanceSignalEnabled) });
  } catch (err) {
    console.error('Maintenance settings get error:', err);
    res.status(500).json({ error: 'Failed to load maintenance settings' });
  }
});

router.put('/maintenance', requireAdmin, async (req, res) => {
  const { maintenanceSignalEnabled } = req.body || {};
  if (typeof maintenanceSignalEnabled !== 'boolean') {
    return res.status(400).json({ error: 'maintenanceSignalEnabled (boolean) is required' });
  }
  try {
    const result = await updateMaintenanceSignal(maintenanceSignalEnabled, req.admin.id);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Update failed' });
    }
    const { adminId, adminUsername } = getAdminFromRequest(req);
    await logAudit({
      adminId,
      adminUsername,
      actionType: 'data_edit',
      action: maintenanceSignalEnabled
        ? 'Enabled maintenance signal banner'
        : 'Disabled maintenance signal banner',
      entityType: 'settings',
      entityId: 1,
    });
    res.json({ success: true, maintenanceSignalEnabled: result.maintenanceSignalEnabled });
  } catch (err) {
    console.error('Maintenance settings update error:', err);
    res.status(500).json({ error: 'Failed to save maintenance settings' });
  }
});

module.exports = router;
