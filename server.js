const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const JUICYSMS_API_KEY = process.env.JUICYSMS_API_KEY;
const SMSOTPSTORES_API_KEY = process.env.SMSOTPSTORES_API_KEY;
const AUTHPADI_API_KEY = process.env.AUTHPADI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const SUPABASE_REST_URL = process.env.SUPABASE_REST_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const robustAxiosConfig = {
  timeout: 15000,
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
        state: row.state || 'AWAITING_COUNTRY',
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
    state: 'AWAITING_COUNTRY',
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
  } catch (err) {
    console.error("Error saving user session via REST:", err.message);
  }
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

async function addTransactionToDb(userId, amount, date) {
  const session = await getUserSession(userId);
  session.transactions.push({ amount, date });
  await saveUserSession(userId, session);
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
  if (!PAYSTACK_SECRET_KEY) {
    return { status: false, message: "Paystack secret key is missing." };
  }
  try {
    const res = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: Math.round(amountNgn * 100),
        metadata: { telegram_id: String(userId) }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY.trim()}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return res.data;
  } catch (err) {
    return { status: false, message: "Could not create payment link." };
  }
}

const JUICYSMS_COUNTRIES = [
  { id: 'NL', name: 'Netherlands (NL)', short: 'nl' },
  { id: 'UK', name: 'United Kingdom (UK)', short: 'uk' },
  { id: 'USA', name: 'United States (USA)', short: 'usa' },
  { id: 'DE', name: 'Germany (DE)', short: 'de' },
  { id: 'CA', name: 'Canada (CA)', short: 'ca' }
];

const SMSOTPSTORES_COUNTRIES = [
  { id: 'us', name: 'United States (US)', short: 'us' },
  { id: 'ng', name: 'Nigeria (NG)', short: 'ng' },
  { id: 'uk', name: 'United Kingdom (UK)', short: 'uk' },
  { id: 'ca', name: 'Canada (CA)', short: 'ca' }
];

const AUTHPADI_COUNTRIES = [
  { id: 'us', name: 'United States (US)', short: 'us' },
  { id: 'ng', name: 'Nigeria (NG)', short: 'ng' },
  { id: 'uk', name: 'United Kingdom (UK)', short: 'uk' },
  { id: 'ca', name: 'Canada (CA)', short: 'ca' }
];

const JUICYSMS_BASE_URL = 'https://juicysms.com/api';
const SMSOTPSTORES_BASE_URL = 'https://smsotpstores.com';
const AUTHPADI_BASE_URL = 'https://dashboard.authpadi.com';

// Smart natural language translation dictionary for common services
const COMMON_SERVICE_SYNONYMS = {
  'whatsapp': ['whatsapp', 'wa', 'whats app'],
  'telegram': ['telegram', 'tg', 'tele'],
  'facebook': ['facebook', 'fb', 'meta'],
  'google': ['google', 'gmail', 'youtube', 'g-mail'],
  'tiktok': ['tiktok', 'tik tok'],
  'instagram': ['instagram', 'ig', 'insta'],
  'twitter': ['twitter', 'x', 'tweet'],
  'netflix': ['netflix'],
  'snapchat': ['snapchat', 'snap']
};

