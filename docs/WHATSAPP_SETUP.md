# DigiLync WhatsApp Bot Setup (Meta Cloud API)

## Overview

The WhatsApp bot enables **farmer and provider registration** directly via WhatsApp, per the DigiLync SRS Phase 1. It uses **Meta's WhatsApp Cloud API**.

## Prerequisites

- Meta for Developers account
- WhatsApp Business Account (created when you add WhatsApp to your Meta app)
- Node.js backend running with PostgreSQL

## Configuration

1. Add to your `.env`:

```
META_WHATSAPP_ACCESS_TOKEN=your_page_access_token
META_WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
META_WHATSAPP_VERIFY_TOKEN=digilync-webhook-verify
```

2. Run the migration:

```bash
npm run migrate:whatsapp
```

3. Install dependencies (if not already):

```bash
npm install
```

## Meta Webhook Setup

1. Go to [Meta for Developers](https://developers.facebook.com) → Your App → **WhatsApp** → **Configuration**
2. Under **Webhook**, click **Edit**
3. **Callback URL**: `https://api.digilync.net/api/whatsapp/webhook`
4. **Verify Token**: `digilync-webhook-verify` (must match `META_WHATSAPP_VERIFY_TOKEN` in your `.env`)
5. **Fallback URL**: Same as Callback URL
6. Subscribe to **messages** webhook field
7. Click **Verify and Save**

### Local testing without Meta/ngrok (simulator)

You can test the full conversation flow locally **without** Meta or ngrok:

```bash
# 1. Start the backend
npm run dev

# 2. In another terminal, run the test script
npm run test:whatsapp
```

Or test manually with curl:

```bash
curl -X POST http://localhost:5000/api/whatsapp/simulate \
  -H "Content-Type: application/json" \
  -d '{"from":"whatsapp:+237675644383","body":"hi"}'
```

The simulator returns the bot's reply in JSON: `{"reply":"...","from":"..."}`. No real WhatsApp messages are sent.

### Local testing with real WhatsApp (ngrok)

For local development with real WhatsApp, use [ngrok](https://ngrok.com) to expose your local server:

```bash
ngrok http 5000
```

Then set the webhook Callback URL in Meta to: `https://xxxx.ngrok.io/api/whatsapp/webhook`

## Getting Meta Credentials

1. **Meta for Developers** → Your App → **WhatsApp** → **API Setup**
2. **Phone number ID**: Shown under "From" (e.g. `123456789012345`)
3. **Access Token**: Click "Generate" to create a temporary token, or use a System User for a permanent token

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

**Never commit** `META_WHATSAPP_ACCESS_TOKEN` to source control. Use environment variables only.

---

## Troubleshooting: "No reply when I send a message"

### 1. Check webhook is configured in Meta

1. Go to [Meta for Developers](https://developers.facebook.com) → Your App → **WhatsApp** → **Configuration**
2. Webhook Callback URL: `https://api.digilync.net/api/whatsapp/webhook`
3. Verify Token must match `META_WHATSAPP_VERIFY_TOKEN` in your `.env`
4. Ensure **messages** is subscribed

### 2. Verify your API receives the webhook

Visit: `https://api.digilync.net/api/whatsapp/webhook` (GET)

- If you see `"whatsapp": "configured"` → Meta credentials are set on that server
- If you see `"whatsapp": "not_configured"` → Add `META_WHATSAPP_ACCESS_TOKEN` and `META_WHATSAPP_PHONE_NUMBER_ID` to your deployment

### 3. Meta WhatsApp – messaging window

For **test numbers**, add them in Meta for Developers → WhatsApp → **API Setup** → "To" field. Only added numbers can message your business during development.

### 4. Environment variables in production

Ensure these are set where your backend runs:

```
META_WHATSAPP_ACCESS_TOKEN=your_token
META_WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
META_WHATSAPP_VERIFY_TOKEN=digilync-webhook-verify
```

### 5. Check backend logs

After sending a message, check your server logs. You should see:

- `[WhatsApp] POST /webhook received` → Request reached your server
- `[WhatsApp] Reply sent to ***4383` → Reply was sent

**If you see nothing** → Meta is not reaching your webhook. Check:
- Webhook URL in Meta (exact path: `/api/whatsapp/webhook`)
- Your API is publicly reachable (use ngrok for local dev)
- Verify token matches

**If you see "POST /webhook received" but no reply** → Check for:
- `Meta not configured` → Set env vars in your deployment
- `Webhook error` → Check the error stack trace
