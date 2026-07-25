const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JUICYSMS_API_KEY = process.env.JUICYSMS_API_KEY;
const SMSOTPSTORES_API_KEY = process.env.SMSOTPSTORES_API_KEY;
const AUTHPADI_API_KEY = process.env.AUTHPADI_API_KEY;
const ALLSMSVERIFY_API_KEY = process.env.ALLSMSVERIFY_API_KEY;
const BEESMS_API_KEY = process.env.BEESMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const SUPABASE_REST_URL = process.env.SUPABASE_REST_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ADMIN_TELEGRAM_ID = '7466363018';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const robustAxiosConfig = {
  timeout: 20000,
  httpsAgent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
};

const supabaseHeaders = {
  'apikey': SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.trim() : '',
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.trim() : ''}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function getUserSession(userId) {
  try {
    const res = await axios.get(`${SUPABASE_REST_URL}/user_sessions?user_id=eq.${userId}&select=*`, {
      ...robustAxiosConfig,
      headers: supabaseHeaders
    });
    if (res.data && res.data.length > 0) {
      const row = res.data[0];
      return {
        balance: parseFloat(row.balance || 0),
        state: row.state || 'AWAITING_INPUT',
        country: row.country || null,
        selectedServiceQuery: row.selected_service_query || null,
        chosenProvider: row.chosen_provider || null,
        orders: row.orders || [],
        transactions: row.transactions || []
      };
    }
  } catch (err) {}

  const defaultSession = {
    balance: 0,
    state: 'AWAITING_INPUT',
    country: null,
    selectedServiceQuery: null,
    chosenProvider: null,
    orders: [],
    transactions: []
  };
  await saveUserSession(userId, defaultSession);
  return defaultSession;
}

async function saveUserSession(userId, session) {
  try {
    const payload = {
      user_id: String(userId),
      balance: session.balance,
      state: session.state,
      country: session.country,
      selected_service_query: session.selectedServiceQuery,
      chosen_provider: session.chosenProvider,
      orders: session.orders,
      transactions: session.transactions,
      updated_at: new Date().toISOString()
    };

    await axios.post(`${SUPABASE_REST_URL}/user_sessions`, payload, {
      ...robustAxiosConfig,
      headers: { ...supabaseHeaders, 'Prefer': 'resolution=merge-duplicates' }
    });
  } catch (err) {}
}

async function addOrderToDb(userId, orderRecord) {
  const session = await getUserSession(userId);
  session.orders.push(orderRecord);
  await saveUserSession(userId, session);
}

async function updateOrderStatusInDb(orderId, newStatus) {
  try {
    const res = await axios.get(`${SUPABASE_REST_URL}/user_sessions?select=*`, {
      ...robustAxiosConfig,
      headers: supabaseHeaders
    });
    if (res.data) {
      for (const row of res.data) {
        let updated = false;
        const orders = row.orders || [];
        orders.forEach(o => {
          if (String(o.orderId) === String(orderId)) {
            o.status = newStatus;
            updated = true;
          }
        });
        if (updated) {
          await axios.patch(`${SUPABASE_REST_URL}/user_sessions?user_id=eq.${row.user_id}`, { orders }, {
            ...robustAxiosConfig,
            headers: supabaseHeaders
          });
          break;
        }
      }
    }
  } catch (err) {}
}

const USD_TO_NGN_RATE = 1500; 

function calculateFinalPrice(rawPrice, isAlreadyNgn = false) {
  const numericPrice = parseFloat(rawPrice) || 0;
  const baseCostNgn = isAlreadyNgn ? numericPrice : (numericPrice * USD_TO_NGN_RATE);
  if (baseCostNgn <= 0) return 3000;

  if (baseCostNgn < 3000) {
    return Math.ceil(baseCostNgn + 3000);
  } else {
    return Math.ceil(baseCostNgn * 1.8);
  }
}

async function initializePaystackPayment(email, amountNgn, userId) {
  if (!PAYSTACK_SECRET_KEY) return { status: false, message: "Paystack secret key is missing." };
  try {
    const res = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      { email: email, amount: Math.round(amountNgn * 100), metadata: { telegram_id: String(userId) } },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.trim()}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
  } catch (err) {
    return { status: false, message: "Could not create payment link." };
  }
}