async function getJuicySmsServices(countryId) {
  try {
    const params = { country: countryId || 'NL' };
    if (JUICYSMS_API_KEY) params.key = JUICYSMS_API_KEY.trim();

    const res = await axios.get(`${JUICYSMS_BASE_URL}/services`, { ...robustAxiosConfig, params });
    let data = res.data;
    if (data && data.services) data = data.services;

    if (Array.isArray(data)) {
      return data.map(item => ({
        service_id: item.id || item.serviceId || item.code || '',
        service_name: item.title || item.name || item.service_id || '',
        stock: parseInt(item.count || item.stock || item.quantity || 10, 10),
        price: parseFloat(item.price || item.cost || 0),
        is_ngn: false
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function getSmsOtpStoresServices(countryId) {
  try {
    const cleanApiKey = SMSOTPSTORES_API_KEY ? SMSOTPSTORES_API_KEY.trim() : '';
    if (!cleanApiKey) return [];

    const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey, action: 'services', country: countryId }
    });

    const data = res.data;
    let list = [];
    if (data && Array.isArray(data.services)) {
      list = data.services;
    } else if (Array.isArray(data)) {
      list = data;
    }

    return list.map(item => ({
      service_id: item.id || item.service_id || item.code || '',
      service_name: item.name || item.title || item.service_name || '',
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) {
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
    if (data && Array.isArray(data.services)) {
      list = data.services;
    } else if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === 'object') {
      list = Object.keys(data).map(k => {
        const item = data[k];
        return {
          id: item.id || item.service_id || k,
          name: item.name || item.service_name || item.title || k,
          stock: item.count || item.stock || item.quantity || item.total || 100,
          price: item.price || item.cost || item.rate || 0
        };
      });
    }

    return list.map(item => ({
      service_id: String(item.id || item.service_id || item.code || ''),
      service_name: String(item.name || item.title || item.service_name || ''),
      stock: parseInt(item.stock || item.count || 100, 10),
      price: parseFloat(item.price || 0),
      is_ngn: true
    })).filter(s => s.service_id);
  } catch (err) {
    console.error("AuthPadi Services Error:", err.message);
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];
  const countryObj = typeof country === 'string' ? { id: country, name: country } : country;
  if (!countryObj || !countryObj.id) return results;

  // Server One: JuicySMS
  const juicyMatch = JUICYSMS_COUNTRIES.find(c => c.id.toLowerCase() === countryObj.id.toLowerCase());
  if (juicyMatch && JUICYSMS_API_KEY) {
    const juicyData = await getJuicySmsServices(juicyMatch.id);
    if (Array.isArray(juicyData)) {
      juicyData.forEach(s => {
        results.push({
          provider: 'juicysms',
          service_id: s.service_id,
          service_name: s.service_name,
          server_label: 'Server One',
          stock: s.stock || 10,
          price: s.price,
          is_ngn: false
        });
      });
    }
  }

  // Server Two: smsotpstores
  const storeMatch = SMSOTPSTORES_COUNTRIES.find(c => c.id.toLowerCase() === countryObj.id.toLowerCase());
  if (storeMatch && SMSOTPSTORES_API_KEY) {
    const storeData = await getSmsOtpStoresServices(storeMatch.id);
    if (Array.isArray(storeData)) {
      storeData.forEach(s => {
        results.push({
          provider: 'smsotpstores',
          service_id: s.service_id,
          service_name: s.service_name,
          server_label: 'Server Two',
          stock: s.stock || 100,
          price: s.price,
          is_ngn: true
        });
      });
    }
  }

  // Server Three: AuthPadi
  const authMatch = AUTHPADI_COUNTRIES.find(c => c.id.toLowerCase() === countryObj.id.toLowerCase());
  if (authMatch && AUTHPADI_API_KEY) {
    const authData = await getAuthPadiServices(authMatch.id);
    if (Array.isArray(authData)) {
      authData.forEach(s => {
        results.push({
          provider: 'authpadi',
          service_id: s.service_id,
          service_name: s.service_name,
          server_label: 'Server Three',
          stock: s.stock || 100,
          price: s.price,
          is_ngn: true
        });
      });
    }
  }

  return results;
}

async function executeOrder(provider, serviceId, countryId) {
  if (provider === 'authpadi') {
    try {
      const cleanApiKey = AUTHPADI_API_KEY ? AUTHPADI_API_KEY.trim() : '';
      const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'getNumber', service: serviceId, country: countryId }
      });
      const data = res.data;
      
      let respStr = typeof data === 'string' ? data.trim() : JSON.stringify(data);
      if (respStr.startsWith('ACCESS_NUMBER')) {
        const parts = respStr.split(':');
        if (parts.length >= 3) {
          return { success: true, data: { order_id: parts[1], number: parts[2] } };
        }
      }

      if (data && (data.success || data.status === 'success' || data.order_id || data.id)) {
        return { 
          success: true, 
          data: { 
            order_id: String(data.order_id || data.id || data.activation_id), 
            number: String(data.phone_number || data.number || data.phone) 
          } 
        };
      }
      return { success: false, message: data?.message || respStr || 'Stock unavailable or insufficient balance on AuthPadi.' };
    } catch (err) {
      return { success: false, message: 'AuthPadi request failed.' };
    }
  } else if (provider === 'smsotpstores') {
    try {
      const cleanApiKey = SMSOTPSTORES_API_KEY ? SMSOTPSTORES_API_KEY.trim() : '';
      const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'order', service_id: serviceId, country: countryId }
      });
      const data = res.data;
      if (data && (data.success || data.status === 'success' || data.order_id)) {
        return { 
          success: true, 
          data: { 
            order_id: String(data.order_id || data.id), 
            number: String(data.phone_number || data.number) 
          } 
        };
      }
      return { success: false, message: data?.message || 'Stock unavailable or insufficient balance on smsotpstores.' };
    } catch (err) {
      return { success: false, message: 'smsotpstores request failed.' };
    }
  } else {
    try {
      const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
      const res = await axios.get(`${JUICYSMS_BASE_URL}/makeorder`, {
        ...robustAxiosConfig,
        params: { key: cleanApiKey, serviceId: serviceId, country: countryId }
      });
      const respText = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
      if (respText.startsWith('ORDER_ID_')) {
        const parts = respText.split('_');
        return { success: true, data: { order_id: parts[2], number: parts.slice(4).join('_') } };
      }
      return { success: false, message: respText || 'Stock unavailable or insufficient balance on JuicySMS.' };
    } catch (err) {
      return { success: false, message: 'JuicySMS request failed.' };
    }
  }
}

