const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();

// Express JSON Middleware (Critical for receiving Paystack webhooks)
app.use(express.json());

// Environment variables provided by Render
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const SECOND_SMS_API_KEY = process.env.SECOND_SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Provider Base Endpoints
const LOGSDOMAIN_BASE_URL = 'https://logsdomain.com/api/v1';
const ALLSMSVERIFY_BASE_URL = 'https://allsmsverify.com/stubs/handler_api.php';

// ALLSMSVERIFY / SMS-ACTIVATE COUNTRY ID MAPPER
const ALLSMSVERIFY_COUNTRY_MAP = {
  'ru': 0, 'ua': 1, 'kz': 2, 'cn': 3, 'ph': 4, 'mm': 5, 'id': 6, 'my': 7,
  'ke': 8, 'tz': 9, 'vn': 10, 'kg': 11, 'us': 12, 'il': 13, 'hk': 14, 'pl': 15,
  'gb': 16, 'ng': 19, 'in': 22, 'br': 27, 'ca': 36, 'de': 43, 'fr': 78
};

function getAllSmsCountryId(shortCode) {
  if (!shortCode) return 12; // default USA
  const cleanCode = String(shortCode).toLowerCase().trim();
  return ALLSMSVERIFY_COUNTRY_MAP[cleanCode] !== undefined 
    ? ALLSMSVERIFY_COUNTRY_MAP[cleanCode] 
    : cleanCode;
}

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------- PERSISTENT BALANCE STORAGE -------------------
const DB_FILE = path.join(__dirname, 'users.json');
let userSessions = {};

// Load user sessions/balances from disk on startup
function loadSessions() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const rawData = fs.readFileSync(DB_FILE, 'utf8');
      userSessions = JSON.parse(rawData);
      console.log(`Loaded ${Object.keys(userSessions).length} user balances from storage.`);
    } else {
      userSessions = {};
    }
  } catch (err) {
    console.error("Error reading users.json database:", err.message);
    userSessions = {};
  }
}

// Save user sessions/balances to disk whenever updated
function saveSessions() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(userSessions, null, 2), 'utf8');
  } catch (err) {
    console.error("Error saving users.json database:", err.message);
  }
}

// Initialize sessions on server startup
loadSessions();

// Custom HTTPS agent to prevent TLS drops
const agent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false
});

const robustAxiosConfig = {
  timeout: 15000,
  httpsAgent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
};

// ------------------- DYNAMIC PROFIT MARGIN CONFIG -------------------
const DEFAULT_MARGIN = 1.4;

const SERVICE_PRICING_RULES = {
  'whatsapp': { minPrice: 6000, multiplier: 1.8 },
  'telegram': { minPrice: 3500, multiplier: 1.6 },
  'facebook': { minPrice: 2000, multiplier: 1.5 },
  'bamboo': { minPrice: 4000, multiplier: 1.7 }
};

function calculateRetailPrice(serviceName, providerPriceNgn) {
  const serviceKey = serviceName.toLowerCase();
  const rule = SERVICE_PRICING_RULES[serviceKey];

  let calculatedPrice = providerPriceNgn * DEFAULT_MARGIN;
  let minPrice = 0;

  if (rule) {
    calculatedPrice = providerPriceNgn * (rule.multiplier || DEFAULT_MARGIN);
    minPrice = rule.minPrice || 0;
  }

  return Math.ceil(Math.max(calculatedPrice, minPrice));
}

// ------------------- PAYSTACK INTEGRATION -------------------

async function initializePaystackPayment(email, amountNgn, userId) {
  if (!PAYSTACK_SECRET_KEY) {
    console.error("PAYSTACK_SECRET_KEY is missing in Render Environment Variables.");
    return { status: false, message: "Paystack secret key is missing." };
  }
  try {
    const res = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: Math.round(amountNgn * 100), // Convert NGN to Kobo
        metadata: {
          telegram_id: String(userId),
          custom_fields: [
            {
              display_name: "Telegram User ID",
              variable_name: "telegram_id",
              value: String(userId)
            }
          ]
        }
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
    console.error("Paystack Initialization Error:", err.response?.data || err.message);
    return { status: false, message: "Could not create payment link." };
  }
}

// ------------------- LOGSDOMAIN INTEGRATION -------------------

