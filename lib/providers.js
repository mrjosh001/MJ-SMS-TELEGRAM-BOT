// One small adapter per SMS supplier, same shape, so buying / OTP / cancel / refund
// logic is written once in the bot and works for every server.
//
//   buy(serviceId, countryId)  -> { ok, orderId, number, message, busy }
//   status(orderId)            -> { state: 'code' | 'waiting' | 'expired' | 'error', code, message }
//   cancel(orderId)            -> { ok, early, message }
const axios = require('axios');

const http = { timeout: 25000, headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'MJ-SMS-Bot/3.0' } };
const txt = (d) => (typeof d === 'string' ? d.trim() : JSON.stringify(d ?? ''));

// ---------------- Server 1 · GrizzlySMS ----------------
const GRIZZLY_BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const grizzlyKey = () => (process.env.GRIZZLYSMS_API_KEY || '').trim();
const grizzlyGet = async (params) => (await axios.get(GRIZZLY_BASE, { ...http, params: { api_key: grizzlyKey(), ...params } })).data;

const grizzly = {
  id: 'grizzly',
  server: 1,
  label: 'Server 1',
  cancelMinMs: (Number(process.env.MIN_CANCEL_SECONDS) || 180) * 1000,
  expiryMs: 20 * 60 * 1000,

  async buy(serviceId, countryId) {
    try {
      const raw = await grizzlyGet({ action: 'getNumber', service: serviceId, country: String(countryId) });
      const t = txt(raw);
      if (t.startsWith('ACCESS_NUMBER')) {
        const [, orderId, number] = t.split(':');
        return { ok: true, orderId, number };
      }
      if (/NO_BALANCE/i.test(t)) return { ok: false, busy: true, message: 'Server 1 is temporarily unavailable.' };
      if (/NO_NUMBERS/i.test(t)) return { ok: false, message: 'No stock for that option right now.' };
      return { ok: false, message: 'No number available right now.' };
    } catch (e) {
      return { ok: false, busy: true, message: 'Server 1 is busy. Try again in a moment.' };
    }
  },

  async status(orderId) {
    try {
      const t = txt(await grizzlyGet({ action: 'getStatus', id: orderId }));
      if (t.startsWith('STATUS_OK')) return { state: 'code', code: t.split(':')[1] };
      if (/STATUS_CANCEL/i.test(t)) return { state: 'expired' };
      if (/STATUS_WAIT/i.test(t)) return { state: 'waiting' };
      return { state: 'error', message: t };
    } catch (e) {
      return { state: 'error', message: e.message };
    }
  },

  async cancel(orderId) {
    try {
      const t = txt(await grizzlyGet({ action: 'setStatus', id: String(orderId).trim(), status: '8' }));
      if (/ACCESS_CANCEL/i.test(t)) return { ok: true };
      if (/BAD_STATUS|STATUS_CANCEL/i.test(t)) return { ok: true, message: 'already closed' };
      if (/EARLY_CANCEL|TOO_EARLY/i.test(t)) return { ok: false, early: true, message: 'Supplier still blocking cancel. Try again shortly.' };
      return { ok: false, message: 'Could not cancel right now. Try again shortly.' };
    } catch (e) {
      return { ok: false, message: 'Supplier unreachable. Try again in a few minutes.' };
    }
  },

  async balance() {
    try {
      const t = txt(await grizzlyGet({ action: 'getBalance' }));
      return t.startsWith('ACCESS_BALANCE') ? t.split(':')[1] : null;
    } catch (_) { return null; }
  },
  raw: grizzlyGet
};

// ---------------- Server 2 · SMS-Bus (same account the website uses) ----------------
const BUS_BASE = 'https://sms-bus.com/api/control';
const busToken = () => process.env.SMSBUS_API_TOKEN || process.env.SMS_BUS_TOKEN || '';
const busOk = (d) => d && (d.code === 200 || d.code === '200');

async function busGet(path, params = {}) {
  const token = busToken();
  if (!token) throw new Error('SMSBUS_API_TOKEN is not configured');
  const r = await axios.get(`${BUS_BASE}${path}`, { ...http, params: { token, ...params }, validateStatus: () => true });
  return r.data && typeof r.data === 'object' ? r.data : {};
}

const smsbus = {
  id: 'smsbus',
  server: 2,
  label: 'Server 2',
  cancelMinMs: 60 * 1000,        // supplier minimum is ~30s
  expiryMs: 5 * 60 * 1000,       // numbers live 5 minutes

  async buy(projectId, countryId) {
    try {
      const d = await busGet('/get/number', { country_id: String(countryId), project_id: String(projectId) });
      if (busOk(d) && d.data?.request_id) return { ok: true, orderId: String(d.data.request_id), number: String(d.data.number || '') };
      if (d.code === 50201 || /balance not enough/i.test(String(d.message || ''))) {
        return { ok: false, busy: true, message: 'Server 2 is temporarily unavailable. Try Server 1.' };
      }
      return { ok: false, message: 'No number available right now. Try another option.' };
    } catch (e) {
      return { ok: false, busy: true, message: 'Server 2 is busy. Try again in a moment.' };
    }
  },

  async status(orderId) {
    try {
      const d = await busGet('/get/sms', { request_id: String(orderId) });
      if (busOk(d) && d.data) return { state: 'code', code: String(d.data) };
      if (d.code === 50101 || /not received sms yet/i.test(String(d.message || ''))) return { state: 'waiting' };
      if (d.code === 50102 || /released|timeout/i.test(String(d.message || ''))) return { state: 'expired' };
      return { state: 'error', message: String(d.message || d.code || '') };
    } catch (e) {
      return { state: 'error', message: e.message };
    }
  },

  async cancel(orderId) {
    try {
      const d = await busGet('/cancel', { request_id: String(orderId) });
      if (busOk(d)) return { ok: true };
      // 50103 = already closed, 50102 = released/timeout: nothing left to cancel at the supplier
      if (d.code === 50103 || d.code === 50102 || /already closed|closed|timeout|released/i.test(String(d.message || ''))) {
        return { ok: true, message: 'already closed' };
      }
      return { ok: false, message: 'Could not cancel right now. Try again shortly.' };
    } catch (e) {
      return { ok: false, message: 'Supplier unreachable. Try again in a few minutes.' };
    }
  },

  async balance() {
    try {
      const d = await busGet('/get/balance');
      return busOk(d) ? String(d.data) : null;
    } catch (_) { return null; }
  },
  get: busGet,
  ok: busOk
};

const providers = { grizzly, smsbus };
const byServer = { 1: grizzly, 2: smsbus };

module.exports = { providers, byServer, grizzly, smsbus };