async function checkSmsCode(provider, orderId) {
  if (provider === 'authpadi') {
    try {
      const cleanApiKey = AUTHPADI_API_KEY ? AUTHPADI_API_KEY.trim() : '';
      const res = await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'getStatus', id: orderId }
      });
      const data = res.data;
      let respStr = typeof data === 'string' ? data.trim() : JSON.stringify(data);
      
      if (respStr.startsWith('STATUS_OK')) {
        const parts = respStr.split(':');
        if (parts.length >= 2) {
          return { success: true, data: { code: parts[1] } };
        }
      }

      if (data && (data.code || data.sms_code || data.status === 'completed' || data.otp)) {
        const code = data.code || data.sms_code || data.otp;
        if (code) return { success: true, data: { code: String(code) } };
      }
      return { success: false };
    } catch (err) {
      return { success: false };
    }
  } else if (provider === 'smsotpstores') {
    try {
      const cleanApiKey = SMSOTPSTORES_API_KEY ? SMSOTPSTORES_API_KEY.trim() : '';
      const res = await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'status', order_id: orderId }
      });
      const data = res.data;
      if (data && (data.code || data.sms_code || data.status === 'completed')) {
        const code = data.code || data.sms_code || data.otp;
        if (code) return { success: true, data: { code: String(code) } };
      }
      return { success: false };
    } catch (err) {
      return { success: false };
    }
  } else {
    try {
      const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
      const res = await axios.get(`${JUICYSMS_BASE_URL}/getsms`, {
        ...robustAxiosConfig,
        params: { key: cleanApiKey, orderId: orderId }
      });
      const respText = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
      if (respText.startsWith('SUCCESS_')) {
        return { success: true, data: { code: respText.replace('SUCCESS_', '') } };
      }
      return { success: false };
    } catch (err) {
      return { success: false };
    }
  }
}