const JUICYSMS_BASE_URL = 'https://juicysms.com/api';
const SMSOTPSTORES_BASE_URL = 'https://smsotpstores.com';
const AUTHPADI_BASE_URL = 'https://dashboard.authpadi.com';
const ALLSMSVERIFY_BASE_URL = 'https://allsmsverify.com';
const BEESMS_BASE_URL = 'https://api.bee-sms.com/v1';

const COUNTRY_ALIASES = {
  'usa': { id: 'us', name: 'United States (US)' },
  'us': { id: 'us', name: 'United States (US)' },
  'united states': { id: 'us', name: 'United States (US)' },
  'uk': { id: 'gb', name: 'United Kingdom (UK)' },
  'united kingdom': { id: 'gb', name: 'United Kingdom (UK)' },
  'ng': { id: 'ng', name: 'Nigeria (NG)' },
  'nigeria': { id: 'ng', name: 'Nigeria (NG)' },
  'canada': { id: 'ca', name: 'Canada (CA)' },
  'ca': { id: 'ca', name: 'Canada (CA)' },
  'venezuela': { id: 've', name: 'Venezuela (VE)' },
  've': { id: 've', name: 'Venezuela (VE)' },
  'ghana': { id: 'gh', name: 'Ghana (GH)' },
  'gh': { id: 'gh', name: 'Ghana (GH)' }
};

function intelligentTranslateCountry(rawCountry) {
  if (!rawCountry) return { id: 'us', name: 'United States (US)' };
  let cleaned = rawCountry.toLowerCase().trim();
  if (COUNTRY_ALIASES[cleaned]) {
    return COUNTRY_ALIASES[cleaned];
  }
  return { id: cleaned.substring(0, 2), name: rawCountry.toUpperCase() };
}

