/**
 * Twilio WhatsApp webhook - receives incoming messages
 * Configure this URL in Twilio Console: https://.../api/whatsapp/webhook
 */
const express = require('express');
const router = express.Router();
const { handleIncoming } = require('../services/whatsapp-conversation');
const { sendText, isEnabled } = require('../services/whatsapp-sender');

// Twilio sends application/x-www-form-urlencoded
router.post('/webhook', async (req, res) => {
  if (!isEnabled()) {
    console.warn('WhatsApp webhook called but Twilio not configured');
    return res.status(503).send('WhatsApp not configured');
  }

  const from = req.body.From;       // whatsapp:+237675644383
  const body = req.body.Body || '';
  const latitude = req.body.Latitude;
  const longitude = req.body.Longitude;
  const profileName = req.body.ProfileName || '';

  if (!from) {
    return res.status(400).send('Missing From');
  }

  try {
    const reply = await handleIncoming(from, body, latitude, longitude, profileName);
    if (reply) {
      await sendText(from, reply);
    }
    res.status(200).send();
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
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
