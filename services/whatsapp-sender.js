/**
 * WhatsApp message sender via Twilio
 * Handles outbound messages to users.
 */
const twilio = require('twilio');
const config = require('../config/whatsapp');

let client = null;

function getClient() {
  if (!config.enabled) {
    throw new Error('WhatsApp/Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  }
  if (!client) {
    client = twilio(config.accountSid, config.authToken);
  }
  return client;
}

/**
 * Normalize phone for WhatsApp: ensure whatsapp:+1234567890 format
 */
function toWhatsAppPhone(phone) {
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('237')) return `whatsapp:+${cleaned}`;
  if (cleaned.startsWith('0')) return `whatsapp:+237${cleaned.slice(1)}`;
  return `whatsapp:+${cleaned}`;
}

/**
 * Send a plain text message
 * @param {string} to - Recipient phone (e.g. +237675644383 or 237675644383)
 * @param {string} body - Message text
 */
async function sendText(to, body) {
  const twilioClient = getClient();
  const result = await twilioClient.messages.create({
    from: config.fromNumber,
    to: toWhatsAppPhone(to),
    body: String(body),
  });
  return result;
}

/**
 * Send a template message (for approved templates)
 * @param {string} to - Recipient phone
 * @param {string} contentSid - Template SID (e.g. HX...)
 * @param {object} contentVariables - Template variables as object, e.g. {"1":"John","2":"12/1"}
 */
async function sendTemplate(to, contentSid, contentVariables = {}) {
  const twilioClient = getClient();
  const result = await twilioClient.messages.create({
    from: config.fromNumber,
    to: toWhatsAppPhone(to),
    contentSid,
    contentVariables: JSON.stringify(contentVariables),
  });
  return result;
}

module.exports = {
  sendText,
  sendTemplate,
  toWhatsAppPhone,
  isEnabled: () => config.enabled,
};
