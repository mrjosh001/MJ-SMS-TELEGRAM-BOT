const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;

if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- MAIN MENU KEYBOARD ---
const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📱 Buy Virtual Number', 'buy_number')],
  [Markup.button.callback('💳 Fund Wallet', 'fund_wallet'), Markup.button.callback('📜 My Orders', 'order_history')],
  [Markup.button.callback('📊 Check Balance', 'check_balance'), Markup.button.callback('❓ Help & Support', 'support')]
]);

// --- WELCOME COMMAND ---
bot.start((ctx) => {
  ctx.reply(
    `Welcome to *MJ SMS*! 🚀\n\nYour automated hub for instant virtual numbers and SMS verification codes.\n\nPlease choose an option below to get started:`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// --- MENU BUTTON ACTION HANDLERS ---
bot.action('buy_number', (ctx) => {
  ctx.answerCbQuery();
  const countryKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇸 United States', 'country_us'), Markup.button.callback('🇬🇧 United Kingdom', 'country_uk')],
    [Markup.button.callback('🇨🇦 Canada', 'country_ca'), Markup.button.callback('🇳🇬 Nigeria', 'country_ng')],
    [Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]
  ]);
  ctx.editMessageText('Select the country for your virtual number:', countryKeyboard);
});

bot.action('fund_wallet', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('To fund your wallet, enter the amount in NGN or tap below to generate a deposit link.', 
    Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]])
  );
});

bot.action('order_history', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('📜 *Your Order History*\n\nYou currently have no active virtual numbers.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]])
  });
});

bot.action('check_balance', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('💰 *Wallet Balance:* ₦0.00\n\nPlease fund your wallet to purchase virtual numbers.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('💳 Fund Wallet', 'fund_wallet'), Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]])
  });
});

bot.action('support', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('💬 *MJ SMS Support*\n\nIf you need assistance with an order or account funding, please contact support.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]])
  });
});

bot.action('main_menu', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `Welcome to *MJ SMS*! 🚀\n\nSelect an option below:`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// Fallback for general text messages
bot.on('text', (ctx) => {
  ctx.reply('Please use the menu buttons below to navigate MJ SMS:', mainKeyboard);
});

// --- WEBHOOK & SERVER SETUP ---
const WEBHOOK_PATH = `/webhook/telegram`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.get('/', (req, res) => {
  res.send('MJ SMS Bot Server is active!');
});

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
