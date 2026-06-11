/**
 * WhatsApp interactive list messages — consistent branded option menus.
 * Meta Cloud API: type interactive / list (single-select).
 */
const { sendBrandedText, sendInteractiveList } = require('./whatsapp-sender');

const LIST_HEADER = 'Welcome to Digilync';
/** Exactly 10 words — who Digilync is. */
const DIGILYNC_TAGLINE =
  'DigiLync connects farmers with trusted agricultural service providers across Cameroon.';
const LIST_BUTTON = 'Select an option';

const SERVICE_LIST = [
  'Ploughing', 'Planting', 'Spraying', 'Irrigation', 'Harvesting',
  'Processing', 'Storage', 'Transport', 'Other',
  // Animal / Livestock services
  'Vaccination', 'Deworming', 'Feeding', 'Milking', 'Livestock Transport', 'Animal Health',
];

/**
 * Build a standardized list reply payload for handleIncoming / sendBotReply.
 * @param {string} description - Context shown under the tagline (≤1024 chars total body budget)
 * @param {Array<{id: string, title: string, description?: string}>} rows
 * @param {{ footer?: string }} [opts]
 */
function buildOptionListReply(description, rows, opts = {}) {
  const safeRows = (rows || []).slice(0, 10).map((r) => ({
    id: String(r.id).slice(0, 200),
    title: String(r.title).slice(0, 24),
    description: r.description ? String(r.description).slice(0, 72) : undefined,
  }));
  const bodyParts = [DIGILYNC_TAGLINE];
  if (description) bodyParts.push('', String(description).trim());
  if (opts.footer) bodyParts.push('', String(opts.footer).trim());
  return {
    type: 'interactive_list',
    header: LIST_HEADER,
    body: bodyParts.join('\n').slice(0, 1024),
    buttonText: LIST_BUTTON,
    sections: clampSectionsToMetaLimit([{ title: 'Options', rows: safeRows }]),
  };
}

/** Meta Cloud API: max 10 rows across all sections in one list message. */
const MAX_LIST_ROWS_TOTAL = 10;

function sanitizeListRows(rows) {
  return (rows || []).slice(0, MAX_LIST_ROWS_TOTAL).map((r) => ({
    id: String(r.id).slice(0, 200),
    title: String(r.title).slice(0, 24),
    description: r.description ? String(r.description).slice(0, 72) : undefined,
  }));
}

/** Trim sections so combined row count never exceeds Meta's list limit. */
function clampSectionsToMetaLimit(sections) {
  const out = [];
  let remaining = MAX_LIST_ROWS_TOTAL;
  for (const sec of sections || []) {
    if (remaining <= 0) break;
    const rows = sanitizeListRows(sec.rows).slice(0, remaining);
    if (rows.length) {
      out.push({ title: String(sec.title || 'Options').slice(0, 24), rows });
      remaining -= rows.length;
    }
  }
  return out;
}

function buildServiceRows(prefix = 'svc') {
  return SERVICE_LIST.map((name, i) => ({
    id: `${prefix}_${i + 1}`,
    title: name,
    description: `Service option ${i + 1}`,
  }));
}

/**
 * Service picker (15 options) — paginated to respect Meta's 10-row list cap.
 * Page 1: services 1–9 + "More services"; page 2: services 10–15 + "Earlier services".
 */
function buildServiceListReply(description, opts = {}) {
  const page = opts.page === 2 ? 2 : 1;
  let rows;
  if (page === 2) {
    rows = SERVICE_LIST.slice(9).map((name, i) => ({
      id: `svc_${i + 10}`,
      title: name,
      description: `Service option ${i + 10}`,
    }));
    rows.push({ id: 'svc_page_1', title: 'Earlier services', description: 'Options 1–9' });
  } else {
    rows = SERVICE_LIST.slice(0, 9).map((name, i) => ({
      id: `svc_${i + 1}`,
      title: name,
      description: `Service option ${i + 1}`,
    }));
    rows.push({ id: 'svc_page_2', title: 'More services', description: 'Livestock & more' });
  }
  const bodyParts = [DIGILYNC_TAGLINE];
  if (description) bodyParts.push('', String(description).trim());
  if (opts.footer) bodyParts.push('', String(opts.footer).trim());
  return {
    type: 'interactive_list',
    header: LIST_HEADER,
    body: bodyParts.join('\n').slice(0, 1024),
    buttonText: LIST_BUTTON,
    sections: clampSectionsToMetaLimit([{ title: page === 2 ? 'Livestock & more' : 'Services', rows }]),
  };
}

/**
 * Map list/button IDs and legacy numeric replies to values handleIncoming expects.
 * Note: main_* list IDs are handled before normalization in handleIncoming so they
 * never collide with svc_* service numbers (e.g. main_6 Unsubscribe vs svc_6 Processing).
 */
function normalizeUserChoice(raw) {
  const t = String(raw || '').trim();
  if (!t) return t;

  const lower = t.toLowerCase();
  if (lower === 'agree' || lower === 'i agree') return '1';
  if (lower === 'disagree') return '2';
  if (lower === 'confirm') return '1';
  if (lower === 'cancel') return '2';
  if (lower === 'yes') return '1';
  if (lower === 'no') return '2';

  const patterns = [
    /^main_(\d+)$/i,
    /^opt_(\d+)$/i,
    /^svc_(\d+)$/i,
    /^farm_(\d+)$/i,
    /^recap_(\d+)$/i,
    /^privacy_(\d+)$/i,
    /^prov_(\d+)$/i,
    /^confirm_(\d+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1];
  }

  const acceptM = t.match(/^accept_(\d+)$/i);
  if (acceptM) return `accept ${acceptM[1]}`;
  const rejectM = t.match(/^reject_(\d+)$/i);
  if (rejectM) return `reject ${rejectM[1]}`;

  return t;
}

/** Extract numeric choice from a prefixed list reply id (e.g. main_3 → "3"), or null. */
function matchListId(raw, prefix) {
  const m = String(raw || '').trim().match(new RegExp(`^${prefix}_(\\d+)$`, 'i'));
  return m ? m[1] : null;
}

function isPrefixedListId(raw) {
  return /^(main|opt|svc|farm|recap|privacy|prov|confirm|accept|reject)_\d+$/i.test(String(raw || '').trim());
}

function isListReply(reply) {
  return reply && typeof reply === 'object' && reply.type === 'interactive_list';
}

/**
 * Send plain branded text or an interactive list (optional logo before list).
 */
async function sendBotReply(to, reply) {
  if (!reply) return null;
  if (isListReply(reply)) {
    return sendInteractiveList(to, {
      header: reply.header || LIST_HEADER,
      body: reply.body,
      footer: reply.footer,
      buttonText: reply.buttonText || LIST_BUTTON,
      sections: reply.sections,
    });
  }
  return sendBrandedText(to, String(reply));
}

module.exports = {
  LIST_HEADER,
  DIGILYNC_TAGLINE,
  LIST_BUTTON,
  MAX_LIST_ROWS_TOTAL,
  SERVICE_LIST,
  buildOptionListReply,
  buildServiceRows,
  buildServiceListReply,
  clampSectionsToMetaLimit,
  normalizeUserChoice,
  matchListId,
  isPrefixedListId,
  isListReply,
  sendBotReply,
};