async function cancelOrder(provider, orderId) {
  if (provider === 'authpadi') {
    try {
      const cleanApiKey = AUTHPADI_API_KEY ? AUTHPADI_API_KEY.trim() : '';
      await axios.get(`${AUTHPADI_BASE_URL}/stubs/handler_api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'setStatus', id: orderId, status: 8 }
      });
    } catch (err) {}
  } else if (provider === 'smsotpstores') {
    try {
      const cleanApiKey = SMSOTPSTORES_API_KEY ? SMSOTPSTORES_API_KEY.trim() : '';
      await axios.get(`${SMSOTPSTORES_BASE_URL}/api.php`, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, action: 'cancel', order_id: orderId }
      });
    } catch (err) {}
  } else {
    try {
      const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
      await axios.get(`${JUICYSMS_BASE_URL}/cancelorder`, {
        ...robustAxiosConfig,
        params: { key: cleanApiKey, orderId: orderId }
      });
    } catch (err) {}
  }
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  session.country = null;
  session.selectedServiceQuery = null;
  session.chosenProvider = null;
  await saveUserSession(userId, session);

  ctx.reply(
    `How far boss! 👋 Welcome to *MJ SMS*! ✨\n\n` +
    `💰 *Your Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
    `Just type what you need naturally! For example: *'US WhatsApp'* or *'Canadian Facebook'*. 🚀\n` +
    `• Type */orders* to view your order history!\n` +
    `• Type */fund* to top up your wallet balance!\n` +
    `• Type *support* anytime for customer care.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['balance', 'bal'], async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  ctx.reply(`Boss your current balance na ₦${(session.balance || 0).toLocaleString()} ✨`, { parse_mode: 'Markdown' });
});

bot.command(['fund', 'deposit', 'wallet', 'topup'], async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  session.state = 'AWAITING_DEPOSIT_AMOUNT';
  await saveUserSession(userId, session);

  ctx.reply(
    `💳 *MJ SMS WALLET TOP-UP*\n\n` +
    `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
    `Enter the amount you want to deposit in Naira (e.g., *1000*, *2000*, *5000*):`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['orders', 'history_orders'], async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  if (!session.orders || session.orders.length === 0) {
    ctx.reply(`📭 You don't have any order history yet.`, { parse_mode: 'Markdown' });
    return;
  }

  const recentOrders = session.orders.slice(-10).reverse().map(o => 
    `• *Service:* ${o.serviceName}\n` +
    `  📞 \`${o.phoneNumber}\`\n` +
    `  🆔 *Tracking ID:* \`${o.orderId}\`\n` +
    `  💰 *Cost:* ₦${o.price.toLocaleString()}\n` +
    `  📊 *Status:* ${o.status}\n` +
    `  🕒 *Date:* ${o.date}`
  ).join('\n\n');

  ctx.reply(`📦 *YOUR RECENT ORDER HISTORY*\n\n${recentOrders}`, { parse_mode: 'Markdown' });
});

bot.command(['support', 'help', 'customercare'], (ctx) => sendCustomerSupportMessage(ctx));

function sendCustomerSupportMessage(ctx) {
  ctx.reply(
    `💬 *MJ SMS CUSTOMER CARE*\n\n` +
    `Need help with an order, wallet funding, or balance issues? Provide your *Tracking ID* to support.\n` +
    `Tap the button below to message customer support on WhatsApp: 👇`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💬 Chat Customer Care on WhatsApp', 'https://wa.me/qr/XM6ORO7UCYTXI1')]
      ])
    }
  );
}

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();
  const session = await getUserSession(userId);

  if (['support', 'customer care', 'speak to support', 'admin', 'contact'].some(k => lowerText.includes(k))) {
    sendCustomerSupportMessage(ctx);
    return;
  }

  if (lowerText.includes('balance') || lowerText.includes('bal') || lowerText === 'my balance') {
    ctx.reply(`Boss your current balance na ₦${(session.balance || 0).toLocaleString()} ✨`, { parse_mode: 'Markdown' });
    return;
  }

  if (['fund', 'deposit', 'wallet', 'topup', 'top up'].some(k => lowerText.includes(k))) {
    session.state = 'AWAITING_DEPOSIT_AMOUNT';
    await saveUserSession(userId, session);
    ctx.reply(
      `💳 *MJ SMS WALLET TOP-UP*\n\n` +
      `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
      `Enter the amount you want to deposit in Naira (e.g., *1000*, *2000*):`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (['/start', 'change country', 'countries', 'back', 'start'].some(k => lowerText === k)) {
    session.state = 'AWAITING_COUNTRY';
    session.country = null;
    session.selectedServiceQuery = null;
    session.chosenProvider = null;
    await saveUserSession(userId, session);
    ctx.reply(`No p boss! Just type what you need naturally (e.g., *US WhatsApp* or *Canada Facebook*).`, { parse_mode: 'Markdown' });
    return;
  }

  if (session.state === 'AWAITING_DEPOSIT_AMOUNT') {
    const amount = parseInt(rawText.replace(/[^0-9]/g, ''));
    if (isNaN(amount) || amount < 100) {
      ctx.reply(`Please enter a valid amount (minimum ₦100).`);
      return;
    }
    ctx.reply(`Generating payment link... ⏳`);
    const payment = await initializePaystackPayment(`${userId}@mjsms.com`, amount, userId);
    if (payment.status && payment.data?.authorization_url) {
      session.state = 'IDLE';
      await saveUserSession(userId, session);
      ctx.reply(
        `💳 *PAYSTACK PAYMENT LINK READY*\n\n` +
        `Amount: *₦${amount.toLocaleString()}*\n\n` +
        `Tap below to complete payment: 👇`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('💳 Pay Now via Paystack', payment.data.authorization_url)]])
        }
      );
    } else {
      ctx.reply(`❌ Could not generate payment link.`);
    }
    return;
  }

  const allSupportedCountries = [...JUICYSMS_COUNTRIES, ...SMSOTPSTORES_COUNTRIES, ...AUTHPADI_COUNTRIES];

  const getNormalizedCountry = (input) => {
    const cleanInput = input.toLowerCase().trim();
    return allSupportedCountries.find(c => {
      const cName = String(c.name).toLowerCase();
      const cId = String(c.id).toLowerCase();
      const cShort = String(c.short || '').toLowerCase();

      return cName === cleanInput || 
             cName.includes(cleanInput) || 
             cleanInput.includes(cName) || 
             cId === cleanInput || 
             cShort === cleanInput ||
             (cleanInput.includes('usa') && cId === 'us') ||
             (cleanInput.includes('uk') && cId === 'uk') ||
             (cleanInput.includes('nl') && cId === 'nl') ||
             (cleanInput.includes('de') && cId === 'de') ||
             (cleanInput.includes('ca') && cId === 'ca') ||
             (cleanInput.includes('ng') && cId === 'ng');
    });
  };

  // Smart Natural Language Translation Parser
  const words = lowerText.split(/\s+/);
  let matchedCountry = null;
  let serviceQueryWords = [];

  for (let i = 0; i < words.length; i++) {
    const subQuery = words.slice(0, i + 1).join(' ');
    const found = getNormalizedCountry(subQuery);
    if (found) {
      matchedCountry = found;
      serviceQueryWords = words.slice(i + 1);
      break;
    }
  }

  // If user typed country first followed by service (e.g., "US WhatsApp" or "Canadian Facebook")
  if (matchedCountry && serviceQueryWords.length > 0) {
    let rawServiceQuery = serviceQueryWords.join(' ');
    
    // Translate synonyms if any match
    for (const [canonical, synonyms] of Object.entries(COMMON_SERVICE_SYNONYMS)) {
      if (synonyms.some(syn => rawServiceQuery.includes(syn))) {
        rawServiceQuery = canonical;
        break;
      }
    }

    session.country = matchedCountry;
    session.selectedServiceQuery = rawServiceQuery;
    session.state = 'AWAITING_SERVER_SELECTION';
    await saveUserSession(userId, session);
    await promptServerSelection(ctx, session);
    return;
  }

  // If user typed service first followed by country (e.g., "WhatsApp USA" or "Facebook Canada")
  for (let i = 0; i < words.length; i++) {
    const potentialCountryQuery = words.slice(i).join(' ');
    const foundCountry = getNormalizedCountry(potentialCountryQuery);
    if (foundCountry) {
      let rawServiceQuery = words.slice(0, i).join(' ');
      for (const [canonical, synonyms] of Object.entries(COMMON_SERVICE_SYNONYMS)) {
        if (synonyms.some(syn => rawServiceQuery.includes(syn))) {
          rawServiceQuery = canonical;
          break;
        }
      }
      if (rawServiceQuery) {
        session.country = foundCountry;
        session.selectedServiceQuery = rawServiceQuery;
        session.state = 'AWAITING_SERVER_SELECTION';
        await saveUserSession(userId, session);
        await promptServerSelection(ctx, session);
        return;
      }
    }
  }

  const matchedCountryDirect = getNormalizedCountry(lowerText);
  if (matchedCountryDirect) {
    session.country = matchedCountryDirect;
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    ctx.reply(
      `Ehen! You select *${matchedCountryDirect.name}* 👌\n\n` +
      `Which app or service you wan verify? (e.g., _WhatsApp_, _Telegram_, _Facebook_)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (session.state === 'AWAITING_SERVICE' && session.country) {
    let rawServiceQuery = rawText;
    for (const [canonical, synonyms] of Object.entries(COMMON_SERVICE_SYNONYMS)) {
      if (synonyms.some(syn => rawServiceQuery.toLowerCase().includes(syn))) {
        rawServiceQuery = canonical;
        break;
      }
    }
    session.selectedServiceQuery = rawServiceQuery;
    session.state = 'AWAITING_SERVER_SELECTION';
    await saveUserSession(userId, session);
    await promptServerSelection(ctx, session);
    return;
  }

  ctx.reply(`Oya boss, just tell me what you need naturally like *'US WhatsApp'* or *'Canada Telegram'*! ✨`, { parse_mode: 'Markdown' });
});

