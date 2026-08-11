/**
 * MJ SMS Telegram Bot — GrizzlySMS only (MJ HUB Server 1)
 * Deploy on Vercel as a serverless webhook (no Render long-running process).
 */
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;
const GRIZZLY_BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const SUPABASE_REST_URL = (process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1500;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7466363018';

// Common Grizzly / SMS-Activate style country ids
const COUNTRY_MAP = {
  nigeria: 19, ng: 19, naija: 19,
  usa: 12, us: 12, america: 12, 'united states': 12,
  uk: 16, britain: 16, england: 16, 'united kingdom': 16,
  ghana: 38, gh: 38,
  kenya: 8, ke: 8,
  'south africa': 31, sa: 31,
  india: 22, in: 22,
  canada: 36, ca: 36,
  germany: 43, de: 43,
  france: 78, fr: 78,
  netherlands: 48, nl: 48,
  indonesia: 6, id: 6,
  philippines: 4, ph: 4,
  brazil: 73, br: 73,
  mexico: 54, mx: 54,
  turkey: 62, tr: 62,
  egypt: 21, eg: 21,
  russia: 0, ru: 0,
  ukraine: 1, ua: 1,
  poland: 15, pl: 15,
  spain: 56, es: 56,
  italy: 86, it: 86,
  china: 3, cn: 3,
  vietnam: 10, vn: 10,
  thailand: 52, th: 52,
  malaysia: 7, my: 7
};

// Common service short-codes (Grizzly / SMS-Activate style)
const SERVICE_MAP = {
  whatsapp: 'wa', wa: 'wa',
  telegram: 'tg', tg: 'tg',
  google: 'go', gmail: 'go',
  facebook: 'fb', fb: 'fb',
  instagram: 'ig', ig: 'ig',
  twitter: 'tw', x: 'tw',
  tiktok: 'lf',
  discord: 'ds',
  snapchat: 'sn',
  microsoft: 'mm',
  amazon: 'am',
  apple: 'wx',
  uber: 'ub',
  viber: 'vi',
  line: 'me',
  netflix: 'nf',
  paypal: 'ts',
  bumble: 'mo',
  tinder: 'oi'
};

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
}

const bot = new Telegraf(BOT_TOKEN || 'missing');

const axiosCfg = {
  timeout: 25000,
  headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'MJ-SMS-Bot/2.0' }
};

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY || '',
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY || ''}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
};

function markupNgn(usdPrice) {
  const n = Number(usdPrice) || 0;
  const ngn = n * USD_TO_NGN;
  // MUST match lib/pricing.js's applyMarkup() on the main site exactly —
  // otherwise the same GrizzlySMS number sells at a different price
  // depending on whether the customer buys through the website or this
  // bot, which is a real pricing-integrity/profit-control problem, not
  // just a cosmetic inconsistency. If you ever change the range on the
  // website (currently 40–85%, updated 2026-08-04), update it here too.
  const percent = 40 + Math.random() * 45;
  const finalPrice = Math.ceil(ngn * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

async function getUserSession(userId) {
  const empty = {
    balance: 0,
    state: 'AWAITING_INPUT',
    country: null,
    countryId: null,
    serviceQuery: null,
    orders: []
  };
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) return empty;
  try {
    const res = await axios.get(
      `${SUPABASE_REST_URL}/user_sessions?user_id=eq.${userId}&select=*`,
      { ...axiosCfg, headers: sbHeaders }
    );
    if (res.data && res.data[0]) {
      const row = res.data[0];
      return {
        balance: parseFloat(row.balance || 0),
        state: row.state || 'AWAITING_INPUT',
        country: row.country || null,
        countryId: row.country_id || null,
        serviceQuery: row.selected_service_query || null,
        orders: row.orders || []
      };
    }
  } catch (_) {}
  await saveUserSession(userId, empty);
  return empty;
}

async function saveUserSession(userId, session) {
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) return;
  const payload = {
    user_id: String(userId),
    balance: session.balance || 0,
    state: session.state || 'AWAITING_INPUT',
    country: session.country || null,
    country_id: session.countryId || null,
    selected_service_query: session.serviceQuery || null,
    orders: session.orders || [],
    updated_at: new Date().toISOString()
  };
  try {
    const existing = await axios.get(
      `${SUPABASE_REST_URL}/user_sessions?user_id=eq.${userId}&select=user_id`,
      { ...axiosCfg, headers: sbHeaders }
    );
    if (existing.data && existing.data.length) {
      await axios.patch(
        `${SUPABASE_REST_URL}/user_sessions?user_id=eq.${userId}`,
        payload,
        { ...axiosCfg, headers: sbHeaders }
      );
    } else {
      await axios.post(`${SUPABASE_REST_URL}/user_sessions`, payload, {
        ...axiosCfg,
        headers: sbHeaders
      });
    }
  } catch (e) {
    console.error('saveUserSession', e.message);
  }
}

