const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');

// Load environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // e.g. https://your-service.onrender.com

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN environment variable is not set. The bot cannot run without it.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Greeting in Nigerian Pidgin English on /start
bot.start((ctx) => {
  return ctx.reply('How far boss! 👋 Welcome to MJ Services Bot. Which app or service you wan verify today?');
});

// Example handler for text messages (extend as needed)
bot.on('text', (ctx) => {
  const text = ctx.message.text || '';
  // Simple echo for now; you can expand to handle verification commands
  if (!text.startsWith('/')) {
    return ctx.reply(`I hear you: "${text}". I fit help you verify apps or services.`);
  }
});

// Express setup
const app = express();
app.use(express.json());

// Webhook endpoint
app.post('/webhook/telegram', async (req, res) => {
  try {
    // Optionally set webhook when receiving a request (if not already set)
    if (EXTERNAL_URL) {
      const webhookUrl = `${EXTERNAL_URL.replace(/\/$/, '')}/webhook/telegram`;
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log('Webhook set to', webhookUrl);
      } catch (err) {
        console.warn('Failed to set webhook on request:', err && err.message ? err.message : err);
      }
    } else {
      console.warn('RENDER_EXTERNAL_URL not set; skipping webhook set on request.');
    }

    // Let Telegraf handle the incoming update
    await bot.handleUpdate(req.body);

    // Respond to Telegram
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error handling webhook update:', err);
    return res.sendStatus(500);
  }
});

// Start server and attempt to set webhook on startup
(async () => {
  if (EXTERNAL_URL) {
    const webhookUrl = `${EXTERNAL_URL.replace(/\/$/, '')}/webhook/telegram`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log('Webhook set to', webhookUrl);
    } catch (err) {
      console.warn('Failed to set webhook on startup:', err && err.message ? err.message : err);
    }
  } else {
    console.log('RENDER_EXTERNAL_URL not provided; skipping automatic webhook setup on startup.');
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
})();
