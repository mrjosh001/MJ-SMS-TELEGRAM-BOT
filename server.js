const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// ------------------- ENVIRONMENT VARIABLES -------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const SECOND_SMS_API_KEY = process.env.SECOND_SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Provider Endpoints
const LOGSDOMAIN_BASE_URL = 'https://logsdomain.com/api/v1';
const ALLSMSVERIFY_BASE_URL = 'https://allsmsverify.com/stubs/handler_api.php';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// ------------------- PERSISTENT BALANCE STORAGE -------------------
const DB_FILE = path.join(__dirname, 'users.json');
let userSessions = {};

function loadSessions() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const rawData = fs.readFileSync(DB_FILE, 'utf8');
      userSessions = JSON.parse(rawData);
      console.log(`Loaded ${Object.keys(userSessions).length} user sessions from storage.`);
    } else {
      userSessions = {};
    }
  } catch (err) {
    console.error("Error reading users.json database:", err.message);
    userSessions = {};
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(userSessions, null, 2), 'utf8');
  } catch (err) {
    console.error("Error saving users.json database:", err.message);
  }
}

loadSessions();

function getUserSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { balance: 0, state: 'AWAITING_COUNTRY' };
    saveSessions();
  }
  return userSessions[userId];
}

// Custom HTTPS Agent to prevent dropouts
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const robustAxiosConfig = {
  timeout: 15000,
  httpsAgent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
  const serviceKey = String(serviceName).toLowerCase();
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
    console.error("Paystack Initialization Error:", err.response?.data || err.message);
    return { status: false, message: "Could not create payment link." };
  }
}

// ------------------- API PROVIDERS INTEGRATION -------------------
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
    return [];
  }
}