async function grizzlyGet(params) {
  const res = await axios.get(GRIZZLY_BASE, {
    ...axiosCfg,
    params: { api_key: (GRIZZLY_KEY || '').trim(), ...params }
  });
  return res.data;
}

async function grizzlyPrices(countryId) {
  try {
    const data = await grizzlyGet({ action: 'getPricesV3', country: String(countryId) });
    const block = (data && (data[String(countryId)] || data[countryId])) || data || {};
    const list = [];
    for (const [code, info] of Object.entries(block)) {
      if (!code || typeof info !== 'object') continue;
      const cost = Number(info.cost ?? info.price ?? info.rate ?? 0);
      const count = Number(info.count ?? info.phones ?? info.qty ?? 0);
      list.push({
        service_id: String(code),
        service_name: String(code),
        stock: count,
        price_usd: cost,
        price_ngn: markupNgn(cost)
      });
    }
    return list.filter((s) => s.price_usd > 0);
  } catch (e) {
    console.error('grizzlyPrices', e.message);
    return [];
  }
}

async function grizzlyBuy(serviceId, countryId) {
  try {
    const raw = await grizzlyGet({
      action: 'getNumber',
      service: serviceId,
      country: String(countryId)
    });
    const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
    if (text.startsWith('ACCESS_NUMBER')) {
      const parts = text.split(':');
      return { success: true, order_id: parts[1], number: parts[2] };
    }
    // JSON style
    if (raw && (raw.activationId || raw.id)) {
      return {
        success: true,
        order_id: String(raw.activationId || raw.id),
        number: String(raw.phoneNumber || raw.number || raw.phone || '')
      };
    }
    return { success: false, message: text || 'No numbers' };
  } catch (e) {
    return { success: false, message: e.message || 'Buy failed' };
  }
}

async function grizzlyStatus(orderId) {
  try {
    const raw = await grizzlyGet({ action: 'getStatus', id: orderId });
    const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
    if (text.startsWith('STATUS_OK')) {
      return { success: true, code: text.split(':')[1] || text.replace('STATUS_OK:', '') };
    }
    if (raw && raw.code) return { success: true, code: String(raw.code) };
    return { success: false, waiting: /WAIT|STATUS_WAIT/i.test(text), message: text };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function grizzlyCancel(orderId) {
  try {
    await grizzlyGet({ action: 'setStatus', id: orderId, status: 8 });
  } catch (_) {}
}

async function grizzlyBalance() {
  try {
    const raw = await grizzlyGet({ action: 'getBalance' });
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.startsWith('ACCESS_BALANCE')) return text.split(':')[1];
    if (raw && raw.balance != null) return String(raw.balance);
    return text || 'ok';
  } catch (e) {
    return null;
  }
}

function parseCountryService(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let countryId = null;
  let countryName = null;
  let serviceCode = null;
  let serviceName = null;

  // Word-boundary matching, not substring .includes() — this function reads
  // every free-text message a user sends (see bot.on('text', ...)), and
  // short 2-letter codes like 'in', 'us', 'ng', 'ca' as raw substrings would
  // false-match inside completely unrelated words ('finish', 'joining',
  // 'buying', 'canada'... wait even 'canada' contains 'ca' — exactly this
  // class of bug). \b ensures 'us' matches the standalone word "us", not
  // the middle of "trust" or "custom". Longer names are checked first so
  // e.g. "united states" wins over a shorter unrelated partial match.
  const countryEntries = Object.entries(COUNTRY_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, id] of countryEntries) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
      countryId = id;
      countryName = name;
      break;
    }
  }
  const serviceEntries = Object.entries(SERVICE_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of serviceEntries) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
      serviceCode = code;
      serviceName = name;
      break;
    }
  }
  return { countryId, countryName, serviceCode, serviceName };
}

