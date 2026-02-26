/**
 * WhatsApp API Configuration (Twilio)
 * Credentials from environment variables - never hardcode in source.
 */

module.exports = {
  enabled: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN,
  provider: 'twilio',
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  /** Twilio WhatsApp sender (e.g. whatsapp:+14155238886 for sandbox) */
  fromNumber: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
};
