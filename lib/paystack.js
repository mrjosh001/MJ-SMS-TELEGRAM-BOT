// Money is only ever credited from a payment that Paystack itself confirms
// (server-to-server verify by reference) — never from numbers in an incoming request body.
const axios = require('axios');

const SECRET = () => process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET || '';
const PRODUCT = 'mj_sms_bot_wallet';
const MIN_FUND = 1000;
const MAX_FUND = 200000;

async function initialize(amountNgn, telegramUserId, email) {
  if (!SECRET()) return { success: false, message: 'Funding is not configured yet. Please contact support.' };
  const amount = Math.min(MAX_FUND, Math.max(MIN_FUND, Math.ceil(Number(amountNgn) || 0)));
  const reference = `MJSMS_${telegramUserId}_${Date.now()}`;
  const mail = email && String(email).includes('@') ? String(email).trim() : `tg${telegramUserId}@mjhub.store`;
  try {
    const res = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: mail, amount: amount * 100, currency: 'NGN', reference,
      metadata: { telegram_user_id: String(telegramUserId), product: PRODUCT, amount_ngn: amount }
    }, { timeout: 25000, headers: { Authorization: `Bearer ${SECRET()}`, 'Content-Type': 'application/json' } });
    const d = res.data?.data;
    if (!d?.authorization_url) return { success: false, message: res.data?.message || 'Paystack returned no link' };
    return { success: true, reference: d.reference || reference, amount_ngn: amount, authorization_url: d.authorization_url };
  } catch (e) {
    console.error('paystack init', e.response?.data || e.message);
    return { success: false, message: e.response?.data?.message || 'Paystack init failed' };
  }
}

/** -> { success, amount_ngn, reference, telegram_user_id, message } — only trust this result */
async function verify(reference) {
  if (!SECRET()) return { success: false, message: 'Funding is not configured' };
  if (!reference) return { success: false, message: 'Reference missing' };
  try {
    const res = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { timeout: 25000, headers: { Authorization: `Bearer ${SECRET()}` } });
    const d = res.data?.data;
    if (!d) return { success: false, message: 'No verify data' };
    const paid = String(d.status).toLowerCase() === 'success';
    const ours = d.metadata?.product === PRODUCT && String(d.currency || 'NGN').toUpperCase() === 'NGN';
    return {
      success: paid && ours,
      status: d.status,
      amount_ngn: Math.round((Number(d.amount) || 0) / 100),
      reference: d.reference || reference,
      telegram_user_id: d.metadata?.telegram_user_id ? String(d.metadata.telegram_user_id) : null,
      message: paid ? (ours ? 'Payment successful' : 'Not a wallet payment') : `Payment status: ${d.status}`
    };
  } catch (e) {
    console.error('paystack verify', e.response?.data || e.message);
    return { success: false, message: e.response?.data?.message || 'Could not verify payment' };
  }
}

module.exports = { initialize, verify, MIN_FUND, MAX_FUND };
