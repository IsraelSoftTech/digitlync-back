/**
 * Twilio WhatsApp webhook - receives incoming messages
 * Configure this URL in Twilio Console: https://api.digilync.net/api/whatsapp/webhook
 */
const express = require('express');
const router = express.Router();
const { handleIncoming } = require('../services/whatsapp-conversation');
const { sendText, isEnabled } = require('../services/whatsapp-sender');

/** GET - Status check (for debugging, no auth) */
router.get('/webhook', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: isEnabled() ? 'configured' : 'not_configured',
    hint: 'Twilio must POST to this URL. Set webhook in Twilio Console → Messaging → WhatsApp Sandbox.',
  });
});

// Twilio sends application/x-www-form-urlencoded
router.post('/webhook', async (req, res) => {
  // Log immediately - if you never see this, Twilio is not reaching your server
  const bodyKeys = req.body ? Object.keys(req.body) : [];
  console.log('[WhatsApp] POST /webhook received', {
    bodyKeys: bodyKeys.slice(0, 15),
    hasFrom: !!req.body?.From,
    hasWaId: !!req.body?.WaId,
    hasBody: !!req.body?.Body,
  });

  // Twilio WhatsApp can send From (e.g. whatsapp:+1234567890) or WaId (phone without prefix)
  let from = req.body?.From;
  if (!from && req.body?.WaId) {
    from = req.body.WaId.startsWith('whatsapp:') ? req.body.WaId : `whatsapp:+${req.body.WaId}`;
    console.log('[WhatsApp] Using WaId as From fallback');
  }

  const body = req.body?.Body || '';
  console.log('[WhatsApp] Incoming:', { from: from ? '***' + from.slice(-4) : 'missing', bodyLen: body.length });

  if (!isEnabled()) {
    console.warn('[WhatsApp] Twilio not configured - set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM');
    return res.status(503).send('WhatsApp not configured');
  }

  const latitude = req.body?.Latitude;
  const longitude = req.body?.Longitude;
  const profileName = req.body?.ProfileName || '';

  if (!from) {
    console.error('[WhatsApp] Missing From and WaId - raw body keys:', bodyKeys);
    return res.status(400).send('Missing From');
  }

  try {
    const reply = await handleIncoming(from, body, latitude, longitude, profileName);
    if (reply) {
      await sendText(from, reply);
      console.log('[WhatsApp] Reply sent to', from ? '***' + from.slice(-4) : '?');
    } else {
      console.log('[WhatsApp] No reply to send (handleIncoming returned null)');
    }
    res.status(200).send();
  } catch (err) {
    console.error('[WhatsApp] Webhook error:', err);
    console.error('[WhatsApp] Stack:', err.stack);
    try {
      await sendText(from, 'Sorry, something went wrong. Please try again later.');
    } catch (e) {
      console.error('Failed to send error reply:', e);
    }
    res.status(500).send();
  }
});

/** Status callback (optional) - for delivery reports */
router.post('/status', (req, res) => {
  res.status(200).send();
});

module.exports = router;
