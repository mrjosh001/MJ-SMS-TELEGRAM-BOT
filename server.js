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
const SMS_API_KEY = process.env.SMS_API_KEY;
const SECOND_SMS_API_KEY = process.env.SECOND_SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Provider Endpoints
const LOGSDOMAIN_BASE_URL = 'https://logsdomain.com/api/v1';
const ALLSMSVERIFY_BASE_URL = 'https://allsmsverify.com/stubs/handler_api.php';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN environment variable is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------- PERSISTENT BALANCE STORAGE -------------------
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

const DEFAULT_MARGIN = 1.4;

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

// ------------------- ALLSMSVERIFY API INTEGRATION (UPDATED) -------------------
async function getAllSmsVerifyCountries() {
  const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : null;
  if (!cleanApiKey) return [];

  try {
    const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: { action: 'getCountries', api_key: cleanApiKey }
    });

    const data = res.data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data)) return data;
      return Object.entries(data).map(([key, item]) => ({
        id: key,
        name: item.name || item.title || key,
        short: key
      }));
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function getAllSmsVerifyServices(countryId) {
  const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : null;
  if (!cleanApiKey) return [];

  try {
    const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: { action: 'getServices', api_key: cleanApiKey, country: countryId || 1 }
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
            server_id: countryId || '1'
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
  const allSmsData = await getAllSmsVerifyServices(country.id);
  
  if (Array.isArray(allSmsData)) {
    allSmsData.forEach(s => {
      const serviceName = s.service_name || s.name || '';
      const stock = s.stock || 0;
      if (stock > 0) {
        results.push({
          provider: 'allsmsverify',
          service_id: s.service_id || serviceName,
          service_name: serviceName,
          operator_id: country.id,
          server_name: country.name || 'Server',
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
  return sName === q || sName.includes(q) || q.includes(sName);
}

// ------------------- PURCHASE & STATUS LOGIC (ALLSMSVERIFY) -------------------
async function executePurchase(serviceId, countryId) {
  try {
    const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
    const res = await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: { action: 'getNumber', api_key: cleanApiKey, service: serviceId, country: countryId || 1 }
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
}

async function checkSmsCode(orderId) {
  try {
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
  } catch (err) {
    return { success: false };
  }
}

async function cancelOrder(orderId) {
  try {
    const cleanApiKey = SECOND_SMS_API_KEY ? SECOND_SMS_API_KEY.trim() : '';
    await axios.get(ALLSMSVERIFY_BASE_URL, {
      ...robustAxiosConfig,
      params: { action: 'setStatus', api_key: cleanApiKey, id: orderId, status: 8 }
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
  saveSessions();

  ctx.reply(
    `How far boss! 👋 Welcome to *MJ SMS*! ✨\n\n` +
    `💰 *Your Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
    `I dey here to help you get virtual numbers fast fast! 🚀\n` +
    `• Type a country name or server ID\n` +
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

  if (['support', 'customer care', 'speak to support', 'admin', 'contact'].some(k => lowerText.includes(k))) {
    sendCustomerSupportMessage(ctx);
    return;
  }

  if (['fund', 'deposit', 'topup', 'top up'].includes(lowerText)) {
    session.state = 'AWAITING_DEPOSIT_AMOUNT';
    saveSessions();
    ctx.reply(
      `💳 *MJ SMS WALLET TOP-UP*\n\n` +
      `💰 *Current Balance:* ₦${(session.balance || 0).toLocaleString()}\n\n` +
      `Enter the amount you want to deposit in Naira:`,
      { parse_mode: 'Markdown' }
    );
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

  const countries = await getAllSmsVerifyCountries();

  const matchedCountry = countries.find(c => 
    String(c.name).toLowerCase() === lowerText || 
    String(c.id).toLowerCase() === lowerText
  );

  if (matchedCountry) {
    session.country = matchedCountry;
    session.state = 'AWAITING_SERVICE';
    saveSessions();
    ctx.reply(
      `Ehen! You select *${matchedCountry.name}* 👌\n\n` +
      `Which app or service you wan verify? (e.g., _whatsapp_, _telegram_)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (session.state === 'AWAITING_SERVICE' && session.country) {
    ctx.reply(`Oya wait make we check servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
    return;
  }

  ctx.reply(`Please state your country server name or ID first (e.g., type a country name).`, { parse_mode: 'Markdown' });
});

async function processServiceSelection(ctx, session, serviceQuery) {
  const availableServers = await fetchCombinedServices(session.country);
  const filtered = availableServers.filter(s => matchesServiceQuery(s.service_name, serviceQuery));

  if (filtered.length === 0) {
    ctx.reply(`Eya! Stock for *${serviceQuery}* don finish! 💔\nTry another app or country.`, { parse_mode: 'Markdown' });
    return;
  }

  const buttons = filtered.map((srv) => {
    const finalPrice = Math.ceil(srv.price * DEFAULT_MARGIN);
    const cbData = `buy|${session.country.id}|${srv.service_id}`;
    return [Markup.button.callback(`🖥️ ${srv.server_name} (${srv.stock} left) — ₦${finalPrice}`, cbData)];
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
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const userId = ctx.from.id;

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const response = await executePurchase(serviceId, countryId);

  if (response.success && response.data) {
    const orderId = response.data.order_id;
    const phoneNumber = response.data.number;

    ctx.reply(
      `🎉 *NUMBER PURCHASED SUCCESSFULLY!*\n\n` +
      `📞 *Phone Number:* \`${phoneNumber}\`\n\n` +
      `👉 Copy the number above into your app.\n` +
      `⏳ Waiting for your SMS code...`,
      { parse_mode: 'Markdown' }
    );

    let pollCount = 0;
    const maxPolls = 80;

    const intervalId = setInterval(async () => {
      pollCount++;
      const checkRes = await checkSmsCode(orderId);

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
        await cancelOrder(orderId);
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