async function getCountries() {
  const cleanKey = SMS_API_KEY ? SMS_API_KEY.trim() : null;
  if (!cleanKey) return [];
  try {
    const res = await axios.get(`${LOGSDOMAIN_BASE_URL}/numbers/countries`, {
      ...robustAxiosConfig,
      headers: { ...robustAxiosConfig.headers, 'Authorization': `Bearer ${cleanKey}` }
    });
    return res.data?.success ? res.data.data : [];
  } catch (err) {
    console.error("Error fetching countries:", err.response?.data || err.message);
    return [];
  }
}

async function getLogsDomainServices(countryId) {
  const cleanKey = SMS_API_KEY ? SMS_API_KEY.trim() : null;
  if (!cleanKey) return [];
  try {
    const res = await axios.get(`${LOGSDOMAIN_BASE_URL}/numbers/services?country_id=${countryId}`, {
      ...robustAxiosConfig,
      headers: { ...robustAxiosConfig.headers, 'Authorization': `Bearer ${cleanKey}` }
    });
    if (!res.data || !res.data.data) return [];
    return Array.isArray(res.data.data) ? res.data.data : Object.values(res.data.data);
  } catch (err) {
    console.error("LogsDomain Services Error:", err.response?.data || err.message);
    return [];
  }
}

// ------------------- ALLSMSVERIFY INTEGRATION -------------------

async function getAllSmsVerifyServices(countryShortCode) {
  const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : null;
  if (!cleanApiKey) return [];

  const targetCountry = getAllSmsCountryId(countryShortCode);

  try {
    const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: {
        action: 'getServices',
        api_key: cleanApiKey,
        country: targetCountry
      }
    });

    const data = res.data;
    const respString = String(data).trim();

    if (respString.includes('BAD_KEY') || respString.includes('BAD_COUNTRY') || respString.includes('<!DOCTYPE html>')) {
      return [];
    }

    if (Array.isArray(data)) return data;

    if (data && typeof data === 'object') {
      return Object.entries(data).map(([key, item]) => {
        if (typeof item === 'object') {
          return {
            service_id: key,
            service_name: item.name || item.title || key,
            stock: item.count || item.stock || item.available || 10,
            price: item.cost || item.price || 0
          };
        }
        return null;
      }).filter(Boolean);
    }

    return [];
  } catch (err) {
    console.error("AllSMSVerify Services Error:", err.message);
    return [];
  }
}

// ------------------- COMBINED PROVIDER DISPATCHER -------------------

async function fetchCombinedServices(country) {
  const results = [];

  // 1. LogsDomain
  const logsData = await getLogsDomainServices(country.id);
  if (Array.isArray(logsData)) {
    logsData.forEach(s => {
      const serviceName = s.service_name || s.name || s.title || '';
      const serviceId = s.service_id || s.id || serviceName;

      let ops = s.operators && s.operators.length ? s.operators : [{
        id: 'default',
        name: s.operator_name || 'Server 1',
        available_quantity: s.available_quantity || s.count || 0,
        price: s.price
      }];

      ops.forEach(op => {
        const stock = op.available_quantity || op.count || s.available_quantity || 0;
        if (stock > 0) {
          results.push({
            provider: 'logsdomain',
            service_id: serviceId,
            service_name: serviceName,
            operator_id: op.id === 'default' ? null : op.id,
            server_name: op.name || 'Server 1',
            stock: stock,
            price: parseFloat(op.price || s.price || 0)
          });
        }
      });
    });
  }

  // 2. AllSMSVerify
  const allSmsData = await getAllSmsVerifyServices(country.short);
  if (Array.isArray(allSmsData)) {
    allSmsData.forEach(s => {
      const serviceName = s.service_name || s.name || s.title || s.service || '';
      const stock = s.stock || s.available_quantity || s.count || 0;
      if (stock > 0) {
        results.push({
          provider: 'allsmsverify',
          service_id: s.service_id || s.code || serviceName,
          service_name: serviceName,
          operator_id: s.operator_id || null,
          server_name: s.server_name || s.operator_name || 'Server (AllSMS)',
          stock: stock,
          price: parseFloat(s.price || 0)
        });
      }
    });
  }

  return results;
}