async function getAllSmsVerifyServices(countryShortCode, countryName) {
  const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : null;
  if (!cleanApiKey) return [];

  try {
    const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: { action: 'getServices', api_key: cleanApiKey, country: 1 }
    });

    const data = res.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([key, item]) => {
        if (typeof item === 'object') {
          return {
            service_id: key,
            service_name: item.name || item.title || key,
            stock: item.count || item.stock || 10,
            price: item.cost || item.price || 0,
            server_id: '1'
          };
        }
        return null;
      }).filter(Boolean);
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];

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

  const allSmsData = await getAllSmsVerifyServices(country.short, country.name);
  if (Array.isArray(allSmsData)) {
    allSmsData.forEach(s => {
      const serviceName = s.service_name || s.name || '';
      const stock = s.stock || 0;
      if (stock > 0) {
        results.push({
          provider: 'allsmsverify',
          service_id: s.service_id || serviceName,
          service_name: serviceName,
          operator_id: s.server_id || '1',
          server_name: s.server_name || 'Server (AllSMS)',
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

// ------------------- GEMINI AI WITH BUSINESS KNOWLEDGE -------------------
async function handleAIResponse(userMessage, session) {
  if (!ai) return null;
  try {
    const prompt = `You are Elsa, the official AI customer support assistant for "MJ SMS" (a Telegram bot that sells virtual phone numbers for receiving SMS verification codes like WhatsApp, Telegram, Facebook, etc.).

=== MJ SMS BUSINESS DESCRIPTION & SYSTEM RULES ===
1. SERVICES:
   - We sell virtual numbers across multiple countries (USA, UK, Nigeria, etc.) for app verifications.
   - Prices vary depending on the country and app requested.

2. WALLET & BALANCES:
   - Users top up their balance using Paystack (/fund).
   - Once Paystack confirms payment, funds are automatically credited to their wallet balance.
   - Current System Record for this user's balance: ₦${session.balance || 0}.

3. REFUNDS & TIMEOUTS:
   - If a number is generated but no SMS code arrives within 10 minutes, the order cancels automatically.
   - The user is NOT charged if no SMS code arrives.

4. USER COMPLAINT RULES (STRICT):
   - If the user asks why their balance changed, dropped, or complains about missing funds:
     * Speak politely and calmly in warm, friendly Nigerian English or light Pidgin.
     * Tell them directly what their recorded balance is right now (₦${session.balance || 0}).
     * Reassure them that if there was any discrepancy or payment delay, customer care will manually audit their Paystack transaction and credit them immediately.
     * Direct them to tap the WhatsApp Support button below to send their payment proof/receipt to support.
   - Do NOT give generic automated standard menu responses.
   - Directly answer their specific concern in 2 to 3 concise, friendly sentences.

USER MESSAGE: "${userMessage}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return response.text;
  } catch (err) {
    console.error("Gemini AI Processing Error:", err.message);
    return null;
  }
}

// ------------------- PURCHASE LOGIC -------------------
async function executePurchase(provider, countryId, countryShort, serviceId, operatorId) {
  if (provider === 'a' || provider === 'allsmsverify') {
    try {
      const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
      const serverId = operatorId || '1';

      const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
        ...robustAxiosConfig,
        params: { action: 'getNumber', api_key: cleanApiKey, service: serviceId, country: serverId }
      });

      const respText = String(res.data).trim();
      if (respText.startsWith('ACCESS_NUMBER')) {
        const parts = respText.split(':');
        return { success: true, data: { order_id: parts[1], number: parts[2] } };
      }
      return { success: false, message: respText || 'Server stock unavailable.' };
    } catch (err) {
      return { success: false, message: 'Request failed.' };
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
      return err.response?.data || { success: false, message: 'Purchase failed.' };
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

// ------------------- BOT COMMANDS -------------------
bot.start((ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  session.state = 'AWAITING_COUNTRY';
  saveSessions();

  ctx.reply(
    `How far boss! 👋 My name is *Elsa*. Welcome to *MJ SMS*! ✨\n\n` +
    `💰 *Your Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
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

bot.command(['support', 'help', 'customercare'], (ctx) => sendCustomerSupportMessage(ctx));

function sendCustomerSupportMessage(ctx) {
  ctx.reply(
    `💬 *MJ SMS CUSTOMER CARE*\n\n` +
    `Need help with an order, wallet funding, or balance issues?\n` +
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

  // 1. Direct Support Keywords
  if (['support', 'customer care', 'speak to support', 'admin', 'contact'].some(k => lowerText.includes(k))) {
    sendCustomerSupportMessage(ctx);
    return;
  }

  // 2. Fund/Deposit Direct Commands
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

  // 3. Fund with inline amount ("fund 1000")
  const fundMatch = lowerText.match(/^(?:fund|deposit|topup)\s+(\d+)$/i);
  if (fundMatch) {
    const amount = parseInt(fundMatch[1]);
    if (amount < 100) {
      ctx.reply("Minimum deposit amount is ₦100.");
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

  // 4. Deposit Amount Pending Input
  if (session.state === 'AWAITING_DEPOSIT_AMOUNT') {
    const amount = parseInt(rawText.replace(/[^0-9]/g, ''));
    if (isNaN(amount) || amount < 100) {
      ctx.reply(`Please enter a valid amount (minimum ₦100). E.g. *1000*`);
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

  // 5. Check if text matches Country or Combined Order (e.g. "USA WhatsApp", "United States")
  const countries = await getCountries();

  // 5A. Combined Input Handling ("USA WhatsApp")
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

  // 5B. Single Country Input ("United States", "Nigeria")
  const matchedCountryDirect = countries.find(c => 
    c.name.toLowerCase() === lowerText || 
    c.short.toLowerCase() === lowerText ||
    (lowerText === 'usa' && c.short.toLowerCase() === 'us') ||
    (lowerText === 'uk' && c.short.toLowerCase() === 'gb')
  );

  if (matchedCountryDirect) {
    session.country = matchedCountryDirect;
    session.state = 'AWAITING_SERVICE';
    saveSessions();
    ctx.reply(
      `Ehen! You select *${matchedCountryDirect.name}* 👌\n\n` +
      `Which app or service you wan verify? (e.g. _WhatsApp_, _Telegram_, _Facebook_)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 5C. Service Query when state is AWAITING_SERVICE
  if (session.state === 'AWAITING_SERVICE' && session.country) {
    const knownApps = ['whatsapp', 'telegram', 'facebook', 'bamboo', 'instagram', 'tiktok', 'twitter', 'x', 'google', 'gmail'];
    if (knownApps.some(app => lowerText.includes(app)) || rawText.length < 20) {
      ctx.reply(`Oya wait make Elsa check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, rawText);
      return;
    }
  }

  // 6. ROUTE TO AI FOR COMPLAINTS, BALANCE QUESTIONS, AND CHATTER ONLY
  const isComplaintOrQuestion = ['balance', 'change', 'why', 'previous', 'deduct', 'error', 'wrong', 'issue', 'missing', 'money', 'help'].some(k => lowerText.includes(k));

  if (isComplaintOrQuestion || lowerText.includes('?')) {
    const aiResponseText = await handleAIResponse(rawText, session);
    if (aiResponseText) {
      ctx.reply(aiResponseText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💬 Chat Customer Care on WhatsApp', 'https://wa.me/qr/XM6ORO7UCYTXI1')]
        ])
      });
      return;
    }
  }

  // Fallback default
  ctx.reply(`Please state which country virtual number you need (e.g., _United States_, _Nigeria_).`, { parse_mode: 'Markdown' });
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
    `Ehen boss! For *${serviceQuery}* (${session.country.name}), see the available options below:\n\n` +
    `Tap option below to buy:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ------------------- BUTTON HANDLERS -------------------
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
      `👉 Copy the number above into your app.\n` +
      `⏳ Elsa is waiting for your SMS code...`,
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
          `Thank you for using *MJ SMS*! ✨`,
          { parse_mode: 'Markdown' }
        );
      } else if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        await cancelOrder(provider, orderId);
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order canceled!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Server out of stock.'}`);
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
      } catch (err) {
        console.error("Paystack notification error:", err.message);
      }
    }
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('MJ SMS Bot (Elsa) Active!'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (SERVER_URL) {
    try {
      await bot.telegram.setWebhook(`${SERVER_URL}${TELEGRAM_WEBHOOK_PATH}`);
      console.log(`Webhook updated: ${SERVER_URL}${TELEGRAM_WEBHOOK_PATH}`);
    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  }
});
