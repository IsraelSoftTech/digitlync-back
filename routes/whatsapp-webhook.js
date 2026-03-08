/**
 * Meta WhatsApp Cloud API webhook - receives incoming messages
 * Configure in Meta for Developers → WhatsApp → Configuration
 * Webhook URL: https://digitlync-back.onrender.com/api/whatsapp/webhook
 * Verify Token: Set in META_WHATSAPP_VERIFY_TOKEN - must match Meta's form
 */
const express = require('express');
const router = express.Router();
const { handleIncoming } = require('../services/whatsapp-conversation');
const { sendText, isEnabled } = require('../services/whatsapp-sender');
const config = require('../config/whatsapp');

/** GET - Meta webhook verification (hub.mode, hub.verify_token, hub.challenge) */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Meta sends hub.mode=subscribe, hub.verify_token, hub.challenge
  if (mode === 'subscribe' && token === config.verifyToken) {
    const challengeStr = challenge != null ? String(challenge) : '';
    console.log('[WhatsApp] Meta webhook verified');
    return res.type('text/plain').status(200).send(challengeStr);
  }

  // Status check when not a Meta verification request
  if (!mode && !token) {
    return res.json({
      status: 'ok',
      whatsapp: isEnabled() ? 'configured' : 'not_configured',
      hint: 'Meta webhook. Set callback URL in Meta for Developers → WhatsApp → Configuration.',
    });
  }

  // Log failed verification for debugging
  console.warn('[WhatsApp] Verification failed', { mode, tokenMatch: token === config.verifyToken, hasChallenge: !!challenge });
  res.status(403).send('Forbidden');
});

/** POST - Meta webhook events (messages, status updates, etc.) */
router.post('/webhook', async (req, res) => {
  // Log first - if you never see this, Meta is not sending POSTs to your server
  console.log('[WhatsApp] POST /webhook hit');
  // Acknowledge immediately - Meta expects 200 within ~20 seconds
  res.status(200).send();

  const body = req.body;
  // Log every POST to debug - Meta sends messages, status updates, etc.
  console.log('[WhatsApp] POST received', {
    object: body?.object,
    entryCount: body?.entry?.length ?? 0,
    fields: body?.entry?.map((e) => e.changes?.map((c) => c.field)).flat().filter(Boolean) ?? [],
  });

  if (!body || body.object !== 'whatsapp_business_account') {
    console.warn('[WhatsApp] Ignoring webhook - object:', body?.object);
    return;
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const messages = value.messages || [];
      const contacts = value.contacts || [];
      const contactMap = {};
      for (const c of contacts) {
        if (c.wa_id) contactMap[c.wa_id] = c.profile?.name || '';
      }

      for (const msg of messages) {
        const from = msg.from || msg.wa_id;
        if (!from) continue;

        const waFrom = `whatsapp:+${String(from).replace(/^\+/, '')}`;
        const profileName = contactMap[from] || '';

        let text = '';
        let latitude = null;
        let longitude = null;

        if (msg.type === 'text') {
          text = msg.text?.body || '';
        } else if (msg.type === 'location') {
          latitude = msg.location?.latitude;
          longitude = msg.location?.longitude;
          text = msg.location?.name || '';
        } else if (msg.type === 'interactive') {
          const btn = msg.interactive?.button_reply;
          const list = msg.interactive?.list_reply;
          text = (btn?.title || list?.title || list?.description || '').trim();
        } else {
          console.log('[WhatsApp] Unsupported message type:', msg.type);
          continue;
        }

        console.log('[WhatsApp] POST /webhook received', {
          from: '***' + String(from).slice(-4),
          bodyLen: text.length,
          type: msg.type,
        });

        if (!isEnabled()) {
          console.warn('[WhatsApp] Meta not configured - set META_WHATSAPP_ACCESS_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID in Render Environment');
          continue;
        }

        try {
          const reply = await handleIncoming(waFrom, text, latitude, longitude, profileName);
          if (reply) {
            console.log('[WhatsApp] Sending reply to', '***' + String(from).slice(-4), 'len:', reply.length);
            await sendText(waFrom, reply);
            console.log('[WhatsApp] Reply sent to', '***' + String(from).slice(-4));
          } else {
            console.log('[WhatsApp] No reply to send (handleIncoming returned null)');
          }
        } catch (err) {
          console.error('[WhatsApp] Webhook error:', err.message);
          console.error('[WhatsApp] Full error:', err);
          try {
            await sendText(waFrom, 'Sorry, something went wrong. Please try again later.');
          } catch (e) {
            console.error('[WhatsApp] Failed to send error reply:', e.message);
          }
        }
      }
    }
  }
});

/**
 * LOCAL TESTING: Simulate incoming WhatsApp message without Meta/ngrok
 * POST /api/whatsapp/simulate
 * Body (JSON): { from: "whatsapp:+237675644383", body: "hi", latitude?, longitude?, profileName? }
 * Returns: { reply: "..." } - the bot's response (no real WhatsApp message sent)
 */
router.post('/simulate', async (req, res) => {
  const from = req.body?.from || req.body?.From || `whatsapp:+${req.body?.WaId || '237675644383'}`;
  const body = req.body?.body || req.body?.Body || '';
  const latitude = req.body?.latitude ?? req.body?.Latitude;
  const longitude = req.body?.longitude ?? req.body?.Longitude;
  const profileName = req.body?.profileName || req.body?.ProfileName || '';

  if (!from) {
    return res.status(400).json({ error: 'Missing from/From. Example: { "from": "whatsapp:+237675644383", "body": "hi" }' });
  }

  try {
    const reply = await handleIncoming(from, body, latitude, longitude, profileName);
    console.log('[WhatsApp Simulator]', { from: from.slice(-8), body: body.slice(0, 30), reply: reply ? reply.slice(0, 50) + '...' : null });
    res.json({ reply: reply || null, from });
  } catch (err) {
    console.error('[WhatsApp Simulator] Error:', err);
    res.status(500).json({ error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
});

module.exports = router;
