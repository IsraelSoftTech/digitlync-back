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

---

## Troubleshooting: "No reply when I send a message"

### 1. Check webhook is configured in Twilio

1. Go to [Twilio Console](https://console.twilio.com) → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. Find **"When a message comes in"** webhook
3. Set URL to: `https://api.digilync.net/api/whatsapp/webhook` (or your deployed API URL)
4. Method: **POST**
5. Save

### 2. Verify your API receives the webhook

Visit: `https://api.digilync.net/api/whatsapp/webhook` (GET)

- If you see `"whatsapp": "configured"` → Twilio credentials are set
- If you see `"whatsapp": "not_configured"` → Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` to your production environment

### 3. Twilio WhatsApp Sandbox – join first

For the **sandbox**, users must join before messaging:

1. In Twilio Console → Messaging → WhatsApp Sandbox
2. You'll see: "Send 'join &lt;your-code&gt;' to +1 415 523 8886"
3. **You must send that exact message** from your WhatsApp to the sandbox number first
4. Only after joining will the bot reply

### 4. Environment variables in production

Ensure these are set where your backend runs (e.g. hosting platform env vars):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx...
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

For sandbox, `TWILIO_WHATSAPP_FROM` is usually `whatsapp:+14155238886`. For WhatsApp Business API, use your approved number.

### 5. Check backend logs

After sending a message, check your server logs. You should see:

- `[WhatsApp] Incoming: { from: '***4383', bodyLen: 2 }` → Twilio reached your server
- `[WhatsApp] Reply sent to ***4383` → Reply was sent

If you see nothing, Twilio is not reaching your webhook (wrong URL, firewall, or SSL issue).