function matchesServiceQuery(serviceName, query) {
  if (!serviceName) return false;
  const sName = String(serviceName).toLowerCase();
  const q = String(query).toLowerCase().trim();

  if (sName === q || sName.includes(q) || q.includes(sName)) return true;
  if ((q === 'telegram' || q === 'tg') && (sName.includes('telegram') || sName.includes('tg'))) return true;
  if ((q === 'whatsapp' || q === 'wa') && (sName.includes('whatsapp') || sName.includes('wa'))) return true;
  if ((q === 'facebook' || q === 'fb') && (sName.includes('facebook') || sName.includes('fb'))) return true;

  return false;
}

// ------------------- PURCHASE & POLLING EXECUTION -------------------

async function executePurchase(provider, countryId, countryShort, serviceId, operatorId) {
  if (provider === 'a' || provider === 'allsmsverify') {
    try {
      const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
      const targetCountry = getAllSmsCountryId(countryShort);

      const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
        ...robustAxiosConfig,
        params: {
          action: 'getNumber',
          api_key: cleanApiKey,
          service: serviceId,
          country: targetCountry
        }
      });

      const respText = String(res.data).trim();
      if (respText.startsWith('ACCESS_NUMBER')) {
        const parts = respText.split(':');
        return { success: true, data: { order_id: parts[1], number: parts[2] } };
      }
      return { success: false, message: respText || 'AllSMSVerify stock unavailable.' };
    } catch (err) {
      return { success: false, message: 'AllSMSVerify request failed.' };
    }
  } else {
    try {
      const cleanApiKey = SMS_API_KEY ? SMS_API_KEY.trim() : '';
      const payload = {
        country_id: parseInt(countryId),
        service_id: parseInt(serviceId),
        idempotency_key: `mj-order-${Date.now()}`
      };
      if (operatorId && operatorId !== '0') payload.operator_id = operatorId;

      const res = await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders`, payload, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Authorization': `Bearer ${cleanApiKey}` }
      });
      return res.data;
    } catch (err) {
      return err.response?.data || { success: false, message: 'Logsdomain purchase failed.' };
    }
  }
}

async function checkSmsCode(provider, orderId) {
  try {
    if (provider === 'a' || provider === 'allsmsverify') {
      const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
      const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
        ...robustAxiosConfig,
        params: { action: 'getStatus', api_key: cleanApiKey, id: orderId }
      });
      const respText = String(res.data).trim();
      if (respText.startsWith('STATUS_OK')) {
        return { success: true, data: { code: respText.split(':')[1] } };
      }
      return { success: false };
    } else {
      const cleanApiKey = SMS_API_KEY ? SMS_API_KEY.trim() : '';
      const res = await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders/${orderId}/check`, {}, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Authorization': `Bearer ${cleanApiKey}` }
      });
      return res.data;
    }
  } catch (err) {
    return { success: false };
  }
}

