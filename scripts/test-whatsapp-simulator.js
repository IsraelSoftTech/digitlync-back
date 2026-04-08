#!/usr/bin/env node
/**
 * Test WhatsApp bot locally via simulator (no Meta/ngrok needed)
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
  // Unique phone per run so we always exercise full registration (not main menu for existing user)
  const suffix = (Date.now() % 100000).toString().padStart(5, '0');
  const from = `whatsapp:+2376756${suffix}`;
  const steps = [
    { body: 'hi', desc: 'Welcome / main menu' },
    { body: '1', desc: 'Register as Farmer' },
    {
      body:
        'Name: Simulator Farmer\n' +
        'Region: South West\n' +
        'Division: Meme\n' +
        'Subdivision: Kumba\n' +
        'District: Kumba 1',
      desc: 'Structured location (farmer_basic)',
    },
    { body: '4.6382, 9.4469', desc: 'GPS coordinates (decimal, after location prompt)' },
    { body: '1', desc: 'Confirm GPS' },
    {
      body: 'Farm size: 2.5\nCrop: Maize\nServices: 1,3',
      desc: 'Farm details (size, crop, services)',
    },
    { body: '2', desc: 'No additional farm' },
    { body: 'yes', desc: 'Confirm registration (synonym for 1)' },
    { body: '1', desc: 'Privacy consent Agree' },
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
      console.log(`[${step.desc}]`);
      console.log(`  send: ${JSON.stringify(step.body).slice(0, 120)}${step.body.length > 120 ? '…' : ''}`);
      console.log(`  → ${(reply || '(no reply)').split('\n')[0]}`);
      console.log('');
    } catch (err) {
      const msg = err.name === 'AbortError' ? `Request timed out. Is the DB reachable?` : err.message;
      console.error(`[${step.desc}] ERROR:`, msg);
      process.exit(1);
    }
  }

  console.log('---');
  console.log('All steps passed. Farmer registration flow completed locally.');
}

run();
