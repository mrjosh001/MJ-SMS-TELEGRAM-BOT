const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
const SMS_API_KEY = process.env.SMS_API_KEY || '';

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// User sessions to track natural conversation states
const userSessions = {};

// Dictionary for common country names
const COUNTRY_MAP = {
  'usa': 'United States 🇺🇸',
  'us': 'United States 🇺🇸',
  'united states': 'United States 🇺🇸',
  'uk': 'United Kingdom 🇬🇧',
  'england': 'United Kingdom 🇬🇧',
  'united kingdom': 'United Kingdom 🇬🇧',
  'canada': 'Canada 🇨🇦',
  'nigeria': 'Nigeria 🇳🇬',
  'australia': 'Australia 🇦🇺',
  'sudan': 'Sudan 🇸🇩',
  'germany': 'Germany 🇩🇪',
  'brazil': 'Brazil 🇧🇷',
  'ghana': 'Ghana 🇬🇭',
  'india': 'India 🇮🇳',
  'china': 'China 🇨🇳',
  'france': 'France 🇫🇷'
};

// Dictionary for common services
const SERVICE_MAP = {
  'whatsapp': 'WhatsApp',
  'telegram': 'Telegram',
  'facebook': 'Facebook',
  'bamboo': 'Bamboo',
  'tiktok': 'TikTok',
  'google': 'Google / Gmail',
  'gmail': 'Google / Gmail',
  'instagram': 'Instagram',
  'twitter': 'X (Twitter)',
  'x': 'X (Twitter)',
  'tinder': 'Tinder',
  'netflix': 'Netflix'
};

// Helper function to check virtual number status from provider
async function checkProviderStock(country, service) {
  // If no API key configured yet, return simulated success
  if (!SMS_API_KEY) {
    return { available: true, priceNgn: 1500, stock: 35 };
  }
  try {
    const res = await axios.get(`https://5sim.net/v1/guest/prices?country=${country}&product=${service}`);
    return { available: true, priceNgn: 1800, stock: 15 };
  } catch (err) {
    return { available: false };
  }
}

// 1. WELCOME COMMAND (/start)
bot.start((ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'IDLE' };

  ctx.reply(
    `How far boss! 👋 My name na MJ, welcome to *MJ SMS*.\n\n` +
    `I dey here to help you get virtual numbers for any app or country standard fast fast. 🚀\n\n` +
    `Tell me, which country number you dey look for today? (e.g. _USA_, _Sudan_, _UK_, _Nigeria_)`,
    { parse_mode: 'Markdown' }
  );
});

// 2. CONVERSATIONAL TEXT HANDLER
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const rawText = ctx.message.text.trim();
  const lowerText = rawText.toLowerCase();

  if (!userSessions[userId]) {
    userSessions[userId] = { state: 'IDLE' };
  }

  const session = userSessions[userId];

  // Greetings handler
  if (['hi', 'hello', 'hey', 'awfa', 'howfar', 'how far', 'xup'].some(g => lowerText.includes(g))) {
    ctx.reply(`How far my boss! 😊\nWhich country virtual number you wan buy today? Just drop the country name for me.`);
    session.state = 'AWAITING_COUNTRY';
    return;
  }

  // Quick One-Liner Check (e.g., "USA WhatsApp", "Sudan Facebook")
  const words = lowerText.split(/\s+/);
  let detectedCountry = null;
  let detectedService = null;

  for (const w of words) {
    if (COUNTRY_MAP[w]) detectedCountry = w;
    if (SERVICE_MAP[w]) detectedService = w;
  }

  if (detectedCountry && detectedService) {
    session.country = COUNTRY_MAP[detectedCountry];
    session.service = SERVICE_MAP[detectedService];
    await handleAvailabilityCheck(ctx, session);
    return;
  }

  // Conversation Flow State Machine
  switch (session.state) {

    case 'IDLE':
    case 'AWAITING_COUNTRY':
      const countryName = COUNTRY_MAP[lowerText] || rawText.toUpperCase();
      session.country = countryName;
      session.state = 'AWAITING_SERVICE';

      ctx.reply(
        `Ehen! You select *${countryName}* 👌\n\n` +
        `Which app or service you wan verify with this number? (e.g. _WhatsApp_, _Telegram_, _Bamboo_, _Facebook_)`,
        { parse_mode: 'Markdown' }
      );
      break;

    case 'AWAITING_SERVICE':
      const serviceName = SERVICE_MAP[lowerText] || rawText;
      session.service = serviceName;
      await handleAvailabilityCheck(ctx, session);
      break;

    default:
      ctx.reply(
        `I hear you boss! Drop the name of the country or service you wan verify, or say "start again" make we restart.`,
        { parse_mode: 'Markdown' }
      );
      break;
  }
});

// Helper: Perform the stock check & respond in Pidgin
async function handleAvailabilityCheck(ctx, session) {
  const userId = ctx.from.id;
  ctx.reply(`Oya wait make I quickly check stock for *${session.service}* (${session.country}) line... 🔎`, { parse_mode: 'Markdown' });

  const result = await checkProviderStock(session.country, session.service);

  if (result.available) {
    session.state = 'AWAITING_PAYMENT';
    session.price = result.priceNgn;

    const actionButtons = Markup.inlineKeyboard([
      [Markup.button.callback(`💳 Pay ₦${result.priceNgn} Now`, 'confirm_pay')],
      [Markup.button.callback('🔄 Choose Another Service', 'reset_flow')]
    ]);

    ctx.reply(
      `Omo sharp! Line dey fully available! 🔥\n\n` +
      `📌 *Country:* ${session.country}\n` +
      `📌 *App:* ${session.service}\n` +
      `💰 *Price:* ₦${result.priceNgn}\n\n` +
      `You wan make I process this number for you now?`,
      { parse_mode: 'Markdown', ...actionButtons }
    );
  } else {
    session.state = 'AWAITING_COUNTRY';
    ctx.reply(
      `Eya! Line for *${session.service}* (${session.country}) don finish for market currently. 💔\n\n` +
      `Which other country or app you go like try instead?`,
      { parse_mode: 'Markdown' }
    );
  }
}

// Inline button responses
bot.action('confirm_pay', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply(
    `No p! To complete this order, make sure say money dey your *MJ SMS Wallet*.\n\n` +
    `Tap /fund to top up your wallet or message support if you need help!`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('reset_flow', (ctx) => {
  ctx.answerCbQuery();
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'AWAITING_COUNTRY' };
  ctx.reply(`No wahala boss! Which country number you wan check now?`);
});

// Webhook & Server Express Listener
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
