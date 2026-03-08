/**
 * WhatsApp message sender via Meta Cloud API
 * Handles outbound messages to users.
 */
const config = require('../config/whatsapp');

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

/**
 * Normalize phone for WhatsApp: Meta expects digits only (e.g. 237675644383)
 */
function toWhatsAppPhone(phone) {
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('237')) return cleaned;
  if (cleaned.startsWith('0')) return '237' + cleaned.slice(1);
  return cleaned;
}

/**
 * Send a plain text message via Meta Graph API
 * @param {string} to - Recipient phone (e.g. +237675644383 or 237675644383 or whatsapp:+237675644383)
 * @param {string} body - Message text
 */
async function sendText(to, body) {
  if (!config.enabled) {
    throw new Error('WhatsApp/Meta is not configured. Set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID.');
  }

  const phone = toWhatsAppPhone(to);
  const res = await fetch(`${META_GRAPH_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: {
        preview_url: false,
        body: String(body),
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[WhatsApp] Meta API error', res.status, errBody);
    throw new Error(`Meta WhatsApp API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  console.log('[WhatsApp] Message sent successfully to', phone);
  return data;
}

/**
 * Send a template message (for approved templates)
 * @param {string} to - Recipient phone
 * @param {string} templateName - Template name (e.g. hello_world)
 * @param {string} languageCode - Language code (e.g. en_US)
 * @param {object} components - Template components (buttons, body params, etc.)
 */
async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  if (!config.enabled) {
    throw new Error('WhatsApp/Meta is not configured. Set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID.');
  }

  const phone = toWhatsAppPhone(to);
  const res = await fetch(`${META_GRAPH_URL}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components.length ? components : undefined,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Meta WhatsApp API error ${res.status}: ${errBody}`);
  }

  return res.json();
}

module.exports = {
  sendText,
  sendTemplate,
  toWhatsAppPhone,
  isEnabled: () => config.enabled,
};
