const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const app = express();
app.use(express.json());

// Environment variables provided by Render
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;

const BASE_URL = 'https://logsdomain.com/api/v1';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const userSessions = {};

// Axios instance pre-configured for logsdomain.com API
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${SMS_API_KEY}`
  }
});

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

// ------------------- API INTEGRATION FUNCTIONS -------------------

async function getCountries() {
  try {
    const res = await api.get('/numbers/countries');
    return res.data.success ? res.data.data : [];
  } catch (err) {
    console.error("Error fetching countries:", err.response?.data || err.message);
    return [];
  }
}

// Updated getServices: logs raw provider response and handles array/object data shapes
async function getServices(countryId) {
  try {
    const res = await api.get(`/numbers/services?country_id=${countryId}`);
    
    // 🔍 THIS WILL PRINT THE EXACT API RESPONSE IN RENDER LOGS
    console.log("LOGSDOMAIN SERVICES RAW RESPONSE:", JSON.stringify(res.data, null, 2));

    if (!res.data || !res.data.data) {
      return [];
    }

    // Handle array or object return formats
    const servicesData = Array.isArray(res.data.data) 
      ? res.data.data 
      : Object.values(res.data.data);

    return servicesData;
  } catch (err) {
    console.error("Error fetching services:", err.response?.data || err.message);
    return [];
  }
}

async function purchaseNumber(countryId, serviceId, operatorId = null) {
  try {
    const idempotencyKey = `mj-order-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = {
      country_id: parseInt(countryId),
      service_id: parseInt(serviceId),
      idempotency_key: idempotencyKey
    };
    if (operatorId) payload.operator_id = operatorId;

    const res = await api.post('/numbers/orders', payload);
    return res.data;
  } catch (err) {
    console.error("Error purchasing number:", err.response?.data || err.message);
    return err.response?.data || { success: false, message: 'Purchase failed.' };
  }
}

async function checkSmsCode(orderId) {
  try {
    const res = await api.post(`/numbers/orders/${orderId}/check`);
    return res.data;
  } catch (err) {
    return { success: false };
  }
}

async function cancelOrder(orderId) {
  try {
    const res = await api.post(`/numbers/orders/${orderId}/cancel`);
    return res.data;
  } catch (err) {
    return { success: false };
  }
}

// ------------------- ELSA CONVERSATIONAL BOT FLOW -------------------

// Start command
bot.start((ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'AWAITING_COUNTRY' };

  ctx.reply(
    `How far boss! 👋 My name is *Elsa*. Welcome to *MJ SMS*! ✨\n` +
    `Have a happy day today! 😊\n\n` +
    `I dey here to help you get virtual numbers for any app or country fast fast! 🚀\n\n` +
    `Which country number you dey look for today? (e.g. _United States_, _Nigeria_, _United Kingdom_)`,
    { parse_mode: 'Markdown' }
  );
});

// Incoming text messages handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (!userSessions[userId]) userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  const session = userSessions[userId];

  // Friendly greetings
  if (['hi', 'hello', 'hey', 'awfa', 'howfar', 'how far', 'xup'].some(g => lowerText.includes(g))) {
    ctx.reply(
      `How far my boss! 😊 My name na *Elsa*, welcome to *MJ SMS*!\n` +
      `Have a happy day today! ✨\n\n` +
      `Which country virtual number you wan buy today? Just drop the country name for me.`
    );
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  const countries = await getCountries();

  // Smart Parsing: Detect combined input like "USA WhatsApp" or "Nigeria Telegram"
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
      ctx.reply(`Oya wait make I check available servers and price for *${matchedServiceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, matchedServiceQuery);
      return;
    }
  }

  // Step 1: Process Country Input
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

  // Step 2: Process Service Input
  if (session.state === 'AWAITING_SERVICE') {
    // Check if user typed a new country name instead
    const newCountryMatch = countries.find(c => 
      c.name.toLowerCase() === lowerText || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us')
    );

    if (newCountryMatch) {
      session.country = newCountryMatch;
      ctx.reply(`Switched country to *${newCountryMatch.name}* 👌\n\nWhich app or service you wan verify?`, { parse_mode: 'Markdown' });
      return;
    }

    ctx.reply(`Oya wait make I check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
  }
});