async function promptServerSelection(ctx, session) {
  ctx.reply(`Checking available servers and translating service codes... ⏳`);
  const availableServers = await fetchCombinedServices(session.country);
  const q = (session.selectedServiceQuery || '').toLowerCase().trim();
  
  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return sName.includes(q) || q.includes(sName) || sId.includes(q);
  });

  const userId = ctx.from.id;
  if (filtered.length === 0) {
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    const topServices = availableServers.slice(0, 15).map(s => `• ${s.service_name}`).join('\n');
    ctx.reply(
      `Eya! No stock found for *${session.selectedServiceQuery}* right now. 💔\n\n` +
      `Available services on this country:\n${topServices || 'None available'}\n\n` +
      `Type another app name or type *change country* to switch.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const uniqueServersMap = new Map();
  filtered.forEach(srv => {
    if (!uniqueServersMap.has(srv.server_label)) {
      uniqueServersMap.set(srv.server_label, srv);
    }
  });

  const countryName = typeof session.country === 'object' ? session.country.name : session.country;

  const serverButtons = [];
  uniqueServersMap.forEach((srv, label) => {
    serverButtons.push([Markup.button.callback(`🖥️ ${label}`, `server|${srv.provider}|${srv.server_label}`)]);
  });
  serverButtons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Oya boss! You selected *${session.selectedServiceQuery}* for *${countryName}*.\n\n` +
    `Please select your preferred server below: 👇`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(serverButtons) }
  );
}

