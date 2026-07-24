const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(express.json());

// ------------------- ENVIRONMENT VARIABLES -------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const JUICYSMS_API_KEY = process.env.JUICYSMS_API_KEY || process.env.SECOND_SMS_API_KEY;
const PLUSVERIFY_API_KEY = process.env.PLUSVERIFY_API_KEY || process.env.PLUS_VERIFY_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL; // e.g. postgresql://postgres:pass@db.xyz.supabase.co:5432/postgres

// Parse Supabase REST URL & Service Key from DATABASE_URL if available, or use direct REST variables
let SUPABASE_REST_URL = process.env.SUPABASE_REST_URL;
let SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (DATABASE_URL && !SUPABASE_REST_URL) {
  // Extract project ref from postgresql://postgres:pass@db.REF.supabase.co:5432/postgres
  const match = DATABASE_URL.match(/@db\.([a-z0-9]+)\.supabase\.co/);
  if (match && match[1]) {
    SUPABASE_REST_URL = `https://${match[1]}.supabase.co/rest/v1`;
  }
}

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------- SUPABASE REST API STORAGE HELPERS -------------------
async function getSupabaseHeaders() {
  // If service key is not explicitly provided, we can look for it or use standard anon/service key from env
  const apiKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
  return {
    'apikey': apiKey,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function getUserSession(userId) {
  if (!SUPABASE_REST_URL) {
    return { balance: 0, state: 'AWAITING_COUNTRY', country: null, orders: [], transactions: [] };
  }
  try {
    const headers = await getSupabaseHeaders();
    const userRes = await axios.get(`${SUPABASE_REST_URL}/users?user_id=eq.${userId}`, { headers });
    
    let user;
    if (!userRes.data || userRes.data.length === 0) {
      // Create user
      const newUserData = { user_id: userId, balance: 0, state: 'AWAITING_COUNTRY', country: null, selected_service_query: null, chosen_provider: null };
      await axios.post(`${SUPABASE_REST_URL}/users`, newUserData, { headers });
      user = newUserData;
    } else {
      user = userRes.data[0];
    }

    const ordersRes = await axios.get(`${SUPABASE_REST_URL}/orders?user_id=eq.${userId}&select=*`, { headers });
    const txRes = await axios.get(`${SUPABASE_REST_URL}/transactions?user_id=eq.${userId}&select=*`, { headers });

    return {
      balance: parseFloat(user.balance || 0),
      state: user.state || 'AWAITING_COUNTRY',
      country: user.country || null,
      selectedServiceQuery: user.selected_service_query || null,
      chosenProvider: user.chosen_provider || null,
      orders: (ordersRes.data || []).map(o => ({
        orderId: o.order_id,
        provider: o.provider,
        serviceName: o.service_name,
        phoneNumber: o.phone_number,
        price: parseFloat(o.price || 0),
        status: o.status,
        date: o.date
      })),
      transactions: (txRes.data || []).map(t => ({
        amount: parseFloat(t.amount || 0),
        date: t.date
      }))
    };
  } catch (err) {
    console.error("Error fetching user session via REST:", err.message);
    return { balance: 0, state: 'AWAITING_COUNTRY', country: null, orders: [], transactions: [] };
  }
}

async function saveUserSession(userId, session) {
  if (!SUPABASE_REST_URL) return;
  try {
    const headers = await getSupabaseHeaders();
    await axios.patch(`${SUPABASE_REST_URL}/users?user_id=eq.${userId}`, {
      balance: session.balance,
      state: session.state,
      country: session.country,
      selected_service_query: session.selectedServiceQuery,
      chosen_provider: session.chosenProvider
    }, { headers });
  } catch (err) {
    console.error("Error saving user session via REST:", err.message);
  }
}

async function addOrderToDb(userId, orderRecord) {
  if (!SUPABASE_REST_URL) return;
  try {
    const headers = await getSupabaseHeaders();
    await axios.post(`${SUPABASE_REST_URL}/orders`, {
      user_id: userId,
      order_id: orderRecord.orderId,
      provider: orderRecord.provider,
      service_name: orderRecord.serviceName,
      phone_number: orderRecord.phoneNumber,
      price: orderRecord.price,
      status: orderRecord.status,
      date: orderRecord.date
    }, { headers });
  } catch (err) {
    console.error("Error adding order via REST:", err.message);
  }
}

async function updateOrderStatusInDb(orderId, newStatus) {
  if (!SUPABASE_REST_URL) return;
  try {
    const headers = await getSupabaseHeaders();
    await axios.patch(`${SUPABASE_REST_URL}/orders?order_id=eq.${orderId}`, {
      status: newStatus
    }, { headers });
  } catch (err) {
    console.error("Error updating order status via REST:", err.message);
  }
}

async function addTransactionToDb(userId, amount, date) {
  if (!SUPABASE_REST_URL) return;
  try {
    const headers = await getSupabaseHeaders();
    await axios.post(`${SUPABASE_REST_URL}/transactions`, {
      user_id: userId,
      amount: amount,
      date: date
    }, { headers });
  } catch (err) {
    console.error("Error adding transaction via REST:", err.message);
  }
}

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const robustAxiosConfig = {
  timeout: 15000,
  httpsAgent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
};

const USD_TO_NGN_RATE = 1500; 

// ------------------- PRICING CALCULATION LOGIC -------------------
function calculateFinalPrice(rawPrice, isAlreadyNgn = false) {
  const baseCostNgn = isAlreadyNgn ? rawPrice : (rawPrice * USD_TO_NGN_RATE);
  if (baseCostNgn < 3500) {
    return Math.ceil(baseCostNgn + 3000);
  } else {
    return Math.ceil(baseCostNgn * 2);
  }
}

// ------------------- PAYSTACK INTEGRATION -------------------
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

// ------------------- MULTI-API SMS PROVIDER INTEGRATION -------------------
const JUICYSMS_COUNTRIES = [
  { id: 'NL', name: 'Netherlands (NL)', short: 'nl' },
  { id: 'UK', name: 'United Kingdom (UK)', short: 'uk' },
  { id: 'USA', name: 'United States (USA)', short: 'usa' },
  { id: 'DE', name: 'Germany (DE)', short: 'de' }
];

const PLUSVERIFY_COUNTRIES = [
  { id: 'us', name: 'United States (US)', short: 'us' },
  { id: 'ng', name: 'Nigeria (NG)', short: 'ng' }
];

const JUICYSMS_BASE_URL = 'https://juicysms.com/api';
const PLUSVERIFY_BASE_URL = 'https://plusverify.com.ng/api/v1';

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
        is_ngn: false,
        server_id: countryId
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function getPlusVerifyServices() {
  try {
    const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
    if (!cleanApiKey) return [];

    const res = await axios.post(`${PLUSVERIFY_BASE_URL}/services.php`, {
      api_key: cleanApiKey
    }, {
      ...robustAxiosConfig,
      headers: { ...robustAxiosConfig.headers, 'Content-Type': 'application/json' }
    });

    const data = res.data;
    let servicesList = [];
    if (data && (data.success === true || data.status === 'success') && Array.isArray(data.services || data.otp_services)) {
      servicesList = data.services || data.otp_services;
    } else if (Array.isArray(data)) {
      servicesList = data;
    }

    if (servicesList.length > 0) {
      return servicesList.map(item => ({
        service_id: item.id || item.service_id || item.code || '',
        service_name: item.name || item.title || item.service_name || item.id || '',
        stock: 100,
        price: parseFloat(item.price || 0),
        is_ngn: true
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function getPlusVerifyPrice(serviceId, countryId) {
  try {
    const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
    if (!cleanApiKey) return null;

    const res = await axios.post(`${PLUSVERIFY_BASE_URL}/price.php`, {
      api_key: cleanApiKey,
      service_id: serviceId,
      country_id: countryId
    }, {
      ...robustAxiosConfig,
      headers: { ...robustAxiosConfig.headers, 'Content-Type': 'application/json' }
    });

    const data = res.data;
    if (data && (data.success === true || data.status === 'success') && typeof data.price !== 'undefined') {
      return parseFloat(data.price);
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function fetchCombinedServices(country) {
  const results = [];
  
  const juicyMatch = JUICYSMS_COUNTRIES.find(c => c.id.toLowerCase() === country.id.toLowerCase());
  if (juicyMatch) {
    const juicyData = await getJuicySmsServices(juicyMatch.id);
    if (Array.isArray(juicyData)) {
      juicyData.forEach(s => {
        results.push({
          provider: 'juicysms',
          service_id: s.service_id,
          service_name: s.service_name,
          operator_id: juicyMatch.id,
          server_label: 'Server One',
          server_name: `${country.name} (Server One)`,
          stock: s.stock || 10,
          price: s.price,
          is_ngn: false
        });
      });
    }
  }

  const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
  const plusMatch = PLUSVERIFY_COUNTRIES.find(c => c.id.toLowerCase() === country.id.toLowerCase());
  
  if (cleanApiKey && plusMatch) {
    const plusData = await getPlusVerifyServices();
    if (Array.isArray(plusData)) {
      for (const s of plusData) {
        const livePrice = await getPlusVerifyPrice(s.service_id, country.id.toLowerCase());
        if (livePrice !== null) {
          results.push({
            provider: 'plusverify',
            service_id: s.service_id,
            service_name: s.service_name,
            operator_id: country.id.toLowerCase(),
            server_label: 'Server Two',
            server_name: `${country.name} (Server Two)`,
            stock: 100,
            price: livePrice,
            is_ngn: true
          });
        }
      }
    }
  }

  return results;
}

async function executeOrder(provider, serviceId, countryId) {
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      const res = await axios.post(`${PLUSVERIFY_BASE_URL}/otp.php`, {
        api_key: cleanApiKey,
        service_id: serviceId,
        country_id: countryId
      }, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Content-Type': 'application/json' }
      });
      const data = res.data;
      if (data && (data.success === true || data.status === 'success') && (data.order_id || data.id) && (data.phone_number || data.number)) {
        return { 
          success: true, 
          data: { 
            order_id: String(data.order_id || data.id), 
            number: String(data.phone_number || data.number),
            charge: parseFloat(data.charge || data.price || 0)
          } 
        };
      }
      return { success: false, message: data?.message || 'Stock unavailable or insufficient balance on PlusVerify.' };
    } catch (err) {
      return { success: false, message: 'PlusVerify request failed.' };
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
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      const res = await axios.post(`${PLUSVERIFY_BASE_URL}/status.php`, {
        api_key: cleanApiKey,
        order_id: orderId
      }, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Content-Type': 'application/json' }
      });
      const data = res.data;
      if (data && (data.success === true || data.status === 'success' || data.status === 'COMPLETED' || data.sms_code)) {
        const code = data.sms_code || data.code || data.otp;
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
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      await axios.post(`${PLUSVERIFY_BASE_URL}/update_status.php`, {
        api_key: cleanApiKey,
        order_id: orderId,
        status: 8
      }, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Content-Type': 'application/json' }
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

// ------------------- BOT COMMANDS -------------------
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
    `I dey here to help you get virtual numbers fast fast! 🚀\n` +
    `• Type a country code (e.g., _US_, _NG_, _NL_, _UK_)\n` +
    `• Type */orders* to view your order history & tracking IDs!\n` +
    `• Type */history* to check your wallet funding records!\n` +
    `• Type */fund* to top up your wallet balance!\n` +
    `• Type *support* anytime to speak to customer care.`,
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
    ctx.reply(`📭 You don't have any order history yet. Buy a number to see it here!`, { parse_mode: 'Markdown' });
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

bot.command(['history', 'funding_history', 'transactions'], async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  if (!session.transactions || session.transactions.length === 0) {
    ctx.reply(`📭 No wallet funding history found yet.`, { parse_mode: 'Markdown' });
    return;
  }

  const recentTx = session.transactions.slice(-10).reverse().map(t =>
    `• *Credited:* ₦${t.amount.toLocaleString()}\n` +
    `  🕒 *Date:* ${t.date}`
  ).join('\n\n');

  ctx.reply(`💳 *WALLET FUNDING HISTORY*\n\n${recentTx}`, { parse_mode: 'Markdown' });
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

// ------------------- TEXT ROUTING ENGINE -------------------
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

  if (['/start', 'change country', 'countries', 'back'].some(k => lowerText.includes(k))) {
    session.state = 'AWAITING_COUNTRY';
    session.country = null;
    session.selectedServiceQuery = null;
    session.chosenProvider = null;
    await saveUserSession(userId, session);
    ctx.reply(`No p boss! Which country you wan check now? (Type *US*, *NG*, *NL*, *UK*, *USA*, or *DE*)`, { parse_mode: 'Markdown' });
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

  const allSupportedCountries = [...JUICYSMS_COUNTRIES, ...PLUSVERIFY_COUNTRIES];

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
             (cleanInput.includes('ng') && cId === 'ng');
    });
  };

  if (allSupportedCountries.length > 0) {
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

    if (matchedCountry && serviceQueryWords.length > 0) {
      const serviceQuery = serviceQueryWords.join(' ');
      session.country = matchedCountry;
      session.selectedServiceQuery = serviceQuery;
      session.state = 'AWAITING_SERVER_SELECTION';
      await saveUserSession(userId, session);
      await promptServerSelection(ctx, session);
      return;
    }
  }

  const matchedCountryDirect = getNormalizedCountry(lowerText);
  if (matchedCountryDirect) {
    session.country = matchedCountryDirect;
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    ctx.reply(
      `Ehen! You select *${matchedCountryDirect.name}* 👌\n\n` +
      `Which app or service you wan verify? (e.g., _WhatsApp_, _Telegram_, _Google_)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (session.state === 'AWAITING_SERVICE' && session.country) {
    session.selectedServiceQuery = rawText;
    session.state = 'AWAITING_SERVER_SELECTION';
    await saveUserSession(userId, session);
    await promptServerSelection(ctx, session);
    return;
  }

  ctx.reply(`Please state your country code first (e.g., type *US* or *US WhatsApp*).`, { parse_mode: 'Markdown' });
});

// ------------------- FLOW: ASK SERVER FIRST, THEN PRICE -------------------
async function promptServerSelection(ctx, session) {
  ctx.reply(`Checking available servers and stock... ⏳`);
  const availableServers = await fetchCombinedServices(session.country);
  const q = session.selectedServiceQuery.toLowerCase().trim();
  
  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return sName === q || sName.includes(q) || q.includes(sName) || sId === q || sId.includes(q);
  });

  if (filtered.length === 0) {
    session.state = 'AWAITING_SERVICE';
    const userId = ctx.from.id;
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

  const serverButtons = [];
  uniqueServersMap.forEach((srv, label) => {
    serverButtons.push([Markup.button.callback(`🖥️ ${label} (${session.country.name})`, `server|${srv.provider}|${session.country.id}`)]);
  });
  serverButtons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Oya boss! You selected *${session.selectedServiceQuery}* for *${session.country.name}*.\n\n` +
    `Please select your preferred server below: 👇`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(serverButtons) }
  );
}

bot.action(/^server\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const provider = ctx.match[1];
  const countryId = ctx.match[2];

  session.chosenProvider = provider;
  await saveUserSession(userId, session);

  const availableServers = await fetchCombinedServices(session.country);
  const q = (session.selectedServiceQuery || '').toLowerCase().trim();

  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return String(s.provider) === String(provider) && (sName === q || sName.includes(q) || q.includes(sName) || sId === q || sId.includes(q));
  });

  if (filtered.length === 0) {
    ctx.reply(`❌ No services found on this server. Please try again.`);
    return;
  }

  const buttons = filtered.map((srv) => {
    const finalPrice = calculateFinalPrice(srv.price, srv.is_ngn);
    const cbData = `buy|${srv.provider}|${session.country.id}|${srv.service_id}`;
    return [Markup.button.callback(`💰 ${srv.server_label} Price: ₦${finalPrice.toLocaleString()} (${srv.stock} left)`, cbData)];
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

// ------------------- BUTTON HANDLERS FOR BUYING -------------------
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
    await saveUserSession(userId, session);

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
  ctx.reply(`No p boss! Which country you wan check now? (Type *US*, *NG*, *NL*, *UK* or *DE*)`);
});

// ------------------- WEBHOOKS & SERVER START -------------------
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
