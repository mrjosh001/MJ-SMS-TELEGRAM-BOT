const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ------------------- ENVIRONMENT VARIABLES -------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const JUICYSMS_API_KEY = process.env.JUICYSMS_API_KEY || process.env.SECOND_SMS_API_KEY;
const PLUSVERIFY_API_KEY = process.env.PLUSVERIFY_API_KEY; // PlusVerify API Key from https://plusverify.com.ng/profile.php
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// API Base URLs
const JUICYSMS_BASE_URL = 'https://juicysms.com/api';
const PLUSVERIFY_BASE_URL = 'https://plusverify.com.ng/api'; // Official PlusVerify Base URL endpoints

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------- PERSISTENT STORAGE (SAFE MIGRATION) -------------------
const DB_FILE = path.join(__dirname, 'users.json');
let userSessions = {};

function loadSessions() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const rawData = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(rawData);
      
      // Ensure absolute data integrity for existing customers (safeguarding balances & order history)
      userSessions = {};
      for (const [userId, userData] of Object.entries(parsed)) {
        userSessions[userId] = {
          balance: typeof userData.balance === 'number' ? userData.balance : 0,
          state: userData.state || 'AWAITING_COUNTRY',
          country: userData.country || null,
          orders: Array.isArray(userData.orders) ? userData.orders : [],
          transactions: Array.isArray(userData.transactions) ? userData.transactions : []
        };
      }
    } else {
      userSessions = {};
    }
  } catch (err) {
    console.error("Error loading users.json, starting safe fallback:", err.message);
    userSessions = {};
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(userSessions, null, 2), 'utf8');
  } catch (err) {
    console.error("Error saving users.json:", err.message);
  }
}

loadSessions();

function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { 
      balance: 0, 
      state: 'AWAITING_COUNTRY', 
      country: null,
      orders: [],
      transactions: []
    };
    saveSessions();
  }
  if (typeof userSessions[userId].balance !== 'number') userSessions[userId].balance = 0;
  if (!Array.isArray(userSessions[userId].orders)) userSessions[userId].orders = [];
  if (!Array.isArray(userSessions[userId].transactions)) userSessions[userId].transactions = [];
  return userSessions[userId];
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

/**
 * Integrated strictly following PlusVerify documentation requirements:
 * GET services.php?api_key=KEY
 */
async function getPlusVerifyServices() {
  try {
    const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
    if (!cleanApiKey) return [];

    const res = await axios.get(`${PLUSVERIFY_BASE_URL}/services.php`, {
      ...robustAxiosConfig,
      params: { api_key: cleanApiKey }
    });

    const data = res.data;
    if (data && data.success && Array.isArray(data.otp_services)) {
      return data.otp_services.map(item => ({
        service_id: item.id || '',
        service_name: item.name || item.id || '',
        stock: 100, // Default stock availability for native plusverify items
        price: parseFloat(item.price || 0),
        is_ngn: true
      })).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];
  
  // Fetch from JuicySMS if country matches Juicy format
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
          server_name: `${juicyMatch.name} (JuicySMS)`,
          stock: s.stock || 10,
          price: s.price,
          is_ngn: false
        });
      });
    }
  }

  // Fetch from PlusVerify if country matches PlusVerify format or universally
  const plusData = await getPlusVerifyServices();
  if (Array.isArray(plusData)) {
    plusData.forEach(s => {
      results.push({
        provider: 'plusverify',
        service_id: s.service_id,
        service_name: s.service_name,
        operator_id: country.id.toLowerCase(),
        server_name: `${country.name} (PlusVerify)`,
        stock: s.stock || 100,
        price: s.price,
        is_ngn: true
      });
    });
  }

  return results;
}

/**
 * Execute order adhering precisely to PlusVerify otp.php / JuicySMS patterns
 */