bot.action(/^server\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const provider = ctx.match[1];

  session.chosenProvider = provider;
  await saveUserSession(userId, session);

  const availableServers = await fetchCombinedServices(session.country);
  const q = (session.selectedServiceQuery || '').toLowerCase().trim();

  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return String(s.provider) === String(provider) && (sName.includes(q) || q.includes(sName) || sId.includes(q));
  });

  if (filtered.length === 0) {
    ctx.reply(`❌ No services found on this server. Please try again.`);
    return;
  }

  const countryIdCode = typeof session.country === 'object' ? session.country.id : session.country;

  const buttons = filtered.map((srv) => {
    const finalPrice = calculateFinalPrice(srv.price, srv.is_ngn);
    const cbData = `buy|${srv.provider}|${countryIdCode}|${srv.service_id}`;
    return [Markup.button.callback(`💰 ${srv.server_label} (${srv.service_name}) - ₦${finalPrice.toLocaleString()} (${srv.stock} left)`, cbData)];
  });

  buttons.push([Markup.button.callback('⬅️ Back to Servers', 'back_to_servers')]);

  session.state = 'AWAITING_PRICE_SELECTION';
  await saveUserSession(userId, session);

  ctx.reply(
    `Ehen boss! See pricing for *${session.selectedServiceQuery}* on your chosen server:\n\nTap option below to buy:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action('back_to_servers', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  if (session.country && session.selectedServiceQuery) {
    await promptServerSelection(ctx, session);
  } else {
    ctx.reply(`Please start over by typing your country code.`);
  }
});

bot.action(/^buy\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const provider = ctx.match[1];
  const countryId = ctx.match[2];
  const serviceId = ctx.match[3];

  const availableServers = await fetchCombinedServices({ id: countryId, name: countryId });
  const targetService = availableServers.find(s => String(s.provider) === String(provider) && String(s.service_id) === String(serviceId));
  
  const calculatedNgnPrice = targetService ? calculateFinalPrice(targetService.price, targetService.is_ngn) : 0;

  if (calculatedNgnPrice > 0 && session.balance < calculatedNgnPrice) {
    ctx.reply(
      `❌ *Insufficient Balance!*\n\n` +
      `This number costs *₦${calculatedNgnPrice.toLocaleString()}*, but your balance is *₦${(session.balance || 0).toLocaleString()}*.\n\n` +
      `Type */fund* to top up your wallet and try again! 💳`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const response = await executeOrder(provider, serviceId, countryId);

  if (response.success && response.data) {
    if (calculatedNgnPrice > 0) {
      session.balance = Math.max(0, session.balance - calculatedNgnPrice);
      await saveUserSession(userId, session);
    }

    const orderId = response.data.order_id;
    const phoneNumber = response.data.number;
    const serviceName = targetService ? targetService.service_name : serviceId;

    const orderRecord = {
      orderId: orderId,
      provider: provider,
      serviceName: serviceName,
      phoneNumber: phoneNumber,
      price: calculatedNgnPrice,
      status: 'Pending Code',
      date: new Date().toLocaleString()
    };
    
    await addOrderToDb(userId, orderRecord);

    ctx.reply(
      `🎉 *NUMBER PURCHASED SUCCESSFULLY!*\n\n` +
      `📞 *Phone Number:* \`${phoneNumber}\`\n` +
      `🆔 *Tracking ID:* \`${orderId}\` _(Save this in case of complaints!)_\n` +
      `💰 *Charged:* ₦${calculatedNgnPrice.toLocaleString()}\n` +
      `💳 *New Balance:* ₦${session.balance.toLocaleString()}\n\n` +
      `👉 Copy the number above into your app.\n` +
      `⏳ Waiting for your SMS code...`,
      { parse_mode: 'Markdown' }
    );

    let pollCount = 0;
    const maxPolls = 80;

    const intervalId = setInterval(async () => {
      pollCount++;
      const checkRes = await checkSmsCode(provider, orderId);

      if (checkRes.success && checkRes.data && checkRes.data.code) {
        clearInterval(intervalId);
        await updateOrderStatusInDb(orderId, `Completed (Code: ${checkRes.data.code})`);

        ctx.reply(
          `🔥🔥 *SMS CODE RECEIVED!* 🔥🔥\n\n` +
          `📞 *Number:* \`${phoneNumber}\`\n` +
          `🆔 *Tracking ID:* \`${orderId}\`\n` +
          `🔑 *Verification Code:* \`${checkRes.data.code}\`\n\n` +
          `Thank you for using *MJ SMS*! ✨`,
          { parse_mode: 'Markdown' }
        );
      } else if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        await cancelOrder(provider, orderId);
        if (calculatedNgnPrice > 0) {
          const freshSession = await getUserSession(userId);
          freshSession.balance += calculatedNgnPrice;
          await saveUserSession(userId, freshSession);
          await updateOrderStatusInDb(orderId, 'Canceled & Refunded (Timeout)');
        }
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order canceled and ₦${calculatedNgnPrice.toLocaleString()} returned to your balance!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Server out of stock or insufficient account balance.'}`);
  }
});