async function cancelOrder(provider, orderId) {
  try {
    if (provider === 'a' || provider === 'allsmsverify') {
      const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
      await axios.get(ALLSMSVERIFY_BASE_URL, {
        ...robustAxiosConfig,
        params: { action: 'setStatus', api_key: cleanApiKey, id: orderId, status: 8 }
      });
    } else {
      const cleanApiKey = SMS_API_KEY ? SMS_API_KEY.trim() : '';
      await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders/${orderId}/cancel`, {}, {
        ...robustAxiosConfig,
        headers: { ...robustAxiosConfig.headers, 'Authorization': `Bearer ${cleanApiKey}` }
      });
    }
  } catch (err) {
    console.error("Cancel order error:", err.message);
  }
}

// Helper to ensure session exists without overwriting stored balance
function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { balance: 0, state: 'AWAITING_COUNTRY' };
    saveSessions();
  }
  return userSessions[userId];
}

// ------------------- ELSA BOT COMMANDS & FLOWS -------------------

bot.start((ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  saveSessions();

  const balance = session.balance || 0;

  ctx.reply(
    `How far boss! 👋 My name is *Elsa*. Welcome to *MJ SMS*! ✨\n` +
    `Have a happy day today! 😊\n\n` +
    `💰 *Your Balance:* ₦${balance.toLocaleString()}\n\n` +
    `I dey here to help you get virtual numbers fast fast! 🚀\n` +
    `• Type a country name (e.g., _United States_, _Nigeria_)\n` +
    `• Type */fund* to top up your wallet balance!\n` +
    `• Type *support* anytime to speak to customer care.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['fund', 'deposit', 'wallet', 'balance'], (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_DEPOSIT_AMOUNT';
  saveSessions();

  ctx.reply(
    `💳 *MJ SMS WALLET TOP-UP*\n\n` +
    `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
    `Enter the amount you want to deposit in Naira (e.g., reply with *1000*, *2000*, or *5000*):`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['support', 'help', 'customercare'], (ctx) => {
  sendCustomerSupportMessage(ctx);
});

function sendCustomerSupportMessage(ctx) {
  ctx.reply(
    `💬 *MJ SMS CUSTOMER CARE*\n\n` +
    `Need help with an order, wallet funding, or custom numbers?\n` +
    `Tap the button below to reach our support on WhatsApp: 👇`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💬 Chat Customer Care on WhatsApp', 'https://wa.me/qr/XM6ORO7UCYTXI1')]
      ])
    }
  );
}

// ------------------- TEXT MESSAGE HANDLER -------------------

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  const session = getUserSession(userId);

  // A. Catch Support / Customer Care Keywords
  if (['support', 'customer care', 'speak to support', 'help', 'admin', 'contact'].some(k => lowerText.includes(k))) {
    sendCustomerSupportMessage(ctx);
    return;
  }

  // B. Catch plain "balance", "wallet"
  if (['balance', 'wallet', 'my balance', 'check balance'].includes(lowerText)) {
    const bal = session.balance || 0;
    ctx.reply(
      `💰 *YOUR WALLET BALANCE:* ₦${bal.toLocaleString()}\n\n` +
      `To top up, type */fund* or reply with an amount like *fund 1000*.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // C. Catch plain "fund", "deposit", "topup"
  if (['fund', 'deposit', 'topup', 'top up'].includes(lowerText)) {
    session.state = 'AWAITING_DEPOSIT_AMOUNT';
    saveSessions();
    ctx.reply(
      `💳 *MJ SMS WALLET TOP-UP*\n\n` +
      `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
      `Enter the amount you want to deposit in Naira (e.g., reply with *1000*, *2000*, or *5000*):`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // D. Catch "fund 1000" or "deposit 5000"
  const fundMatch = lowerText.match(/^(?:fund|deposit|topup)\s+(\d+)$/i);
  if (fundMatch) {
    const amount = parseInt(fundMatch[1]);
    if (amount < 100) {
      ctx.reply("Minimum deposit amount is ₦100.");
      return;
    }

    ctx.reply(`Generating your Paystack payment link... ⏳`);
    const userEmail = `${userId}@mjsms.com`;
    const payment = await initializePaystackPayment(userEmail, amount, userId);

    if (payment.status && payment.data?.authorization_url) {
      session.state = 'IDLE';
      saveSessions();
      ctx.reply(
        `💳 *PAYSTACK PAYMENT LINK READY*\n\n` +
        `Amount: *₦${amount.toLocaleString()}*\n\n` +
        `Tap the button below to complete payment. Your wallet will be credited automatically once done! 👇`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('💳 Pay Now via Paystack', payment.data.authorization_url)]
          ])
        }
      );
    } else {
      ctx.reply(`❌ Could not generate payment link. Please try again.`);
    }
    return;
  }

  // E. Deposit Amount Input Handler
  if (session.state === 'AWAITING_DEPOSIT_AMOUNT') {
    const amount = parseInt(rawText.replace(/[^0-9]/g, ''));
    if (isNaN(amount) || amount < 100) {
      ctx.reply(`Please enter a valid amount (minimum ₦100). E.g. *1000*`);
      return;
    }

    ctx.reply(`Generating your Paystack payment link... ⏳`);
    const userEmail = `${userId}@mjsms.com`;
    const payment = await initializePaystackPayment(userEmail, amount, userId);

    if (payment.status && payment.data?.authorization_url) {
      session.state = 'IDLE';
      saveSessions();
      ctx.reply(
        `💳 *PAYSTACK PAYMENT LINK READY*\n\n` +
        `Amount: *₦${amount.toLocaleString()}*\n\n` +
        `Tap the button below to complete payment. Your wallet will be credited automatically once done! 👇`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('💳 Pay Now via Paystack', payment.data.authorization_url)]
          ])
        }
      );
    } else {
      ctx.reply(`❌ *Payment Error:* Could not generate payment link.`);
    }
    return;
  }

  // F. Detect "Which one dey available?" Intent
  const isAvailableQuery = [
    'available', 'which one', 'what is available', 'list', 'show', 'any number', 'which app'
  ].some(keyword => lowerText.includes(keyword));

  if (isAvailableQuery) {
    if (!session.country) {
      ctx.reply(`Please tell me which country you want to check first! (e.g., _United States_, _Nigeria_)`, { parse_mode: 'Markdown' });
      session.state = 'AWAITING_COUNTRY';
      saveSessions();
      return;
    }

    ctx.reply(`Checking all available services for *${session.country.name}*... 🔎`, { parse_mode: 'Markdown' });

    const available = await fetchCombinedServices(session.country);

    if (!available || available.length === 0) {
      ctx.reply(`Eya! No services are available right now for *${session.country.name}*. Please try another country!`, { parse_mode: 'Markdown' });
      return;
    }

    const uniqueServices = Array.from(new Set(available.map(s => s.service_name))).slice(0, 15);

    let message = `Here are available services for *${session.country.name}* right now: 👇\n\n`;
    uniqueServices.forEach((srv) => {
      message += `• *${srv}*\n`;
    });
    message += `\nType the name of any app above to select a server and buy!`;

    ctx.reply(message, { parse_mode: 'Markdown' });
    session.state = 'AWAITING_SERVICE';
    saveSessions();
    return;
  }

  // G. Standard Greetings
  if (['hi', 'hello', 'hey', 'awfa', 'howfar', 'how far', 'xup'].some(g => lowerText.includes(g))) {
    ctx.reply(
      `How far my boss! 😊 My name na *Elsa*, welcome to *MJ SMS*!\n` +
      `Have a happy day today! ✨\n\n` +
      `Which country virtual number you wan buy today? Just drop the country name for me.`
    );
    session.state = 'AWAITING_COUNTRY';
    saveSessions();
    return;
  }

  const countries = await getCountries();

  // H. Multi-word Input Detection ("USA WhatsApp")
  if (countries.length > 0) {
    const words = lowerText.split(/\s+/);
    let matchedCountry = null;
    let matchedServiceQuery = null;

    for (const word of words) {
      const found = countries.find(c => 
        c.name.toLowerCase() === word || 
        c.short.toLowerCase() === word ||
        (word === 'usa' && c.short.toLowerCase() === 'us') ||
        (word === 'uk' && c.short.toLowerCase() === 'gb')
      );
      if (found) {
        matchedCountry = found;
        matchedServiceQuery = words.filter(w => w !== word).join(' ');
        break;
      }
    }

    if (matchedCountry && matchedServiceQuery) {
      session.country = matchedCountry;
      session.state = 'AWAITING_SERVICE';
      saveSessions();
      ctx.reply(`Oya wait make Elsa check available servers for *${matchedServiceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, matchedServiceQuery);
      return;
    }
  }

  // I. Country Selection Logic
  if (session.state === 'AWAITING_COUNTRY' || session.state === 'IDLE') {
    ctx.reply(`Hold on boss, make I check available countries... 🔎`);
    
    const matchedCountry = countries.find(c => 
      c.name.toLowerCase().includes(lowerText) || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us') ||
      (lowerText === 'uk' && c.short.toLowerCase() === 'gb')
    );

    if (matchedCountry) {
      session.country = matchedCountry;
      session.state = 'AWAITING_SERVICE';
      saveSessions();
      ctx.reply(
        `Ehen! You select *${matchedCountry.name}* 👌\n\n` +
        `Which app or service you wan verify? (e.g. _WhatsApp_, _Telegram_, _Facebook_)`,
        { parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(`I no find "*${rawText}*" for available countries boss. Try *United States*, *United Kingdom*, or *Nigeria*!`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // J. Service Selection Logic
  if (session.state === 'AWAITING_SERVICE') {
    const newCountryMatch = countries.find(c => 
      c.name.toLowerCase() === lowerText || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us')
    );

    if (newCountryMatch) {
      session.country = newCountryMatch;
      saveSessions();
      ctx.reply(`Switched country to *${newCountryMatch.name}* 👌\n\nWhich app or service you wan verify?`, { parse_mode: 'Markdown' });
      return;
    }

    ctx.reply(`Oya wait make Elsa check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
  }
});

async function processServiceSelection(ctx, session, serviceQuery) {
  const availableServers = await fetchCombinedServices(session.country);

  const filtered = availableServers.filter(s => matchesServiceQuery(s.service_name, serviceQuery));

  if (filtered.length === 0) {
    ctx.reply(`Eya! Stock for *${serviceQuery}* (${session.country.name}) don finish across all servers! 💔\nTry another app or country.`, { parse_mode: 'Markdown' });
    return;
  }

  const buttons = filtered.map((srv) => {
    const finalPrice = calculateRetailPrice(srv.service_name, srv.price);
    const pCode = srv.provider === 'allsmsverify' ? 'a' : 'l';
    const opCode = srv.operator_id || '0';
    
    const cbData = `b|${pCode}|${session.country.id}|${srv.service_id}|${opCode}`;

    return [Markup.button.callback(`🖥️ ${srv.server_name} (${srv.stock} left) — ₦${finalPrice}`, cbData)];
  });

  buttons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Ehen boss! For *${serviceQuery}* (${session.country.name}), see the available servers below:\n\n` +
    `Which server or route you wan use buy the number? Tap option below:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ------------------- BUTTON ACTIONS -------------------

bot.action(/^b\|(.+)\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const pCode = ctx.match[1];
  const countryId = ctx.match[2];
  const serviceId = ctx.match[3];
  const operatorId = ctx.match[4] === '0' ? null : ctx.match[4];

  const provider = pCode === 'a' ? 'allsmsverify' : 'logsdomain';
  const userId = ctx.from.id;

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const countryShort = userSessions[userId]?.country?.short || 'us';
  const response = await executePurchase(provider, countryId, countryShort, serviceId, operatorId);

  if (response.success && (response.data || response.number)) {
    const orderData = response.data || response;
    const orderId = orderData.order_id || orderData.id;
    const phoneNumber = orderData.number || orderData.phone;

    ctx.reply(
      `🎉 *NUMBER PURCHASED SUCCESSFULLY!*\n\n` +
      `📞 *Phone Number:* \`${phoneNumber}\`\n\n` +
      `👉 Copy the number above and enter it into your app.\n` +
      `⏳ Elsa is waiting for your SMS code... (I go send am here automatically as e enter)`,
      { parse_mode: 'Markdown' }
    );

    let pollCount = 0;
    const maxPolls = 80;

    const intervalId = setInterval(async () => {
      pollCount++;
      const checkRes = await checkSmsCode(provider, orderId);

      if (checkRes.success && checkRes.data && checkRes.data.code) {
        clearInterval(intervalId);
        ctx.reply(
          `🔥🔥 *SMS CODE RECEIVED!* 🔥🔥\n\n` +
          `📞 *Number:* \`${phoneNumber}\`\n` +
          `🔑 *Verification Code:* \`${checkRes.data.code}\`\n\n` +
          `Thank you for using *MJ SMS*! Have a happy day! ✨`,
          { parse_mode: 'Markdown' }
        );
      } else if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        await cancelOrder(provider, orderId);
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order don cancel automatically!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Server out of stock or insufficient balance.'}`);
  }
});

bot.action('reset_flow', (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  saveSessions();
  ctx.reply(`No p boss! Which country number you wan check now?`);
});

// ------------------- WEBHOOKS & EXPRESS SERVER SETUP -------------------

const TELEGRAM_WEBHOOK_PATH = `/webhook/telegram`;
app.use(bot.webhookCallback(TELEGRAM_WEBHOOK_PATH));

// Paystack Webhook Handler
app.post('/webhook/paystack', async (req, res) => {
  const event = req.body;

  if (event && event.event === 'charge.success') {
    const data = event.data;
    const userId = data.metadata?.telegram_id;
    const amountPaidNgn = data.amount / 100;

    if (userId) {
      const session = getUserSession(userId);
      session.balance = (session.balance || 0) + amountPaidNgn;
      saveSessions(); // Write updated balance to disk immediately

      try {
        await bot.telegram.sendMessage(
          userId,
          `🎉 *PAYMENT SUCCESSFUL!*\n\n` +
          `💳 *Amount Credited:* ₦${amountPaidNgn.toLocaleString()}\n` +
          `💰 *New Wallet Balance:* ₦${session.balance.toLocaleString()}\n\n` +
          `You can now select a country and buy virtual numbers!`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error("Failed to notify user:", err.message);
      }
    }
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('MJ SMS Bot (Elsa) is Active!'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (SERVER_URL) {
    const fullWebhookUrl = `${SERVER_URL}${TELEGRAM_WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`Telegram Webhook set to: ${fullWebhookUrl}`);
    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  }
});