function matchServices(list, query) {
  if (!query) return list.slice(0, 12);
  const q = String(query).toLowerCase();
  const code = SERVICE_MAP[q] || q;
  const hit = list.filter(
    (s) =>
      s.service_id.toLowerCase() === code ||
      s.service_id.toLowerCase().includes(q) ||
      s.service_name.toLowerCase().includes(q)
  );
  return hit.length ? hit.slice(0, 12) : list.slice(0, 12);
}

// ---------- Bot commands ----------

bot.start(async (ctx) => {
  await ctx.reply(
    `Welcome to *MJ SMS* (Server 1) 🎉\n\nJust type country + app, my guy:\n• *USA WhatsApp*\n• *Nigeria Telegram*\n• *UK Google*\n\nAnd I go show you wetin dey available.\n\n/balance — check your wallet\n/fund — top up\n/orders — your order history\n/status — see if server dey up`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['balance', 'bal'], async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  await ctx.reply(`Boss your current balance na *₦${(s.balance || 0).toLocaleString()}* ✨`, { parse_mode: 'Markdown' });
});

bot.command('orders', async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  if (!s.orders || !s.orders.length) return ctx.reply('You never order anything before o.');
  const lines = s.orders
    .slice(-10)
    .reverse()
    .map((o) => `• ${o.serviceName || o.service} | \`${o.phoneNumber}\` | ₦${o.price} | ${o.status}`)
    .join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  if (!GRIZZLY_KEY) return ctx.reply('Server key never set for backend o — abeg tell admin.');
  const bal = await grizzlyBalance();
  if (bal == null) return ctx.reply('Server 1 dey OFFLINE right now. Try again small time.');
  await ctx.reply(`*Server 1:* dey ONLINE ✅\nWe get enough stock to serve you.`, {
    parse_mode: 'Markdown'
  });
});

bot.command('fund', async (ctx) => {
  if (!PAYSTACK_SECRET_KEY) {
    return ctx.reply('E get one way to fund here for now — abeg go MJ HUB website and top up your wallet there, boss.');
  }
  await ctx.reply('Send the amount for Naira, e.g. `5000`', { parse_mode: 'Markdown' });
});

// Buy callback: buy:countryId:serviceId:priceNgn
bot.action(/^buy:(\d+):([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const price = parseInt(ctx.match[3], 10) || 0;
  const session = await getUserSession(userId);

  if (price > 0 && session.balance < price) {
    return ctx.reply('E be like say your balance no reach o. Use /fund or top up on MJ HUB first.');
  }

  await ctx.reply('Dey buy your number… hold on small.');
  const bought = await grizzlyBuy(serviceId, countryId);
  if (!bought.success) {
    return ctx.reply(`E no work o: ${bought.message || 'no number available'}. Try again.`);
  }

  if (price > 0) {
    session.balance = Math.max(0, session.balance - price);
  }
  const order = {
    orderId: bought.order_id,
    provider: 'grizzly',
    serviceName: serviceId,
    phoneNumber: bought.number,
    price,
    status: 'Waiting SMS',
    date: new Date().toISOString()
  };
  session.orders = [...(session.orders || []), order].slice(-30);
  await saveUserSession(userId, session);

  await ctx.reply(
    `Your number don ready! 🎉\n📞 \`${bought.number}\`\n🆔 \`${bought.order_id}\`\n\nTap "Check SMS code" below when the message land (or check am every 10 seconds or so).`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Check SMS code', `chk:${bought.order_id}:${price}`)],
        [Markup.button.callback('Cancel + refund', `can:${bought.order_id}:${price}`)]
      ])
    }
  );
});

bot.action(/^chk:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const orderId = ctx.match[1];
  const price = parseInt(ctx.match[2], 10) || 0;
  const st = await grizzlyStatus(orderId);
  if (st.success && st.code) {
    const session = await getUserSession(ctx.from.id);
    session.orders = (session.orders || []).map((o) =>
      String(o.orderId) === String(orderId) ? { ...o, status: `Code: ${st.code}` } : o
    );
    await saveUserSession(ctx.from.id, session);
    return ctx.reply(`Code don land! *${st.code}* 🎉`, { parse_mode: 'Markdown' });
  }
  return ctx.reply(st.waiting ? 'Message never land yet… tap Check again small time.' : `Status: ${st.message || 'still dey wait'}`);
});