// Helper function to extract and render available Servers/Operators
async function processServiceSelection(ctx, session, serviceQuery) {
  const lowerQuery = serviceQuery.toLowerCase();
  const services = await getServices(session.country.id);

  if (!services.length) {
    ctx.reply(`No services found for *${session.country.name}* right now. Try another country!`, { parse_mode: 'Markdown' });
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  const matchedService = services.find(s => s.service_name.toLowerCase().includes(lowerQuery));

  if (!matchedService) {
    ctx.reply(`I no see *${serviceQuery}* under ${session.country.name}. Try typing another app like _WhatsApp_ or _Telegram_.`);
    return;
  }

  session.selectedService = matchedService;

  // Extract operators/servers array if returned by logsdomain API
  let serverList = [];
  if (matchedService.operators && Array.isArray(matchedService.operators) && matchedService.operators.length > 0) {
    serverList = matchedService.operators;
  } else {
    // Standard single server fallback
    serverList = [{
      id: 'default',
      name: matchedService.operator_name || 'Standard Server',
      available_quantity: matchedService.available_quantity || 0,
      price: matchedService.price
    }];
  }

  // Filter servers that have available stock
  const activeServers = serverList.filter(op => (op.available_quantity || op.count || 0) > 0);

  if (activeServers.length === 0) {
    ctx.reply(`Eya! Stock for *${matchedService.service_name}* (${session.country.name}) don finish across all servers! 💔\nTry another app or country.`, { parse_mode: 'Markdown' });
    return;
  }

  // Generate dynamic buttons for each server option
  const buttons = activeServers.map(srv => {
    const srvCost = parseFloat(srv.price || matchedService.price);
    const finalPrice = calculateRetailPrice(matchedService.service_name, srvCost);
    const stockCount = srv.available_quantity || srv.count || 0;
    const srvName = srv.name || srv.operator_name || 'Server';

    return [Markup.button.callback(`🖥️ ${srvName} (${stockCount} left) — ₦${finalPrice}`, `srv_${session.country.id}_${matchedService.service_id}_${srv.id}`)];
  });

  buttons.push([Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]);

  ctx.reply(
    `Ehen boss! For *${matchedService.service_name}* (${session.country.name}), see the available servers below:\n\n` +
    `Which server or route you wan use buy the number? Tap option below:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ------------------- SERVER BUTTON CALLBACK -------------------

bot.action(/^srv_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const operatorId = ctx.match[3] === 'default' ? null : ctx.match[3];

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const response = await purchaseNumber(countryId, serviceId, operatorId);

  if (response.success && response.data) {
    const order = response.data;
    const orderId = order.order_id;
    const phoneNumber = order.number;

    ctx.reply(
      `🎉 *NUMBER PURCHASED SUCCESSFULLY!*\n\n` +
      `📞 *Phone Number:* \`${phoneNumber}\`\n` +
      `📱 *Service:* ${order.service_name}\n` +
      `🌍 *Country:* ${order.country_name}\n\n` +
      `👉 Copy the number above and enter it into your app.\n` +
      `⏳ Elsa is waiting for your SMS code... (I go send am here automatically as e enter)`,
      { parse_mode: 'Markdown' }
    );

    // Poll for incoming SMS Code (up to 10 mins)
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
          `Thank you for using *MJ SMS*! Have a happy day! ✨`,
          { parse_mode: 'Markdown' }
        );
      } else if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        await cancelOrder(orderId);
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order don cancel & money don refund!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Server out of stock or insufficient balance.'}`);
  }
});

bot.action('reset_flow', (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  ctx.reply(`No p boss! Which country number you wan check now?`);
});

// ------------------- WEBHOOK & EXPRESS SERVER SETUP -------------------

const WEBHOOK_PATH = `/webhook/telegram`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get('/', (req, res) => res.send('MJ SMS Bot (Elsa) is Active!'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (SERVER_URL) {
    const fullWebhookUrl = `${SERVER_URL}${WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`Webhook auto-configured to: ${fullWebhookUrl}`);
    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  }
});
