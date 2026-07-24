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
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// JuicySMS API Base URL
const JUICYSMS_BASE_URL = 'https://juicysms.com/api';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------- PERSISTENT STORAGE -------------------
const DB_FILE = path.join(__dirname, 'users.json');
let userSessions = {};

function loadSessions() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const rawData = fs.readFileSync(DB_FILE, 'utf8');
      userSessions = JSON.parse(rawData);
    } else {
      userSessions = {};
    }
  } catch (err) {
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
    userSessions[userId] = { balance: 0, state: 'AWAITING_COUNTRY' };
    saveSessions();
  }
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
function calculateFinalPrice(rawUsdPrice) {
  const baseCostNgn = rawUsdPrice * USD_TO_NGN_RATE;
  
  // If base cost in NGN is below 3,500, add a flat 3,000 profit margin
  if (baseCostNgn < 3500) {
    return Math.ceil(baseCostNgn + 3000);
  } 
  // If base cost is 3,500 or above, apply a 100% markup (double the base cost)
  else {
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

// ------------------- JUICYSMS API INTEGRATION -------------------
const JUICYSMS_COUNTRIES = [
  { id: 'NL', name: 'Netherlands (NL)', short: 'nl' },
  { id: 'UK', name: 'United Kingdom (UK)', short: 'uk' },
  { id: 'USA', name: 'United States (USA)', short: 'usa' },
  { id: 'DE', name: 'Germany (DE)', short: 'de' }
];

async function getJuicySmsCountries() {
  return JUICYSMS_COUNTRIES;
}

async function getJuicySmsServices(countryId) {
  try {
    const params = { country: countryId || 'NL' };
    if (JUICYSMS_API_KEY) {
      params.key = JUICYSMS_API_KEY.trim();
    }

    const res = await axios.get(`${JUICYSMS_BASE_URL}/services`, {
      ...robustAxiosConfig,
      params: params
    });

    let data = res.data;
    if (data && data.services) data = data.services;

    if (Array.isArray(data)) {
      return data.map(item => {
        const rawPrice = parseFloat(item.price || item.cost || 0);
        return {
          service_id: item.id || item.serviceId || item.code || '',
          service_name: item.title || item.name || item.service_id || '',
          stock: parseInt(item.count || item.stock || item.quantity || 10, 10),
          price: rawPrice,
          server_id: countryId
        };
      }).filter(s => s.service_id);
    }
    return [];
  } catch (err) {
    console.error("Error fetching JuicySMS services:", err.message);
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];
  const juicyData = await getJuicySmsServices(country.id);
  
  if (Array.isArray(juicyData)) {
    juicyData.forEach(s => {
      results.push({
        provider: 'juicysms',
        service_id: s.service_id,
        service_name: s.service_name,
        operator_id: country.id,
        server_name: country.name,
        stock: s.stock || 10,
        price: parseFloat(s.price || 0)
      });
    });
  }
  return results;
}

async function executeJuicyPurchase(serviceId, countryId) {
  try {
    const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
    const res = await axios.get(`${JUICYSMS_BASE_URL}/makeorder`, {
      ...robustAxiosConfig,
      params: { key: cleanApiKey, serviceId: serviceId, country: countryId }
    });

    const respText = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
    
    if (respText.startsWith('ORDER_ID_')) {
      const parts = respText.split('_');
      const orderId = parts[2];
      const phoneNumber = parts.slice(4).join('_');
      return { success: true, data: { order_id: orderId, number: phoneNumber } };
    }
    return { success: false, message: respText || 'Server stock unavailable or insufficient balance.' };
  } catch (err) {
    return { success: false, message: 'Request failed.' };
  }
}

async function checkJuicySmsCode(orderId) {
  try {
    const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
    const res = await axios.get(`${JUICYSMS_BASE_URL}/getsms`, {
      ...robustAxiosConfig,
      params: { key: cleanApiKey, orderId: orderId }
    });
    
    const respText = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);

    if (respText.startsWith('SUCCESS_')) {
      const code = respText.replace('SUCCESS_', '');
      return { success: true, data: { code: code } };
    }
    return { success: false };
  } catch (err) {
    return { success: false };
  }
}

async function cancelJuicyOrder(orderId) {
  try {
    const cleanApiKey = JUICYSMS_API_KEY ? JUICYSMS_API_KEY.trim() : '';
    await axios.get(`${JUICYSMS_BASE_URL}/cancelorder`, {
      ...robustAxiosConfig,
      params: { key: cleanApiKey, orderId: orderId }
    });
  } catch (err) {
    console.error("Cancel order error:", err.message);
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
    `• Type a country code (e.g., _NL_, _UK_, _USA_, _DE_)\n` +
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

  if (['support', 'customer care', 'speak to support', 'admin', 'contact', 'i want to speak with support'].some(k => lowerText.includes(k))) {
    sendCustomerSupportMessage(ctx);
    return;
  }

  if (lowerText.includes('balance') || lowerText.includes('bal') || lowerText === 'my balance' || lowerText === "what's my balance" || lowerText === "what's my current balance") {
    ctx.reply(`Boss your current balance na ₦${(session.balance || 0).toLocaleString()} ✨`, { parse_mode: 'Markdown' });
    return;
  }

  if (['fund', 'deposit', 'wallet', 'topup', 'top up', 'i want to fund my wallet', 'fund my account', 'fund account', 'i wan fund my account'].some(k => lowerText.includes(k))) {
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
    ctx.reply(`No p boss! Which country you wan check now? (Type *NL*, *UK*, *USA*, or *DE*)`, { parse_mode: 'Markdown' });
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

  const countries = await getJuicySmsCountries();

  const getNormalizedCountry = (input) => {
    const cleanInput = input.toLowerCase().trim();
    return countries.find(c => {
      const cName = String(c.name).toLowerCase();
      const cId = String(c.id).toLowerCase();
      const cShort = String(c.short || '').toLowerCase();

      return cName === cleanInput || 
             cName.includes(cleanInput) || 
             cleanInput.includes(cName) || 
             cId === cleanInput || 
             cShort === cleanInput ||
             (cleanInput.includes('usa') && cId === 'USA') ||
             (cleanInput.includes('uk') && cId === 'UK') ||
             (cleanInput.includes('nl') && cId === 'NL') ||
             (cleanInput.includes('de') && cId === 'DE');
    });
  };

  if (countries.length > 0) {
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

  ctx.reply(`Please state your country code first (e.g., type *NL* or *NL WhatsApp*).`, { parse_mode: 'Markdown' });
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
    const finalPrice = calculateFinalPrice(srv.price);
    const cbData = `buy|${session.country.id}|${srv.service_id}`;
    return [Markup.button.callback(`🖥️ ${srv.server_name} (${srv.stock} left) — ₦${finalPrice.toLocaleString()}`, cbData)];
  });

  buttons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Ehen boss! See available options for *${serviceQuery}*:\n\nTap option below to buy:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ------------------- BUTTON HANDLERS -------------------
bot.action(/^buy\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  const session = getUserSession(userId);
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];

  const availableServers = await fetchCombinedServices({ id: countryId, name: countryId });
  const targetService = availableServers.find(s => String(s.service_id) === String(serviceId));
  
  const calculatedNgnPrice = targetService ? calculateFinalPrice(targetService.price) : 0;

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

  const response = await executeJuicyPurchase(serviceId, countryId);

  if (response.success && response.data) {
    if (calculatedNgnPrice > 0) {
      session.balance = Math.max(0, session.balance - calculatedNgnPrice);
      saveSessions();
    }

    const orderId = response.data.order_id;
    const phoneNumber = response.data.number;

    ctx.reply(
      `🎉 *NUMBER PURCHASED SUCCESSFULLY!*\n\n` +
      `📞 *Phone Number:* \`${phoneNumber}\`\n` +
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
      const checkRes = await checkJuicySmsCode(orderId);

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
        await cancelJuicyOrder(orderId);
        if (calculatedNgnPrice > 0) {
          session.balance += calculatedNgnPrice;
          saveSessions();
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
  ctx.reply(`No p boss! Which country you wan check now? (Type *NL*, *UK*, *USA*, or *DE*)`);
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
