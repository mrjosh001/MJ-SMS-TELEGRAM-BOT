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

// User sessions memory store to maintain Pidgin chat context
const userSessions = {};

// Axios instance configured for logsdomain.com API
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${SMS_API_KEY}`
  }
});

// ------------------- DYNAMIC PROFIT MARGIN CONFIG -------------------

// Default margin for general services (1.4 = 40% markup)
const DEFAULT_MARGIN = 1.4;

// Custom high-demand pricing rules (Minimum price floor & multiplier)
const SERVICE_PRICING_RULES = {
  'whatsapp': {
    minPrice: 6000,    // Sell WhatsApp for at least ₦6,000
    multiplier: 1.8    // 80% markup if base cost is high
  },
  'telegram': {
    minPrice: 3500,
    multiplier: 1.6
  },
  'facebook': {
    minPrice: 2000,
    multiplier: 1.5
  },
  'bamboo': {
    minPrice: 4000,
    multiplier: 1.7
  }
};

// Calculates final retail price in NGN
function calculateRetailPrice(serviceName, providerPriceNgn) {
  const serviceKey = (serviceName || '').toLowerCase();
  const rule = SERVICE_PRICING_RULES[serviceKey];

  let calculatedPrice = providerPriceNgn * DEFAULT_MARGIN;
  let minPrice = 0;

  if (rule) {
    calculatedPrice = providerPriceNgn * (rule.multiplier || DEFAULT_MARGIN);
    minPrice = rule.minPrice || 0;
  }

  const finalPrice = Math.max(calculatedPrice, minPrice);
  return Math.ceil(finalPrice);
}

// ------------------- API INTEGRATION FUNCTIONS -------------------

// 1. Fetch available countries
async function getCountries() {
  try {
    const res = await api.get('/numbers/countries');
    return res.data && res.data.success ? res.data.data : [];
  } catch (err) {
    console.error("Error fetching countries:", err.response?.data || err.message);
    return [];
  }
}

// 2. Fetch available services for a country
async function getServices(countryId) {
  try {
    const res = await api.get(`/numbers/services?country_id=${countryId}`);
    return res.data && res.data.success ? res.data.data : [];
  } catch (err) {
    console.error("Error fetching services:", err.response?.data || err.message);
    return [];
  }
}

// 3. Purchase a number order
async function purchaseNumber(countryId, serviceId) {
  try {
    const idempotencyKey = `mj-order-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const res = await api.post('/numbers/orders', {
      country_id: parseInt(countryId),
      service_id: parseInt(serviceId),
      idempotency_key: idempotencyKey
    });
    return res.data;
  } catch (err) {
    console.error("Error purchasing number:", err.response?.data || err.message);
    return err.response?.data || { success: false, message: 'Purchase failed.' };
  }
}

// 4. Check for received SMS OTP code
async function checkSmsCode(orderId) {
  try {
    const res = await api.post(`/numbers/orders/${orderId}/check`);
    return res.data;
  } catch (err) {
    console.error("Error checking code:", err.response?.data || err.message);
    return { success: false };
  }
}

// 5. Cancel order
async function cancelOrder(orderId) {
  try {
    const res = await api.post(`/numbers/orders/${orderId}/cancel`);
    return res.data;
  } catch (err) {
    console.error("Error cancelling order:", err.response?.data || err.message);
    return { success: false };
  }
}

// ------------------- TELEGRAM CONVERSATIONAL FLOW -------------------

// /start command
bot.start((ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'AWAITING_COUNTRY' };

  ctx.reply(
    `How far boss! 👋 My name na MJ, welcome to *MJ SMS*.\n\n` +
    `I dey here to help you get virtual numbers for any app or country fast fast! 🚀\n\n` +
    `Which country number you dey look for today? (e.g. _United States_, _Nigeria_, _United Kingdom_, _Sudan_)`,
    { parse_mode: 'Markdown' }
  );
});

