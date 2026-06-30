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
    sections: [{ title: 'Options', rows: safeRows }],
  };
}

function buildServiceRows(prefix = 'svc') {
  return SERVICE_LIST.map((name, i) => ({
    id: `${prefix}_${i + 1}`,
    title: name,
    description: `Service option ${i + 1}`,
  }));
}

/**
 * Map list/button IDs and legacy numeric replies to values handleIncoming expects.
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

  if (lower === 'main_job') return 'job_menu';

  const patterns = [
    /^main_(\d+)$/i,
    /^opt_(\d+)$/i,
    /^svc_(\d+)$/i,
    /^farm_(\d+)$/i,
    /^recap_(\d+)$/i,
    /^privacy_(\d+)$/i,
    /^prov_(\d+)$/i,
    /^confirm_(\d+)$/i,
    /^job_(\d+)$/i,
    /^pick_prov_(\d+)$/i,
    /^jobctl_(\d+)$/i,
    /^rate_(\d+)$/i,
    /^slot_(\d+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      if (re.source.startsWith('^job_')) return `job_${m[1]}`;
      if (re.source.startsWith('^rate_')) return `rate_${m[1]}`;
      if (re.source.startsWith('^pick_prov_')) return `pick_prov_${m[1]}`;
      if (re.source.startsWith('^jobctl_')) return `jobctl_${m[1]}`;
      if (re.source.startsWith('^slot_')) return `slot_${m[1]}`;
      return m[1];
    }
  }

  const acceptM = t.match(/^accept_(\d+)$/i);
  if (acceptM) return `accept ${acceptM[1]}`;
  const rejectM = t.match(/^reject_(\d+)$/i);
  if (rejectM) return `reject ${rejectM[1]}`;

  const jobCmdM = t.match(/^(start|end|pause|resume)_(\d+)$/i);
  if (jobCmdM) return `${jobCmdM[1].toLowerCase()} ${jobCmdM[2]}`;

  if (lower === 'decline') return 'reject';

  return t;
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
  SERVICE_LIST,
  buildOptionListReply,
  buildServiceRows,
  normalizeUserChoice,
  isListReply,
  sendBotReply,
};
