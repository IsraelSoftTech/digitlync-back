#!/usr/bin/env node
/**
 * Regression tests for WhatsApp list-reply routing (ID collision prevention).
 * Run: node scripts/test-menu-routing.js
 * DB tests run only when DATABASE_URL is reachable.
 */
const {
  matchListId,
  isPrefixedListId,
  normalizeUserChoice,
  buildServiceListReply,
  MAX_LIST_ROWS_TOTAL,
} = require('../services/whatsapp-interactive');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testListIdHelpers() {
  assert(matchListId('main_6', 'main') === '6', 'main_6');
  assert(matchListId('svc_6', 'svc') === '6', 'svc_6');
  assert(matchListId('opt_1', 'opt') === '1', 'opt_1');
  assert(matchListId('recap_3', 'recap') === '3', 'recap_3');
  assert(matchListId('confirm_2', 'confirm') === '2', 'confirm_2');
  assert(matchListId('privacy_1', 'privacy') === '1', 'privacy_1');
  assert(matchListId('prov_4', 'prov') === '4', 'prov_4');
  assert(matchListId('farm_2', 'farm') === '2', 'farm_2');
  assert(matchListId('hello', 'main') === null, 'non-list id');
  assert(isPrefixedListId('main_3'), 'isPrefixed main_3');
  assert(isPrefixedListId('accept_42'), 'isPrefixed accept_42');
  assert(!isPrefixedListId('3'), 'bare 3 not prefixed');
  assert(!isPrefixedListId('Services: 1,3'), 'text not prefixed');
  // Normalization still strips for typed handlers — prefixed ids must be routed before this matters
  assert(normalizeUserChoice('main_6') === '6', 'normalize main_6');
  assert(normalizeUserChoice('svc_6') === '6', 'normalize svc_6');
  assert(normalizeUserChoice('recap_1') === '1', 'normalize recap_1');
  console.log('OK list ID helper unit tests');
}

function testServiceListMetaLimits() {
  for (const page of [1, 2, undefined]) {
    const reply = buildServiceListReply('Test service picker', page === undefined ? {} : { page });
    const totalRows = (reply.sections || []).reduce((n, s) => n + (s.rows || []).length, 0);
    assert(totalRows <= MAX_LIST_ROWS_TOTAL, `service list page ${page ?? 1} has ${totalRows} rows (max ${MAX_LIST_ROWS_TOTAL})`);
    assert(reply.sections.length >= 1, 'service list has at least one section');
  }
  const page1Ids = buildServiceListReply('', { page: 1 }).sections[0].rows.map((r) => r.id);
  assert(page1Ids.includes('svc_page_2'), 'page 1 includes More services nav');
  const page2Ids = buildServiceListReply('', { page: 2 }).sections[0].rows.map((r) => r.id);
  assert(page2Ids.includes('svc_15'), 'page 2 includes last service');
  assert(page2Ids.includes('svc_page_1'), 'page 2 includes Earlier services nav');
  console.log('OK service list respects Meta 10-row cap');
}

async function testWithDb() {
  const { pool } = require('../config/db');
  const { handleIncoming, updateSession } = require('../services/whatsapp-conversation');
  const from = `whatsapp:+2376999${String(Date.now()).slice(-5)}`;
  const phone = from.replace(/^whatsapp:/i, '');
  const farmerIns = await pool.query(
    `INSERT INTO farmers (full_name, phone, farm_size_ha, gps_lat, gps_lng)
     VALUES ('Routing Test Farmer', $1, 2.5, 4.6, 9.4) RETURNING id`,
    [phone]
  );
  const farmerId = farmerIns.rows[0].id;

  await updateSession(from, {
    step: 'request_input',
    data: { farmer_id: farmerId, farm_size_ha: 2.5, farm_gps_lat: 4.6, farm_gps_lng: 9.4 },
  });

  const staleMainReply = await handleIncoming(from, 'main_6', null, null, 'Test');
  const staleMainText = typeof staleMainReply === 'object' ? JSON.stringify(staleMainReply) : String(staleMainReply);
  assert(/earlier message|MENU/i.test(staleMainText), `main_6 → stale hint, got: ${staleMainText.slice(0, 80)}`);
  console.log('OK main_6 during request_input → stale list hint');

  await updateSession(from, {
    step: 'request_input',
    data: { farmer_id: 1, farm_size_ha: 2.5 },
  });

  const procReply = await handleIncoming(from, 'svc_6', null, null, 'Test');
  const procText = typeof procReply === 'object' ? JSON.stringify(procReply) : String(procReply);
  assert(/Processing/i.test(procText), `svc_6 → Processing, got: ${procText.slice(0, 80)}`);
  console.log('OK svc_6 during request_input → Processing');

  await updateSession(from, {
    step: 'request_input',
    data: { farmer_id: 1, farm_size_ha: 2.5 },
  });

  const staleOpt = await handleIncoming(from, 'opt_1', null, null, 'Test');
  assert(/earlier message|MENU/i.test(String(staleOpt)), `stale opt_1 hint, got: ${String(staleOpt).slice(0, 80)}`);
  console.log('OK stale opt_1 during request_input → hint (not Ploughing)');

  await updateSession(from, {
    step: 'request_input',
    data: { farmer_id: 1, farm_size_ha: 2.5 },
  });

  const staleRecapReply = await handleIncoming(from, 'recap_2', null, null, 'Test');
  const staleRecapText = typeof staleRecapReply === 'object' ? JSON.stringify(staleRecapReply) : String(staleRecapReply);
  assert(/earlier message|MENU/i.test(staleRecapText), `recap_2 → stale hint, got: ${staleRecapText.slice(0, 80)}`);
  console.log('OK recap_2 during request_input → stale list hint');

  await pool.query('DELETE FROM farmers WHERE id = $1', [farmerId]);
}

async function run() {
  testListIdHelpers();
  testServiceListMetaLimits();
  try {
    await testWithDb();
  } catch (err) {
    if (/timeout|ECONNREFUSED|Connection terminated/i.test(err.message)) {
      console.log('SKIP DB integration tests (database not reachable)');
      return;
    }
    throw err;
  }
  console.log('All menu routing checks passed.');
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
