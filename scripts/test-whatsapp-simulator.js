#!/usr/bin/env node
/**
 * Test WhatsApp bot locally via simulator (no Twilio/ngrok needed)
 * Run: node scripts/test-whatsapp-simulator.js
 * Prerequisites: Backend running (npm run dev), DB + whatsapp_sessions migrated
 */
const BASE = process.env.BACKEND_URL || 'http://localhost:5000';
const TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function post(body) {
  const res = await fetchWithTimeout(`${BASE}/api/whatsapp/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function checkBackend() {
  try {
    await fetchWithTimeout(`${BASE}/api/health`);
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Backend at ${BASE} did not respond in ${TIMEOUT_MS / 1000}s. Is it running? Start with: npm run dev`);
    }
    throw new Error(`Cannot reach backend at ${BASE}. Start it first: npm run dev`);
  }
}

async function run() {
  // Use unique phone per run so we always test registration (not main menu for existing user)
  const suffix = (Date.now() % 100000).toString().padStart(5, '0');
  const from = `whatsapp:+2376756${suffix}`;
  const steps = [
    { body: 'hi', desc: 'Welcome message' },
    { body: '1', desc: 'Choose Farmer' },
    { body: 'John Doe', desc: 'Farmer name' },
    { body: 'Buea', desc: 'Village' },
    { body: '2.5', desc: 'Farm size' },
    { body: 'maize', desc: 'Crop' },
    { body: 'skip', desc: 'Skip location' },
    { body: 'yes', desc: 'Confirm registration' },
  ];

  console.log('Testing WhatsApp bot via simulator at', BASE);
  try {
    await checkBackend();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log('---');

  for (const step of steps) {
    try {
      const { reply } = await post({ from, body: step.body });
      console.log(`[${step.desc}] "${step.body}"`);
      console.log(`  → ${(reply || '(no reply)').split('\n')[0]}`);
      console.log('');
    } catch (err) {
      const msg = err.name === 'AbortError' ? `Request timed out. Is the DB reachable?` : err.message;
      console.error(`[${step.desc}] ERROR:`, msg);
      process.exit(1);
    }
  }

  console.log('---');
  console.log('All steps passed. Bot is working locally.');
}

run();
