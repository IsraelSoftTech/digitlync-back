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
  const from = req.body?.From;
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
    return res.status(400).send('Missing From');
  }

  try {
    const reply = await handleIncoming(from, body, latitude, longitude, profileName);
    if (reply) {
      await sendText(from, reply);
      console.log('[WhatsApp] Reply sent to', from ? '***' + from.slice(-4) : '?');
    }
    res.status(200).send();
  } catch (err) {
    console.error('[WhatsApp] Webhook error:', err);
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