async function getJuicySmsServices(countryId) {
  try {
    const params = { country: countryId || 'US' };
    if (JUICYSMS_API_KEY) params.key = JUICYSMS_API_KEY.trim();
    const res = await axios.get(`${JUICYSMS_BASE_URL}/services`, { ...robustAxiosConfig, params });
    let data = res.data;
    if (data && data.services) data = data.services;
    if (Array.isArray(data)) {
      return data.map(item => ({
        service_id: String(item.id || item.serviceId || item.code || ''),
        service_name: String(item.title || item.name || item.service_name || item.service_id || ''),
        stock: parseInt(item.count || item.stock || item.quantity || 100, 10),
        price: parseFloat(item.price || item.cost || 0),
        is_ngn: false
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) { return []; }
}

async function getSmsOtpStoresServices(countryId) {
  try {
    const cleanApiKey = SMSOTPSTORES_API_KEY ? SMSOTPSTORES_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const targetCountry = countryId === 'us' ? 'usa' : countryId;
    const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'services', country: targetCountry }
    });
    const data = res.data;
    let list = Array.isArray(data?.services) ? data.services : (Array.isArray(data) ? data : []);
    return list.map(item => ({
      service_id: String(item.id || item.service_id || item.code || ''),
      service_name: String(item.name || item.title || item.service_name || item.id || ''),
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || item.cost || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) { return []; }
}

async function getAuthPadiServices(countryId) {
  try {
    const cleanApiKey = AUTHPADI_API_KEY ? AUTHPADI_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'getServicesList', country: countryId }
    });
    const data = res.data;
    let list = [];
    if (data && Array.isArray(data.services)) list = data.services;
    else if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') {
      list = Object.keys(data).map(k => ({ id: k, ...data[k] }));
    }
    return list.map(item => ({
      service_id: String(item.id || item.service_id || item.code || ''),
      service_name: String(item.name || item.title || item.service_name || item.service || item.id || ''),
      stock: parseInt(item.stock || item.count || item.quantity || 100, 10),
      price: parseFloat(item.price || item.cost || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) { return []; }
}

async function getAllSmsVerifyServices(countryId) {
  try {
    const cleanApiKey = ALLSMSVERIFY_API_KEY ? ALLSMSVERIFY_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/stubs/handler_api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'getServicesList', country: countryId }
    });
    const data = res.data;
    let list = [];
    if (data && Array.isArray(data.services)) list = data.services;
    else if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') {
      list = Object.keys(data).map(k => ({ id: k, ...data[k] }));
    }
    return list.map(item => ({
      service_id: String(item.id || item.service_id || item.code || ''),
      service_name: String(item.name || item.title || item.service_name || item.service || item.id || ''),
      stock: parseInt(item.stock || item.count || item.quantity || 100, 10),
      price: parseFloat(item.price || item.cost || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) { return []; }
}

async function getBeeSmsServices(countryId) {
  try {
    const cleanApiKey = BEESMS_API_KEY ? BEESMS_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const res = await axios.get(`${BEESMS_BASE_URL}/otp/prices`, {
      ...robustAxiosConfig,
      params: { token: cleanApiKey, area: countryId }
    });
    const data = res.data;
    if (data && data.code === 200 && Array.isArray(data.data)) {
      return data.data.map(item => ({
        service_id: String(item.service_code || ''),
        service_name: String(item.service_name || item.service_code || ''),
        stock: parseInt(item.qty || 100, 10),
        price: parseFloat(item.amount || 0) / 100,
        is_ngn: false
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) { return []; }
}

async function fetchCombinedServices(country) {
  const results = [];
  const countryObj = typeof country === 'string' ? { id: country, name: country } : country;
  if (!countryObj || !countryObj.id) return results;
  const cId = countryObj.id;

  const [juicy, store, auth, allsms, beesms] = await Promise.allSettled([
    JUICYSMS_API_KEY ? getJuicySmsServices(cId) : Promise.resolve([]),
    SMSOTPSTORES_API_KEY ? getSmsOtpStoresServices(cId) : Promise.resolve([]),
    AUTHPADI_API_KEY ? getAuthPadiServices(cId) : Promise.resolve([]),
    ALLSMSVERIFY_API_KEY ? getAllSmsVerifyServices(cId) : Promise.resolve([]),
    BEESMS_API_KEY ? getBeeSmsServices(cId) : Promise.resolve([])
  ]);

  if (juicy.status === 'fulfilled') juicy.value.forEach(s => results.push({ provider: 'juicysms', server_label: 'Server One', ...s }));
  if (store.status === 'fulfilled') store.value.forEach(s => results.push({ provider: 'smsotpstores', server_label: 'Server Two', ...s }));
  if (auth.status === 'fulfilled') auth.value.forEach(s => results.push({ provider: 'authpadi', server_label: 'Server Three', ...s }));
  if (allsms.status === 'fulfilled') allsms.value.forEach(s => results.push({ provider: 'allsmsverify', server_label: 'Server Four', ...s }));
  if (beesms.status === 'fulfilled') beesms.value.forEach(s => results.push({ provider: 'beesms', server_label: 'Server Five', ...s }));

  return results;
}

async function executeOrder(provider, serviceId, countryId) {
  try {
    if (provider === 'beesms') {
      const res = await axios.get(`${BEESMS_BASE_URL}/otp/purchase`, {
        ...robustAxiosConfig,
        params: { token: BEESMS_API_KEY.trim(), area: countryId, service: serviceId }
      });
      const data = res.data;
      if (data && data.code === 200 && data.data) {
        return { success: true, data: { order_id: data.data.order_id, number: `${data.data.dialing_code || ''}${data.data.mobile_number}` } };
      }
      return { success: false, message: data?.message || 'Failed' };
    } else if (provider === 'allsmsverify' || provider === 'authpadi') {
      const baseUrl = provider === 'allsmsverify' ? ALLSMSVERIFY_BASE_URL : AUTHPADI_BASE_URL;
      const apiKey = provider === 'allsmsverify' ? ALLSMSVERIFY_API_KEY : AUTHPADI_API_KEY;
      const res = await axios.get(`${baseUrl}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: apiKey.trim(), action: 'getNumber', service: serviceId, country: countryId }
      });
      const respStr = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
      if (respStr.startsWith('ACCESS_NUMBER')) {
        const parts = respStr.split(':');
        return { success: true, data: { order_id: parts[1], number: parts[2] } };
      }
      return { success: false, message: respStr };
    } else if (provider === 'smsotpstores') {
      const targetCountry = countryId === 'us' ? 'usa' : countryId;
      const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: SMSOTPSTORES_API_KEY.trim(), action: 'order', service_id: serviceId, country: targetCountry }
      });
      if (res.data && (res.data.success || res.data.order_id)) {
        return { success: true, data: { order_id: res.data.order_id, number: res.data.phone_number || res.data.number } };
      }
      return { success: false, message: res.data?.message || 'Failed' };
    } else {
      const res = await axios.get(`${JUICYSMS_BASE_URL}/makeorder`, {
        ...robustAxiosConfig,
        params: { key: JUICYSMS_API_KEY.trim(), serviceId: serviceId, country: countryId }
      });
      const respText = typeof res.data === 'string' ? res.data.trim() : '';
      if (respText.startsWith('ORDER_ID_')) {
        const parts = respText.split('_');
        return { success: true, data: { order_id: parts[2], number: parts.slice(4).join('_') } };
      }
      return { success: false, message: respText };
    }
  } catch (err) {
    return { success: false, message: 'Request failed.' };
  }
}

async function checkSmsCode(provider, orderId) {
  try {
    if (provider === 'beesms') {
      const res = await axios.get(`${BEESMS_BASE_URL}/otp/sms`, {
        ...robustAxiosConfig,
        params: { token: BEESMS_API_KEY.trim(), order: orderId }
      });
      const data = res.data;
      if (data && data.code === 200 && data.data) {
        return { success: true, data: { code: data.data } };
      }
    } else if (provider === 'allsmsverify' || provider === 'authpadi') {
      const baseUrl = provider === 'allsmsverify' ? ALLSMSVERIFY_BASE_URL : AUTHPADI_BASE_URL;
      const apiKey = provider === 'allsmsverify' ? ALLSMSVERIFY_API_KEY : AUTHPADI_API_KEY;
      const res = await axios.get(`${baseUrl}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: apiKey.trim(), action: 'getStatus', id: orderId }
      });
      const respStr = typeof res.data === 'string' ? res.data.trim() : '';
      if (respStr.startsWith('STATUS_OK')) {
        return { success: true, data: { code: respStr.split(':')[1] } };
      }
    } else if (provider === 'smsotpstores') {
      const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: SMSOTPSTORES_API_KEY.trim(), action: 'status', order_id: orderId }
      });
      if (res.data && res.data.code) return { success: true, data: { code: res.data.code } };
    } else {
      const res = await axios.get(`${JUICYSMS_BASE_URL}/getsms`, {
        ...robustAxiosConfig,
        params: { key: JUICYSMS_API_KEY.trim(), orderId: orderId }
      });
      const respText = typeof res.data === 'string' ? res.data.trim() : '';
      if (respText.startsWith('SUCCESS_')) return { success: true, data: { code: respText.replace('SUCCESS_', '') } };
    }
    return { success: false };
  } catch (err) { return { success: false }; }
}

async function cancelOrder(provider, orderId) {
  try {
    if (provider === 'beesms') {
      await axios.get(`${BEESMS_BASE_URL}/otp/cancel`, {
        ...robustAxiosConfig,
        params: { token: BEESMS_API_KEY.trim(), order: orderId }
      });
    } else if (provider === 'allsmsverify' || provider === 'authpadi') {
      const baseUrl = provider === 'allsmsverify' ? ALLSMSVERIFY_BASE_URL : AUTHPADI_BASE_URL;
      const apiKey = provider === 'allsmsverify' ? ALLSMSVERIFY_API_KEY : AUTHPADI_API_KEY;
      await axios.get(`${baseUrl}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: apiKey.trim(), action: 'setStatus', id: orderId, status: 8 }
      });
    } else if (provider === 'smsotpstores') {
      await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: SMSOTPSTORES_API_KEY.trim(), action: 'cancel', order_id: orderId }
      });
    } else {
      await axios.get(`${JUICYSMS_BASE_URL}/cancelorder`, {
        ...robustAxiosConfig,
        params: { key: JUICYSMS_API_KEY.trim(), orderId: orderId }
      });
    }
  } catch (err) {}
}

bot.command(['servers', 'server'], async (ctx) => {
  const adminId = String(ctx.from.id);
  if (adminId !== ADMIN_TELEGRAM_ID) {
    return ctx.reply(`❌ Unauthorized.`);
  }

  ctx.reply(`Checking all servers status & balances... ⏳`);
  let statusReport = `🖥️ *BACKEND SERVER STATUS REPORT*\n\n`;

  try {
    const res = await axios.get(`${JUICYSMS_BASE_URL}/balance`, { ...robustAxiosConfig, params: { key: JUICYSMS_API_KEY } });
    statusReport += `• *Server One:* ✅ ONLINE (Bal: ${res.data?.balance || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server One:* ❌ OFFLINE\n`; }

  try {
    const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, { ...robustAxiosConfig, params: { api_key: SMSOTPSTORES_API_KEY, action: 'balance' } });
    statusReport += `• *Server Two:* ✅ ONLINE (Bal: ${res.data?.balance || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Two:* ❌ OFFLINE\n`; }

  try {
    const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, { ...robustAxiosConfig, params: { api_key: AUTHPADI_API_KEY, action: 'getBalance' } });
    statusReport += `• *Server Three:* ✅ ONLINE (${res.data || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Three:* ❌ OFFLINE\n`; }

  try {
    const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/stubs/handler_api.php`, { ...robustAxiosConfig, params: { api_key: ALLSMSVERIFY_API_KEY, action: 'getBalance' } });
    statusReport += `• *Server Four:* ✅ ONLINE (${res.data || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Four:* ❌ OFFLINE\n`; }

  try {
    const res = await axios.get(`${BEESMS_BASE_URL}/user/balance`, { ...robustAxiosConfig, params: { token: BEESMS_API_KEY } });
    const balDollars = res.data?.data ? (res.data.data / 100).toFixed(2) : 'Active';
    statusReport += `• *Server Five:* ✅ ONLINE ($${balDollars})\n`;
  } catch (e) { statusReport += `• *Server Five:* ❌ OFFLINE\n`; }

  ctx.reply(statusReport, { parse_mode: 'Markdown' });
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  session.state = 'AWAITING_INPUT';
  await saveUserSession(userId, session);
  ctx.reply(`Oya boss! Welcome to *MJ SMS*! Type any country and service name naturally in one go (e.g., *Ghana WhatsApp*, *USA Telegram*). ✨`, { parse_mode: 'Markdown' });
});

bot.command(['balance', 'bal'], async (ctx) => {
  const session = await getUserSession(ctx.from.id);
  ctx.reply(`Boss your current balance na ₦${(session.balance || 0).toLocaleString()} ✨`, { parse_mode: 'Markdown' });
});

bot.command(['fund', 'deposit', 'topup'], async (ctx) => {
  const session = await getUserSession(ctx.from.id);
  session.state = 'AWAITING_DEPOSIT_AMOUNT';
  await saveUserSession(ctx.from.id, session);
  ctx.reply(`💳 Enter the amount you want to deposit in Naira (e.g., *1000*, *2000*):`, { parse_mode: 'Markdown' });
});

bot.command('orders', async (ctx) => {
  const session = await getUserSession(ctx.from.id);
  if (!session.orders || session.orders.length === 0) return ctx.reply(`📭 No order history yet.`);
  const history = session.orders.slice(-10).reverse().map(o => `• ${o.serviceName} | \`${o.phoneNumber}\` | ₦${o.price} | ${o.status}`).join('\n');
  ctx.reply(`📦 *YOUR ORDERS*\n\n${history}`, { parse_mode: 'Markdown' });
});

async function processWithAiAgent(userMessage) {
  if (!OPENAI_API_KEY) {
    console.log("[AI Error] OPENAI_API_KEY is missing.");
    return null;
  }
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: `You are Josh, the owner and operator of MJ SMS. You talk in friendly, confident Nigerian Pidgin mixed with English ("Oya boss", "No wahala", etc.). 
          Your business is an automated SMS verification platform where people can buy cheap OTP numbers for WhatsApp, Telegram, etc., and fund their wallets via Paystack.
          
          Analyze the user message and return ONLY a valid JSON object with keys:
          - "intent": choose from ["order", "faq", "fund", "greeting", "chat"]
          - "country": extracted country name if they want to buy a number, otherwise null
          - "service": extracted app name if they want to buy a number, otherwise null
          - "reply": your exact text response to the user written like YOU (Josh) are chatting with them personally. Use this if the intent is "faq", "fund", "greeting", or "chat". Set to null if intent is "order".

          Examples of FAQ answers you should give in your voice:
          - How to fund: "Oya boss, just type /fund or /deposit, put the amount in Naira, and pay through the secure Paystack link. Your balance will land sharp sharp!"
          - Is it safe/working: "E work perfectly, boss! Just tell me the country and app you want like 'Ghana WhatsApp' and we go run am."
          - Prices: "Our prices dey very pocket friendly, boss! Just search any service to see live prices."` 
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY.trim()}` },
      timeout: 10000
    });
    
    let content = response.data.choices[0].message.content.trim();
    if (content.startsWith('```json')) content = content.replace(/
