/**
 * Payout adapter
 * Provides a simple abstraction for queuing/processing payouts to providers.
 * Drivers: 'stub' (default), 'mobile_money' (not implemented here)
 */
const util = require('util');

const DRIVER = process.env.PAYOUT_DRIVER || 'stub';

async function queuePayout({ providerId, amountFcfa, method = 'mobile_money', providerDetails = {} }) {
  // In production this would enqueue a job into Redis/RQ/Bull or call a payment provider SDK.
  if (DRIVER === 'mobile_money') {
    // Placeholder for mobile money driver; configuration required in env
    // For now, we fall back to stub behaviour.
    return stubPayout({ providerId, amountFcfa, method, providerDetails });
  }
  return stubPayout({ providerId, amountFcfa, method, providerDetails });
}

async function stubPayout({ providerId, amountFcfa, method, providerDetails }) {
  const info = {
    providerId,
    amountFcfa,
    method,
    providerDetails,
    timestamp: new Date().toISOString(),
    status: 'queued',
    note: 'Stub payout: no external provider configured',
  };
  // Log for operators to review
  console.log('[PayoutAdapter] stub queuePayout:', util.inspect(info, { depth: 2 }));
  // Simulate async processing delay
  await new Promise((r) => setTimeout(r, 200));
  return { success: true, queued: true, info };
}

module.exports = {
  queuePayout,
};