// Main conversational message handler in Pidgin with smart one-liner support
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (!userSessions[userId]) {
    userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  }

  const session = userSessions[userId];

  // Friendly greetings
  if (['hi', 'hello', 'hey', 'awfa', 'howfar', 'how far', 'xup'].some(g => lowerText.includes(g))) {
    ctx.reply(`How far my boss! 😊\nWhich country virtual number you wan buy today? Just drop the country name for me.`);
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  // ⚡ SMART ONE-LINER CHECK (e.g. "USA WhatsApp", "Nigeria Telegram", "Sudan Facebook")
  const countries = await getCountries();
  if (countries.length > 0) {
    const words = lowerText.split(/\s+/);
    
    // Check if user provided both a country AND a service in one message
    let matchedCountry = null;
    let matchedServiceQuery = null;

    // Find country in words
    for (const word of words) {
      const foundCountry = countries.find(c => 
        c.name.toLowerCase() === word || 
        c.short.toLowerCase() === word ||
        (word === 'usa' && c.short.toLowerCase() === 'us') ||
        (word === 'uk' && c.short.toLowerCase() === 'gb')
      );

      if (foundCountry) {
        matchedCountry = foundCountry;
        // Remaining words form the service query
        matchedServiceQuery = words.filter(w => w !== word).join(' ');
        break;
      }
    }

    // If both Country and Service were typed together in one sentence
    if (matchedCountry && matchedServiceQuery) {
      session.country = matchedCountry;
      session.state = 'AWAITING_SERVICE';
      
      ctx.reply(`Oya wait make I check live price and stock for *${matchedServiceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, matchedServiceQuery);
      return;
    }
  }

  // STEP 1: Process Country Selection
  if (session.state === 'AWAITING_COUNTRY' || session.state === 'IDLE') {
    ctx.reply(`Hold on boss, make I check available countries... 🔎`);

    if (!countries || !countries.length) {
      ctx.reply(`Eya! Network issue dey to fetch countries right now. Try typing the country name again.`);
      return;
    }

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
        `Which app or service you wan verify with this number? (e.g. _WhatsApp_, _Telegram_, _Facebook_, _Bamboo_)`,
        { parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(
        `I no find "*${rawText}*" for list of available countries boss. 😅\n\n` +
        `Try type popular countries like _United States_, _United Kingdom_, _Nigeria_, _Canada_, or _Sudan_!`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // STEP 2: Process Service Selection
  if (session.state === 'AWAITING_SERVICE') {
    // Check if user is trying to switch country instead while in service state
    const newCountryMatch = (await getCountries()).find(c => 
      c.name.toLowerCase() === lowerText || 
      c.short.toLowerCase() === lowerText ||
      (lowerText === 'usa' && c.short.toLowerCase() === 'us')
    );

    if (newCountryMatch) {
      session.country = newCountryMatch;
      ctx.reply(
        `Switched country to *${newCountryMatch.name}* 👌\n\nWhich app or service you wan verify?`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    ctx.reply(`Oya wait make I check live price and stock for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
  }
});

// Helper function to query services and display available stock/pricing
async function processServiceSelection(ctx, session, serviceQuery) {
  const lowerQuery = serviceQuery.toLowerCase();
  const services = await getServices(session.country.id);

  if (!services.length) {
    ctx.reply(`No services found for *${session.country.name}* right now. Try typing another country!`, { parse_mode: 'Markdown' });
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  const matchedService = services.find(s => 
    s.service_name.toLowerCase().includes(lowerQuery)
  );

  if (matchedService) {
    if (matchedService.available_quantity < 1) {
      ctx.reply(`Eya! Stock for *${matchedService.service_name}* (${session.country.name}) don finish for market! 💔\nTry type another app name or country.`, { parse_mode: 'Markdown' });
      return;
    }

    const rawProviderPrice = parseFloat(matchedService.price);
    const finalRetailPrice = calculateRetailPrice(matchedService.service_name, rawProviderPrice);

    session.selectedService = matchedService;
    session.finalPrice = finalRetailPrice;

    const actionButtons = Markup.inlineKeyboard([
      [Markup.button.callback(`💳 Buy Number (₦${finalRetailPrice})`, `buy_${session.country.id}_${matchedService.service_id}`)],
      [Markup.button.callback('🔄 Choose Another Country', 'reset_flow')]
    ]);

    ctx.reply(
      `Omo sharp! Line dey available! 🔥\n\n` +
      `📌 *Country:* ${session.country.name}\n` +
      `📌 *App:* ${matchedService.service_name}\n` +
      `📊 *Success Rate:* ${matchedService.success_rate}%\n` +
      `📦 *In Stock:* ${matchedService.available_quantity} numbers\n` +
      `💰 *Price:* ₦${finalRetailPrice}\n\n` +
      `Tap button below to buy this number now:`,
      { parse_mode: 'Markdown', ...actionButtons }
    );
  } else {
    ctx.reply(`I no see *${serviceQuery}* under ${session.country.name}. Try typing another app name like _WhatsApp_, _Telegram_, or _Facebook_.`);
  }
}

// ------------------- BUTTON ACTIONS & ORDER PROCESSING -------------------

bot.action(/^buy_(\d+)_(\d+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const response = await purchaseNumber(countryId, serviceId);

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
      `⏳ I dey wait for your SMS verification code now... (I go send am here automatically as e enter)`,
      { parse_mode: 'Markdown' }
    );

    // Poll for SMS verification code (Every 7 seconds up to 10 minutes)
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
          `Thank you for using *MJ SMS*! 🚀`,
          { parse_mode: 'Markdown' }
        );
      } else if (pollCount >= maxPolls) {
        clearInterval(intervalId);
        await cancelOrder(orderId);
        ctx.reply(`⏰ *Time Out:* Code no enter after 10 minutes. Order don cancel & money don refund to your wallet!`);
      }
    }, 7000);

  } else {
    ctx.reply(`❌ *Purchase Failed:* ${response.message || 'Insufficient wallet balance on provider or line out of stock.'}`);
  }
});

bot.action('reset_flow', (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  ctx.reply(`No p boss! Which country number you wan check now?`);
});

// ------------------- SERVER WEBHOOK SETUP -------------------

const WEBHOOK_PATH = `/webhook/telegram`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get('/', (req, res) => res.send('MJ SMS Bot is Active!'));

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
