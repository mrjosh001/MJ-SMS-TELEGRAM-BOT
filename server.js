const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const JUICYSMS_API_KEY = process.env.JUICYSMS_API_KEY;
const SMSOTPSTORES_API_KEY = process.env.SMSOTPSTORES_API_KEY;
const AUTHPADI_API_KEY = process.env.AUTHPADI_API_KEY;
const ALLSMSVERIFY_API_KEY = process.env.ALLSMSVERIFY_API_KEY;
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
  const baseCostNgn = isAlreadyNgn ? rawPrice : (rawPrice * USD_TO_NGN_RATE);
  if (baseCostNgn < 3500) {
    return Math.ceil(baseCostNgn + 3000);
  } else {
    return Math.ceil(baseCostNgn * 2);
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

// Universal translation dictionaries for service and country normalization
const SERVICE_ALIASES = {
  'wa': 'whatsapp', 'whats': 'whatsapp', 'whats app': 'whatsapp', 'whatsup': 'whatsapp', 'app': 'whatsapp',
  'tg': 'telegram', 'tele': 'telegram', 'telegram': 'telegram',
  'fb': 'facebook', 'meta': 'facebook', 'face': 'facebook',
  'ig': 'instagram', 'insta': 'instagram', 'gram': 'instagram',
  'tik': 'tiktok', 'tok': 'tiktok', 'tiktok': 'tiktok',
  'x': 'twitter', 'tweet': 'twitter', 'twitter': 'twitter',
  'gmail': 'google', 'g-mail': 'google', 'youtube': 'google',
  'snap': 'snapchat', 'snapchat': 'snapchat',
  'net': 'netflix', 'flix': 'netflix', 'netflix': 'netflix'
};

const COUNTRY_ALIASES = {
  'usa': { id: 'us', name: 'United States (US)' },
  'us': { id: 'us', name: 'United States (US)' },
  'united states': { id: 'us', name: 'United States (US)' },
  'america': { id: 'us', name: 'United States (US)' },
  'uk': { id: 'uk', name: 'United Kingdom (UK)' },
  'united kingdom': { id: 'uk', name: 'United Kingdom (UK)' },
  'england': { id: 'uk', name: 'United Kingdom (UK)' },
  'britain': { id: 'uk', name: 'United Kingdom (UK)' },
  'ng': { id: 'ng', name: 'Nigeria (NG)' },
  'nigeria': { id: 'ng', name: 'Nigeria (NG)' },
  'canada': { id: 'ca', name: 'Canada (CA)' },
  'ca': { id: 'ca', name: 'Canada (CA)' },
  'russia': { id: 'ru', name: 'Russia (RU)' },
  'ru': { id: 'ru', name: 'Russia (RU)' },
  'ghana': { id: 'gh', name: 'Ghana (GH)' },
  'gh': { id: 'gh', name: 'Ghana (GH)' },
  'india': { id: 'in', name: 'India (IN)' },
  'in': { id: 'in', name: 'India (IN)' },
  'germany': { id: 'de', name: 'Germany (DE)' },
  'de': { id: 'de', name: 'Germany (DE)' }
};

function intelligentTranslateService(rawQuery) {
  let cleaned = rawQuery.toLowerCase().trim();
  for (const [alias, canonical] of Object.entries(SERVICE_ALIASES)) {
    if (cleaned === alias || cleaned.includes(alias)) {
      return canonical;
    }
  }
  return cleaned;
}

function intelligentTranslateCountry(rawCountry) {
  let cleaned = rawCountry.toLowerCase().trim();
  if (COUNTRY_ALIASES[cleaned]) {
    return COUNTRY_ALIASES[cleaned];
  }
  // Fallback: create dynamic country object if not in alias map
  return { id: cleaned.substring(0, 2), name: rawCountry.toUpperCase() };
}

// --- API FETCHERS WITH DIAGNOSTIC LOGGING ---

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
        service_name: String(item.title || item.name || item.service_id || ''),
        stock: parseInt(item.count || item.stock || item.quantity || 100, 10),
        price: parseFloat(item.price || item.cost || 0),
        is_ngn: false
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    console.error("JuicySMS Error:", err.message);
    return [];
  }
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
      service_name: String(item.name || item.title || item.service_name || ''),
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) {
    console.error("SMSOTPStores Error:", err.message);
    return [];
  }
}

async function getAuthPadiServices(countryId) {
  try {
    const cleanApiKey = AUTHPADI_API_KEY ? AUTHPADI_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'getServices', country: countryId }
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
      service_name: String(item.name || item.title || item.service_name || ''),
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) {
    console.error("AuthPadi Error:", err.message);
    return [];
  }
}