bot.action('reset_flow', async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  session.country = null;
  session.selectedServiceQuery = null;
  session.chosenProvider = null;
  await saveUserSession(userId, session);
  ctx.reply(`No p boss! Which country you wan check now? (Type *US*, *NG*, *NL*, *UK*, *CA* or *DE*)`);
});

const TELEGRAM_WEBHOOK_PATH = `/webhook/telegram`;
app.use(bot.webhookCallback(TELEGRAM_WEBHOOK_PATH));

app.post('/webhook/paystack', async (req, res) => {
  const event = req.body;
  if (event && event.event === 'charge.success') {
    const data = event.data;
    const userId = data.metadata?.telegram_id;
    const amountPaidNgn = data.amount / 100;

    if (userId) {
      const session = await getUserSession(userId);
      session.balance = (session.balance || 0) + amountPaidNgn;
      await saveUserSession(userId, session);
      
      const dateStr = new Date().toLocaleString();
      await addTransactionToDb(userId, amountPaidNgn, dateStr);

      try {
        await bot.telegram.sendMessage(
          userId,
          `🎉 *PAYMENT SUCCESSFUL!*\n\n` +
          `💳 *Amount Credited:* ₦${amountPaidNgn.toLocaleString()}\n` +
          `💰 *New Balance:* ₦${session.balance.toLocaleString()}\n\n` +
          `You can now order numbers!`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {}
    }
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('MJ SMS Bot Active!'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (SERVER_URL) {
    try {
      await bot.telegram.setWebhook(`${SERVER_URL}${TELEGRAM_WEBHOOK_PATH}`);
    } catch (err) {}
  }
});
