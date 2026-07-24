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
const SECOND_SMS_API_KEY = process.env.SECOND_SMS_API_KEY;

const LOGSDOMAIN_BASE_URL = 'https://logsdomain.com/api/v1';
const ALLSMSVERIFY_BASE_URL = 'https://allsmsverify.com/api';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const userSessions = {};

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
  if (!SMS_API_KEY) return [];
  try {
    const res = await axios.get(`${LOGSDOMAIN_BASE_URL}/numbers/countries`, {
      headers: { 'Authorization': `Bearer ${SMS_API_KEY}`, 'Accept': 'application/json' }
    });
    return res.data?.success ? res.data.data : [];
  } catch (err) {
    console.error("Error fetching countries:", err.response?.data || err.message);
    return [];
  }
}

async function getLogsDomainServices(countryId) {
  if (!SMS_API_KEY) return [];
  try {
    const res = await axios.get(`${LOGSDOMAIN_BASE_URL}/numbers/services?country_id=${countryId}`, {
      headers: { 'Authorization': `Bearer ${SMS_API_KEY}`, 'Accept': 'application/json' }
    });
    if (!res.data || !res.data.data) return [];
    return Array.isArray(res.data.data) ? res.data.data : Object.values(res.data.data);
  } catch (err) {
    console.error("LogsDomain Services Error:", err.response?.data || err.message);
    return [];
  }
}

async function getAllSmsVerifyServices(countryShortCode) {
  if (!SECOND_SMS_API_KEY) return [];
  try {
    const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/services`, {
      params: { api_key: SECOND_SMS_API_KEY, country: countryShortCode },
      headers: { 'Accept': 'application/json' }
    });
    return res.data?.success ? res.data.data : (Array.isArray(res.data) ? res.data : []);
  } catch (err) {
    console.error("Allsmsverify Services Error:", err.response?.data || err.message);
    return [];
  }
}

async function fetchCombinedServices(country) {
  const results = [];

  // LogsDomain
  const logsData = await getLogsDomainServices(country.id);
  if (Array.isArray(logsData)) {
    logsData.forEach(s => {
      let ops = s.operators && s.operators.length ? s.operators : [{
        id: 'default',
        name: s.operator_name || 'Server 1 (Logs)',
        available_quantity: s.available_quantity || 0,
        price: s.price
      }];

      ops.forEach(op => {
        if ((op.available_quantity || op.count || 0) > 0) {
          results.push({
            provider: 'logsdomain',
            service_id: s.service_id,
            service_name: s.service_name,
            operator_id: op.id === 'default' ? null : op.id,
            server_name: op.name || 'Server 1',
            stock: op.available_quantity || op.count || 0,
            price: parseFloat(op.price || s.price || 0)
          });
        }
      });
    });
  }

  // Allsmsverify
  const allSmsData = await getAllSmsVerifyServices(country.short);
  if (Array.isArray(allSmsData)) {
    allSmsData.forEach(s => {
      const stock = s.stock || s.available_quantity || s.count || 0;
      if (stock > 0) {
        results.push({
          provider: 'allsmsverify',
          service_id: s.service_id || s.code || s.name,
          service_name: s.service_name || s.name,
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

// Order execution
async function executePurchase(provider, countryId, countryShort, serviceId, operatorId) {
  if (provider === 'a' || provider === 'allsmsverify') {
    try {
      const res = await axios.post(`${ALLSMSVERIFY_BASE_URL}/order`, {
        api_key: SECOND_SMS_API_KEY,
        country: countryShort,
        service: serviceId,
        operator: operatorId
      });
      return res.data;
    } catch (err) {
      return { success: false, message: err.response?.data?.message || 'Allsmsverify purchase failed.' };
    }
  } else {
    try {
      const payload = {
        country_id: parseInt(countryId),
        service_id: parseInt(serviceId),
        idempotency_key: `mj-order-${Date.now()}`
      };
      if (operatorId && operatorId !== '0') payload.operator_id = operatorId;

      const res = await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders`, payload, {
        headers: { 'Authorization': `Bearer ${SMS_API_KEY}` }
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
      const res = await axios.get(`${ALLSMSVERIFY_BASE_URL}/check`, {
        params: { api_key: SECOND_SMS_API_KEY, order_id: orderId }
      });
      return res.data;
    } else {
      const res = await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders/${orderId}/check`, {}, {
        headers: { 'Authorization': `Bearer ${SMS_API_KEY}` }
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
      await axios.post(`${ALLSMSVERIFY_BASE_URL}/cancel`, { api_key: SECOND_SMS_API_KEY, order_id: orderId });
    } else {
      await axios.post(`${LOGSDOMAIN_BASE_URL}/numbers/orders/${orderId}/cancel`, {}, {
        headers: { 'Authorization': `Bearer ${SMS_API_KEY}` }
      });
    }
  } catch (err) {
    console.error("Cancel order error:", err.message);
  }
}

// ------------------- ELSA CONVERSATIONAL BOT FLOW -------------------

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

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (!userSessions[userId]) userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  const session = userSessions[userId];

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
      ctx.reply(`Oya wait make Elsa check available servers for *${matchedServiceQuery}* (${matchedCountry.name})... 🔎`, { parse_mode: 'Markdown' });
      await processServiceSelection(ctx, session, matchedServiceQuery);
      return;
    }
  }

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

  if (session.state === 'AWAITING_SERVICE') {
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

    ctx.reply(`Oya wait make Elsa check available servers for *${rawText}* (${session.country.name})... 🔎`, { parse_mode: 'Markdown' });
    await processServiceSelection(ctx, session, rawText);
  }
});

async function processServiceSelection(ctx, session, serviceQuery) {
  const lowerQuery = serviceQuery.toLowerCase();
  const availableServers = await fetchCombinedServices(session.country);

  const filtered = availableServers.filter(s => s.service_name.toLowerCase().includes(lowerQuery));

  if (filtered.length === 0) {
    ctx.reply(`Eya! Stock for *${serviceQuery}* (${session.country.name}) don finish across all servers! 💔\nTry another app or country.`, { parse_mode: 'Markdown' });
    return;
  }

  const buttons = filtered.map((srv) => {
    const finalPrice = calculateRetailPrice(srv.service_name, srv.price);
    const pCode = srv.provider === 'allsmsverify' ? 'a' : 'l';
    const opCode = srv.operator_id || '0';
    
    // Short string format to keep callback data strictly under 64 bytes
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

// ------------------- SERVER BUTTON CALLBACK -------------------

bot.action(/^b\|(.+)\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  ctx.answerCbQuery();
  const pCode = ctx.match[1]; // 'a' or 'l'
  const countryId = ctx.match[2];
  const serviceId = ctx.match[3];
  const operatorId = ctx.match[4] === '0' ? null : ctx.match[4];

  const provider = pCode === 'a' ? 'allsmsverify' : 'logsdomain';

  ctx.reply(`Processing your number purchase... Please wait ⏳`);

  const countryShort = userSessions[ctx.from.id]?.country?.short || 'us';
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