async function getAllSmsVerifyServices(countryId) {
  try {
    const cleanApiKey = ALLSMSVERIFY_API_KEY ? ALLSMSVERIFY_API_KEY.trim() : '';
    if (!cleanApiKey) return [];
    const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/stubs/handler_api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'getServices', country: countryId }
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
      service_name: String(item.name || item.title || item.service_name || ''),
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) {
    console.error("AllSMSVerify Error:", err.message);
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];
  const countryObj = typeof country === 'string' ? { id: country, name: country } : country;
  if (!countryObj || !countryObj.id) return results;
  const cId = countryObj.id;

  const [juicy, store, auth, allsms] = await Promise.allSettled([
    JUICYSMS_API_KEY ? getJuicySmsServices(cId) : Promise.resolve([]),
    SMSOTPSTORES_API_KEY ? getSmsOtpStoresServices(cId) : Promise.resolve([]),
    AUTHPADI_API_KEY ? getAuthPadiServices(cId) : Promise.resolve([]),
    ALLSMSVERIFY_API_KEY ? getAllSmsVerifyServices(cId) : Promise.resolve([])
  ]);

  if (juicy.status === 'fulfilled') juicy.value.forEach(s => results.push({ provider: 'juicysms', server_label: 'Server One', ...s }));
  if (store.status === 'fulfilled') store.value.forEach(s => results.push({ provider: 'smsotpstores', server_label: 'Server Two', ...s }));
  if (auth.status === 'fulfilled') auth.value.forEach(s => results.push({ provider: 'authpadi', server_label: 'Server Three', ...s }));
  if (allsms.status === 'fulfilled') allsms.value.forEach(s => results.push({ provider: 'allsmsverify', server_label: 'Server Four', ...s }));

  return results;
}

