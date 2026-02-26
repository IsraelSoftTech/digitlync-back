# DigiLync WhatsApp Bot Setup

## Overview

The WhatsApp bot enables **farmer and provider registration** directly via WhatsApp, per the DigiLync SRS Phase 1.

## Prerequisites

- Twilio account with WhatsApp Sandbox or WhatsApp Business API
- Node.js backend running with PostgreSQL

## Configuration

1. Add to your `.env`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

2. Run the migration:

```bash
npm run migrate:whatsapp
```

3. Install dependencies (if not already):

```bash
npm install
```

## Twilio Webhook Setup

1. In [Twilio Console](https://console.twilio.com) → Messaging → Try it out → Send a WhatsApp message
2. Configure the sandbox "When a message comes in" webhook URL:
   - **URL**: `https://your-api-domain.com/api/whatsapp/webhook`
   - **Method**: POST

For local development, use [ngrok](https://ngrok.com) to expose your local server:

```bash
ngrok http 5000
```

Then set the webhook to: `https://xxxx.ngrok.io/api/whatsapp/webhook`

## User Flow

### New Users

1. User sends any message (e.g. "hi")
2. Bot asks: Farmer (1) or Provider (2)
3. **Farmer registration**: Full name → Village → Farm size → Crop type → Location (optional) → Confirm
4. **Provider registration**: Full name → Services → Capacity → Price → Equipment → Radius → Confirm

### Registered Users

- **Farmer**: MENU, REQUEST, PROFILE
- **Provider**: MENU, JOBS, PROFILE

## Security Note

**Never commit** `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN` to source control. Use environment variables only.