bot.action(/^can:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const price = parseInt(ctx.match[2], 10) || 0;
  await grizzlyCancel(orderId);
  if (price > 0) {
    const session = await getUserSession(ctx.from.id);
    session.balance += price;
    session.orders = (session.orders || []).map((o) =>
      String(o.orderId) === String(orderId) ? { ...o, status: 'Cancelled' } : o
    );
    await saveUserSession(ctx.from.id, session);
  }
  await ctx.reply(price > 0 ? `Cancelled ✅ ₦${price} don enter your wallet back.` : 'Cancelled ✅');
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  const parsed = parseCountryService(text);
  if (!parsed.countryId) {
    return ctx.reply(
      'Abeg tell me country + app for one message, my guy.\nLike this: *USA WhatsApp*, *Nigeria Telegram*, *UK Google*',
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply(`Dey check Server 1 for *${parsed.countryName}*… hold on.`, { parse_mode: 'Markdown' });
  let list = await grizzlyPrices(parsed.countryId);
  if (!list.length) {
    return ctx.reply('E no get service for that country right now o. Try another one.');
  }
  if (parsed.serviceCode || parsed.serviceName) {
    list = matchServices(list, parsed.serviceName || parsed.serviceCode);
  }

  const session = await getUserSession(ctx.from.id);
  session.country = parsed.countryName;
  session.countryId = parsed.countryId;
  session.serviceQuery = parsed.serviceName || parsed.serviceCode;
  await saveUserSession(ctx.from.id, session);

  const buttons = list.slice(0, 10).map((s) => [
    Markup.button.callback(
      `${s.service_id} · ₦${s.price_ngn}${s.stock ? ` · ~${s.stock}` : ''}`,
      `buy:${parsed.countryId}:${s.service_id}:${s.price_ngn}`
    )
  ]);

  await ctx.reply(
    `*Server 1*\nCountry: ${parsed.countryName} (${parsed.countryId})\nPick the service wey you want:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.catch((err) => console.error('bot error', err));

// ---------- Vercel / local handler ----------

module.exports = async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = `${proto}://${host}`;
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

    if (req.method === 'GET' && (req.url === '/setup-webhook' || req.url?.startsWith('/setup-webhook'))) {
      if (!BOT_TOKEN) {
        res.statusCode = 500;
        return res.end('BOT_TOKEN missing');
      }
      // This endpoint re-registers where Telegram sends your bot's traffic.
      // Previously it had zero auth — anyone who found this URL could hit
      // it (harmless-looking, since it always points back to this same
      // deployment) but it also silently drops any messages that arrived
      // in the moments before someone else re-ran it (drop_pending_updates)
      // — a cheap way to disrupt real users. Now requires WEBHOOK_SECRET as
      // a query param if that env var is set.
      if (WEBHOOK_SECRET) {
        const providedSecret = new URL(base + req.url).searchParams.get('secret');
        if (providedSecret !== WEBHOOK_SECRET) {
          res.statusCode = 401;
          return res.end('Unauthorized — pass ?secret=YOUR_WEBHOOK_SECRET');
        }
      }
      const url = `${base}/api`;
      await bot.telegram.setWebhook(url, {
        drop_pending_updates: true,
        // Telegram echoes this back on every real update as the
        // X-Telegram-Bot-Api-Secret-Token header — validated below on
        // every POST, so requests NOT actually from Telegram get rejected
        // instead of being processed as if a real user sent them.
        ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {})
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        webhook: url,
        secured: !!WEBHOOK_SECRET,
        warning: WEBHOOK_SECRET ? undefined : 'WEBHOOK_SECRET is not set — this webhook accepts requests from anyone, not just Telegram. Set WEBHOOK_SECRET and re-run this endpoint.'
      }));
    }

    if (req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('MJ SMS Bot (Server 1) — Vercel');
    }

    if (req.method === 'POST') {
      if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        res.statusCode = 401;
        return res.end('unauthorized');
      }
      await bot.handleUpdate(req.body);
      res.statusCode = 200;
      return res.end('ok');
    }

    res.statusCode = 405;
    res.end('Method not allowed');
  } catch (e) {
    console.error(e);
    res.statusCode = 200; // avoid Telegram retries storm
    res.end('ok');
  }
};