async function executeOrder(provider, serviceId, countryId) {
  try {
    if (provider === 'allsmsverify') {
      const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: ALLSMSVERIFY_API_KEY.trim(), action: 'getNumber', service: serviceId, country: countryId }
      });
      const respStr = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
      if (respStr.startsWith('ACCESS_NUMBER')) {
        const parts = respStr.split(':');
        return { success: true, data: { order_id: parts[1], number: parts[2] } };
      }
      return { success: false, message: respStr };
    } else if (provider === 'authpadi') {
      const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: AUTHPADI_API_KEY.trim(), action: 'getNumber', service: serviceId, country: countryId }
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
    if (provider === 'allsmsverify' || provider === 'authpadi') {
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
    if (provider === 'allsmsverify' || provider === 'authpadi') {
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

bot.command('servers', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (adminId !== ADMIN_TELEGRAM_ID) return ctx.reply(`❌ Unauthorized.`);

  ctx.reply(`Checking all servers (1 to 4) status & balances... ⏳`);
  let statusReport = `🖥️ *BACKEND SERVER STATUS REPORT*\n\n`;

  try {
    const res = await axios.get(`${JUICYSMS_BASE_URL}/balance`, { ...robustAxiosConfig, params: { key: JUICYSMS_API_KEY } });
    statusReport += `• *Server One (JuicySMS):* ✅ ONLINE (Bal: ${res.data?.balance || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server One (JuicySMS):* ❌ OFFLINE (${e.message})\n`; }

  try {
    const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, { ...robustAxiosConfig, params: { api_key: SMSOTPSTORES_API_KEY, action: 'balance' } });
    statusReport += `• *Server Two (SMSOTPStores):* ✅ ONLINE (Bal: ${res.data?.balance || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Two (SMSOTPStores):* ❌ OFFLINE (${e.message})\n`; }

  try {
    const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, { ...robustAxiosConfig, params: { api_key: AUTHPADI_API_KEY, action: 'getBalance' } });
    statusReport += `• *Server Three (AuthPadi):* ✅ ONLINE (${res.data || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Three (AuthPadi):* ❌ OFFLINE (${e.message})\n`; }

  try {
    const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/stubs/handler_api.php`, { ...robustAxiosConfig, params: { api_key: ALLSMSVERIFY_API_KEY, action: 'getBalance' } });
    statusReport += `• *Server Four (AllSMSVerify):* ✅ ONLINE (${res.data || 'Active'})\n`;
  } catch (e) { statusReport += `• *Server Four (AllSMSVerify):* ❌ OFFLINE (${e.message})\n`; }

  ctx.reply(statusReport, { parse_mode: 'Markdown' });
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  session.state = 'AWAITING_INPUT';
  await saveUserSession(userId, session);
  ctx.reply(`Oya boss! Welcome to *MJ SMS*! Type any country and service name naturally in one go (e.g., *Ghana WhatsApp*, *USA Telegram*, *Germany Facebook*). ✨`, { parse_mode: 'Markdown' });
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

// FULLY UNIFIED TEXT HANDLER: Automatically translates ANY country and service input instantly
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();
  const session = await getUserSession(userId);

  if (['/start', 'change country', 'back'].some(k => lowerText === k)) {
    session.state = 'AWAITING_INPUT';
    await saveUserSession(userId, session);
    return ctx.reply(`No p boss! Type any country and service name naturally (e.g., *USA WhatsApp*).`);
  }

  if (session.state === 'AWAITING_DEPOSIT_AMOUNT') {
    const amount = parseInt(rawText.replace(/[^0-9]/g, ''));
    if (isNaN(amount) || amount < 100) return ctx.reply(`Please enter a valid amount.`);
    const payment = await initializePaystackPayment(`${userId}@mjsms.com`, amount, userId);
    if (payment.status && payment.data?.authorization_url) {
      session.state = 'IDLE';
      await saveUserSession(userId, session);
      return ctx.reply(`💳 Tap below to pay:`, Markup.inlineKeyboard([[Markup.button.url('Pay Now', payment.data.authorization_url)]]));
    }
    return ctx.reply(`❌ Payment link error.`);
  }

  // Smart parsing: Split input words to detect country first, then service
  const words = lowerText.split(/\s+/);
  let matchedCountry = null;
  let serviceQueryWords = [];

  for (let i = 0; i < words.length; i++) {
    const subQuery = words.slice(0, i + 1).join(' ');
    if (COUNTRY_ALIASES[subQuery]) {
      matchedCountry = COUNTRY_ALIASES[subQuery];
      serviceQueryWords = words.slice(i + 1);
      break;
    }
  }

  if (!matchedCountry) {
    for (let i = 0; i < words.length; i++) {
      const potentialCountry = words.slice(i).join(' ');
      if (COUNTRY_ALIASES[potentialCountry]) {
        let leftover = words.slice(0, i);
        if (leftover.length > 0) {
          matchedCountry = COUNTRY_ALIASES[potentialCountry];
          serviceQueryWords = leftover;
          break;
        }
      }
    }
  }

  // If user typed both country and service in one go
  if (matchedCountry && serviceQueryWords.length > 0) {
    let rawService = serviceQueryWords.join(' ');
    session.country = matchedCountry;
    session.selectedServiceQuery = intelligentTranslateService(rawService);
    await saveUserSession(userId, session);
    return await promptServerSelection(ctx, session);
  }

  // If user typed ONLY a country name
  if (COUNTRY_ALIASES[lowerText]) {
    session.country = COUNTRY_ALIASES[lowerText];
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    return ctx.reply(`Ehen! You select *${session.country.name}*. Which app or service you wan verify?`, { parse_mode: 'Markdown' });
  }

  // If bot was waiting for service after user previously picked a country
  if (session.state === 'AWAITING_SERVICE' && session.country) {
    session.selectedServiceQuery = intelligentTranslateService(rawText);
    await saveUserSession(userId, session);
    return await promptServerSelection(ctx, session);
  }

  // Default intelligent fallback: treat first word as country, remainder as service
  if (words.length >= 2) {
    const possibleCountry = intelligentTranslateCountry(words[0]);
    const possibleService = intelligentTranslateService(words.slice(1).join(' '));
    session.country = possibleCountry;
    session.selectedServiceQuery = possibleService;
    await saveUserSession(userId, session);
    return await promptServerSelection(ctx, session);
  }

  ctx.reply(`Oya boss, specify both country and app name naturally (e.g., *USA WhatsApp* or *Ghana Telegram*). ✨`, { parse_mode: 'Markdown' });
});

async function promptServerSelection(ctx, session) {
  ctx.reply(`Translating and fetching live stock across all servers... ⏳`);
  const availableServers = await fetchCombinedServices(session.country);
  const q = (session.selectedServiceQuery || '').toLowerCase().trim();

  // Smart fuzzy matching against all backend service names and IDs
  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return sName.includes(q) || q.includes(sName) || sId.includes(q) || sName.replace(/[^a-z0-9]/g, '').includes(q.replace(/[^a-z0-9]/g, ''));
  });

  const userId = ctx.from.id;
  if (filtered.length === 0) {
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    return ctx.reply(`💔 No stock found for *${session.selectedServiceQuery}* in *${session.country.name}*. Try another app name!`, { parse_mode: 'Markdown' });
  }

  const uniqueServersMap = new Map();
  filtered.forEach(srv => {
    if (!uniqueServersMap.has(srv.server_label)) uniqueServersMap.set(srv.server_label, srv);
  });

  const serverButtons = [];
  uniqueServersMap.forEach((srv, label) => {
    serverButtons.push([Markup.button.callback(`🖥️ ${label} (${srv.provider})`, `server|${srv.provider}|${srv.server_label}`)]);
  });
  serverButtons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(`Select your preferred server for *${session.selectedServiceQuery}* (${session.country.name}): 👇`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(serverButtons) });
}

bot.action(/^server\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const provider = ctx.match[1];
  const availableServers = await fetchCombinedServices(session.country);
  const q = (session.selectedServiceQuery || '').toLowerCase().trim();

  const filtered = availableServers.filter(s => String(s.provider) === String(provider) && (String(s.service_name).toLowerCase().includes(q) || q.includes(String(s.service_name).toLowerCase()) || s.service_id));

  const buttons = filtered.map(srv => {
    const finalPrice = calculateFinalPrice(srv.price, srv.is_ngn);
    return [Markup.button.callback(`💰 ${srv.server_label} (${srv.service_name}) - ₦${finalPrice.toLocaleString()} (${srv.stock} left)`, `buy|${srv.provider}|${session.country.id}|${srv.service_id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Back', 'back_to_servers')]);

  ctx.reply(`Choose pricing option:`, Markup.inlineKeyboard(buttons));
});

bot.action('back_to_servers', async (ctx) => {
  ctx.answerCbQuery();
  const session = await getUserSession(ctx.from.id);
  if (session.country) await promptServerSelection(ctx, session);
});

bot.action('reset_flow', async (ctx) => {
  ctx.answerCbQuery();
  const session = await getUserSession(ctx.from.id);
  session.state = 'AWAITING_INPUT';
  session.country = null;
  session.selectedServiceQuery = null;
  await saveUserSession(ctx.from.id, session);
  ctx.reply(`🔄 Flow reset! Type any country and app name naturally (e.g., *Nigeria WhatsApp*).`);
});

bot.action(/^buy\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const [_, provider, countryId, serviceId] = ctx.match;

  const availableServers = await fetchCombinedServices({ id: countryId });
  const target = availableServers.find(s => s.provider === provider && String(s.service_id) === String(serviceId));
  const price = target ? calculateFinalPrice(target.price, target.is_ngn) : 0;

  if (price > 0 && session.balance < price) {
    return ctx.reply(`❌ Insufficient balance! Type */fund* to top up.`, { parse_mode: 'Markdown' });
  }

  ctx.reply(`Processing order... ⏳`);
  const response = await executeOrder(provider, serviceId, countryId);

  if (response.success && response.data) {
    if (price > 0) {
      session.balance = Math.max(0, session.balance - price);
      await saveUserSession(userId, session);
    }
    const orderId = response.data.order_id;
    const phoneNumber = response.data.number;

    await addOrderToDb(userId, { orderId, provider, serviceName: target?.service_name || serviceId, phoneNumber, price, status: 'Pending', date: new Date().toLocaleString() });

    ctx.reply(`🎉 *NUMBER BOUGHT!*\n📞 \`${phoneNumber}\`\n🆔 \`${orderId}\`\nWaiting for SMS code...`, { parse_mode: 'Markdown' });

    let polls = 0;
    const pollInterval = setInterval(async () => {
      polls++;
      const check = await checkSmsCode(provider, orderId);
      if (check.success && check.data?.code) {
        clearInterval(pollInterval);
        await updateOrderStatusInDb(orderId, `Completed (${check.data.code})`);
        ctx.reply(`🔥🔥 *CODE RECEIVED:* \`${check.data.code}\` 🔥🔥`, { parse_mode: 'Markdown' });
      } else if (polls >= 80) {
        clearInterval(pollInterval);
        await cancelOrder(provider, orderId);
        if (price > 0) {
          const fresh = await getUserSession(userId);
          fresh.balance += price;
          await saveUserSession(userId, fresh);
        }
        ctx.reply(`⏰ Timeout! Order canceled and ₦${price} refunded.`);
      }
    }, 7000);
  } else {
    ctx.reply(`❌ Order failed: ${response.message}`);
  }
});

app.get('/', (req, res) => res.send('MJ SMS Bot Active!'));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

bot.launch().then(() => {
  console.log("Bot is live and polling for messages...");
}).catch((err) => {
  console.error("Failed to launch bot:", err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