async function executeOrder(provider, serviceId, countryId) {
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      // PlusVerify POST/GET otp.php endpoint as per official docs
      const res = await axios.post(`${PLUSVERIFY_BASE_URL}/otp.php`, null, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, service_id: serviceId, country_id: countryId }
      });
      const data = res.data;
      if (data && data.success && data.order_id && data.phone_number) {
        return { 
          success: true, 
          data: { 
            order_id: String(data.order_id), 
            number: String(data.phone_number),
            charge: parseFloat(data.charge || 0)
          } 
        };
      }
      return { success: false, message: data?.message || 'Stock unavailable or insufficient balance on PlusVerify.' };
    } catch (err) {
      return { success: false, message: 'PlusVerify request failed.' };
    }
  } else {
    // JuicySMS Handler
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

/**
 * Polling SMS code adhering to PlusVerify status.php / JuicySMS getsms patterns
 */
async function checkSmsCode(provider, orderId) {
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      const res = await axios.post(`${PLUSVERIFY_BASE_URL}/status.php`, null, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, order_id: orderId }
      });
      const data = res.data;
      if (data && data.success && data.sms_code) {
        return { success: true, data: { code: String(data.sms_code) } };
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

/**
 * Cancel order adhering to PlusVerify update_status.php (status=8) / JuicySMS cancelorder
 */
async function cancelOrder(provider, orderId) {
  if (provider === 'plusverify') {
    try {
      const cleanApiKey = PLUSVERIFY_API_KEY ? PLUSVERIFY_API_KEY.trim() : '';
      await axios.post(`${PLUSVERIFY_BASE_URL}/update_status.php`, null, {
        ...robustAxiosConfig,
        params: { api_key: cleanApiKey, order_id: orderId, status: 8 }
      });
    } catch (err) {
      console.error("PlusVerify cancel order error:", err.message);
    }
  } else {
    try {
      const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
      await axios.get(`${JUICYSMS_BASE_URL}/cancelorder`, {
        ...robustAxiosConfig,
        params: { key: cleanApiKey, orderId: orderId }
      });
    } catch (err) {
      console.error("JuicySMS cancel order error:", err.message);
    }
  }
}

// ------------------- BOT COMMANDS -------------------
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  session.country = null;
  saveSessions();

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

bot.command(['balance', 'bal'], (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  ctx.reply(`Boss your current balance na ₦${(session.balance || 0).toLocaleString()} ✨`, { parse_mode: 'Markdown' });
});

bot.command(['fund', 'deposit', 'wallet', 'topup'], (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_DEPOSIT_AMOUNT';
  saveSessions();

  ctx.reply(
    `💳 *MJ SMS WALLET TOP-UP*\n\n` +
    `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
    `Enter the amount you want to deposit in Naira (e.g., *1000*, *2000*, *5000*):`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['orders', 'history_orders'], (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
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

bot.command(['history', 'funding_history', 'transactions'], (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
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
  const session = getUserSession(userId);

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
    saveSessions();
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
    saveSessions();
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
      saveSessions();
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
      session.state = 'AWAITING_SERVICE';
      saveSessions();
      ctx.reply(`Oya wait make we check available servers for *${serviceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, serviceQuery);
      return;
    }
  }

  const matchedCountryDirect = getNormalizedCountry(lowerText);
  if (matchedCountryDirect) {
    session.country = matchedCountryDirect;
    session.state = 'AWAITING_SERVICE';
    saveSessions();
    ctx.reply(
      `Ehen! You select *${matchedCountryDirect.name}* 👌\n\n` +
      `Which app or service you wan verify? (e.g., _WhatsApp_, _Telegram_, _Google_)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (session.state === 'AWAITING_SERVICE' && session.country) {
    ctx.reply(`Oya wait make we check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
    return;
  }

  ctx.reply(`Please state your country code first (e.g., type *US* or *US WhatsApp*).`, { parse_mode: 'Markdown' });
});

async function processServiceSelection(ctx, session, serviceQuery) {
  const availableServers = await fetchCombinedServices(session.country);
  
  const q = serviceQuery.toLowerCase().trim();
  const filtered = availableServers.filter(s => {
    const sName = String(s.service_name || '').toLowerCase();
    const sId = String(s.service_id || '').toLowerCase();
    return sName === q || sName.includes(q) || q.includes(sName) || sId === q || sId.includes(q);
  });

  if (filtered.length === 0) {
    const topServices = availableServers.slice(0, 15).map(s => `• ${s.service_name} (${s.stock} left)`).join('\n');
    ctx.reply(
      `Eya! No stock found for *${serviceQuery}* right now. 💔\n\n` +
      `Here are available services on this server:\n${topServices || 'None available'}\n\n` +
      `Type another app name or type *change country* to switch.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const buttons = filtered.map((srv) => {
    const finalPrice = calculateFinalPrice(srv.price, srv.is_ngn);
    const cbData = `buy|${srv.provider}|${session.country.id}|${srv.service_id}`;
    return [Markup.button.callback(`🖥️ ${srv.server_name} (${srv.stock} left) — ₦${finalPrice.toLocaleString()}`, cbData)];
  });

  buttons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Ehen boss! See available options for *${serviceQuery}*:\n\nTap option below to buy:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ------------------- BUTTON HANDLERS -------------------
bot.action(/^buy\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = getUserSession(userId);
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
    session.orders.push(orderRecord);
    saveSessions();

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
        
        const foundOrder = session.orders.find(o => o.orderId === orderId);
        if (foundOrder) {
          foundOrder.status = `Completed (Code: ${checkRes.data.code})`;
          saveSessions();
        }

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
          session.balance += calculatedNgnPrice;
          
          const foundOrder = session.orders.find(o => o.orderId === orderId);
          if (foundOrder) {
            foundOrder.status = 'Canceled & Refunded (Timeout)';
            saveSessions();
          }
        }
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order canceled and ₦${calculatedNgnPrice.toLocaleString()} refunded to your balance!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Server out of stock or insufficient account balance.'}`);
  }
});

bot.action('reset_flow', (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  session.country = null;
  saveSessions();
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
      const session = getUserSession(userId);
      session.balance = (session.balance || 0) + amountPaidNgn;
      
      session.transactions.push({
        amount: amountPaidNgn,
        date: new Date().toLocaleString()
      });
      saveSessions();

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
