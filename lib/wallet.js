// All money + order state lives in Postgres (bot_* tables) and is changed ONLY through
// the atomic SQL functions in supabase/migrations. Errors are thrown, never swallowed.
const axios = require('axios');

const RAW = (process.env.BOT_DB_URL || process.env.MJ_HUB_REST_URL || process.env.MJ_HUB_SUPABASE_URL || process.env.MJHUB_SUPABASE_URL || '').replace(/\/$/, '');
const REST = RAW && !/\/rest\/v1$/i.test(RAW) ? `${RAW}/rest/v1` : RAW;
const KEY = process.env.BOT_DB_SERVICE_KEY || process.env.MJ_HUB_SERVICE_KEY || process.env.MJ_HUB_SUPABASE_SERVICE_KEY || process.env.MJHUB_SERVICE_KEY || '';
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const cfg = { headers, timeout: 15000 };

function assertConfigured() {
  if (!REST || !KEY) throw new Error('Database env missing (MJ_HUB_REST_URL / MJ_HUB_SERVICE_KEY)');
}

async function rpc(fn, args) {
  assertConfigured();
  const r = await axios.post(`${REST}/rpc/${fn}`, args, cfg);
  return Array.isArray(r.data) ? r.data[0] : r.data;
}
async function select(path) {
  assertConfigured();
  return (await axios.get(`${REST}/${path}`, cfg)).data;
}

const uid = (u) => String(u);

async function balance(userId) {
  const rows = await select(`bot_wallets?user_id=eq.${encodeURIComponent(uid(userId))}&select=balance`);
  return rows[0] ? Number(rows[0].balance) : 0;
}

/** Idempotent: the same (kind, ref) is applied once. -> { applied, balance } */
async function credit(userId, amount, kind, ref, meta = null) {
  const r = await rpc('bot_credit', { p_user: uid(userId), p_amount: Math.round(amount), p_kind: kind, p_ref: String(ref), p_meta: meta });
  return { applied: !!r.applied, balance: Number(r.balance) };
}

/** Atomic: fails (ok=false) if balance is too low. -> { ok, balance } */
async function debit(userId, amount, kind, ref, meta = null) {
  const r = await rpc('bot_debit', { p_user: uid(userId), p_amount: Math.round(amount), p_kind: kind, p_ref: String(ref), p_meta: meta });
  return { ok: !!r.ok, balance: Number(r.balance) };
}

/** Refund an order exactly once. -> { refunded, balance, amount, userId } */
async function refundOrder(provider, orderId, status = 'cancelled') {
  const r = await rpc('bot_refund_order', { p_provider: provider, p_order_id: String(orderId), p_status: status });
  return { refunded: !!r.refunded, balance: Number(r.balance), amount: Number(r.amount), userId: r.user_id };
}

/** Store OTP once (never on a refunded order). -> { delivered, userId } */
async function completeOrder(provider, orderId, code) {
  const r = await rpc('bot_complete_order', { p_provider: provider, p_order_id: String(orderId), p_code: String(code) });
  return { delivered: !!r.delivered, userId: r.user_id };
}

async function createOrder(row) {
  assertConfigured();
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await axios.post(`${REST}/bot_orders`, row, { ...cfg, headers: { ...headers, Prefer: 'return=minimal' } });
      return true;
    } catch (e) {
      lastErr = e;
      if (e.response?.status === 409) return true; // already stored
    }
  }
  console.error('CRITICAL createOrder failed', row.provider, row.order_id, lastErr?.response?.data || lastErr?.message);
  return false;
}

async function getOrder(provider, orderId) {
  const rows = await select(`bot_orders?provider=eq.${provider}&order_id=eq.${encodeURIComponent(String(orderId))}&select=*`);
  return rows[0] || null;
}

async function listOrders(userId, limit = 10) {
  return select(`bot_orders?user_id=eq.${encodeURIComponent(uid(userId))}&select=*&order=created_at.desc&limit=${limit}`);
}

// ----- per-user chat state (no money in here) -----
async function getSession(userId) {
  try {
    const rows = await select(`bot_sessions?user_id=eq.${encodeURIComponent(uid(userId))}&select=data`);
    return rows[0]?.data || {};
  } catch (e) {
    console.error('getSession', e.message);
    return {};
  }
}
async function saveSession(userId, data) {
  try {
    assertConfigured();
    await axios.post(`${REST}/bot_sessions`, { user_id: uid(userId), data, updated_at: new Date().toISOString() },
      { ...cfg, headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' } });
  } catch (e) {
    console.error('saveSession', e.response?.data || e.message); // chat state only; safe to lose
  }
}

async function stats() {
  const [w, o] = await Promise.all([
    select('bot_wallets?select=balance'),
    select('bot_orders?select=provider,status,price&limit=5000')
  ]);
  return {
    users: w.length,
    held: w.reduce((a, r) => a + Number(r.balance || 0), 0),
    orders: o.length,
    done: o.filter((x) => x.status === 'completed').length,
    sales: o.filter((x) => x.status === 'completed').reduce((a, r) => a + Number(r.price || 0), 0)
  };
}

module.exports = { balance, credit, debit, refundOrder, completeOrder, createOrder, getOrder, listOrders, getSession, saveSession, stats };
