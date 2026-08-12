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
    orders: [],
    conversation: []
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
        orders: row.orders || [],
        conversation: row.conversation || []
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
    conversation: session.conversation || [],
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

// ===========================================================================
// GEMINI — conversational layer over the real MJ SMS (Server 1/GrizzlySMS)
// actions above. This does NOT replace grizzlyPrices/grizzlyBuy/etc. — it
// gives Gemini "function calling" access to call those exact same functions,
// so what it tells the user is always backed by a real price/order/status,
// never invented. If GEMINI_API_KEY isn't set, the bot falls back to the
// old rigid parseCountryService flow below instead of breaking.
// ===========================================================================

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_CONVERSATION_TURNS = 16; // ~8 back-and-forths kept for context, older ones dropped
const MAX_TOOL_ROUNDTRIPS = 5; // hard cap so a confused loop can't run forever inside one webhook call

const GEMINI_SYSTEM_PROMPT = `You are Mira, the support agent for MJ SMS — Server 1, powered by GrizzlySMS — part of MJ HUB.

What MJ SMS does: customers rent a temporary virtual phone number in a specific country to receive one SMS verification code for an app (WhatsApp, Telegram, Google, Instagram, etc.), pay for it from their MJ HUB wallet balance (in Nigerian Naira, ₦), and use the code to finish signing up on that app.

How you must operate:
- Talk like a helpful, warm human support agent — natural sentences, not a menu of commands. Never say "I am an AI" or mention functions/tools/APIs to the user.
- NEVER invent a price, phone number, order ID, stock count, or balance. Every one of those must come from calling the matching function. If you haven't called the function yet in this conversation for the specific country/service being discussed, call it before answering.
- If the user's country or app isn't clear yet, ask a short clarifying question instead of guessing.
- Before calling buy_number, make sure you already know (from get_prices, called in this same exchange or very recently) that the country+service combo exists and its price — buy_number itself will also refuse if the wallet balance is too low, so don't worry about pre-checking balance yourself, just let it try and relay the result.
- After buy_number succeeds, tell the user their number and clearly say to wait for the code to arrive, and that they can just ask "did it arrive" or "check my code" any time — you will call check_status when they do.
- If a user seems frustrated or stuck, be patient and helpful rather than repeating the same explanation — ask what specifically isn't working.
- Prices are already in Naira (₦) by the time they reach you — never convert or recalculate them yourself.
- If a function call fails or returns an error, explain plainly what went wrong and suggest a next step (try a different country/app, wait and retry, or contact a human admin for anything you can't resolve) — don't pretend it succeeded.
- Keep replies concise — this is a chat app, not an essay. Use Telegram Markdown sparingly (bold for the phone number/code/order id only).`;

const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'list_countries',
      description: 'List the countries this service currently supports, with their internal country codes.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_prices',
      description: 'Get real, current prices and stock for every app/service available in one country. Always call this before quoting a price or buying, even if you think you already know it — stock and price change constantly.',
      parameters: {
        type: 'OBJECT',
        properties: {
          country: { type: 'STRING', description: 'Country name as the user said it, e.g. "Nigeria", "USA", "UK"' },
          service: { type: 'STRING', description: 'Optional — app name to filter to, e.g. "WhatsApp". Leave blank to see everything available in that country.' }
        },
        required: ['country']
      }
    },
    {
      name: 'buy_number',
      description: 'Actually purchase a number and charge the customer wallet. Only call this once the user has clearly confirmed which country and app they want.',
      parameters: {
        type: 'OBJECT',
        properties: {
          country: { type: 'STRING' },
          service: { type: 'STRING', description: 'App name, e.g. "WhatsApp", "Telegram", "Google"' }
        },
        required: ['country', 'service']
      }
    },
    {
      name: 'check_status',
      description: 'Check whether the SMS code has arrived yet for a given order. If order_id is omitted, checks the customer\'s most recent order automatically.',
      parameters: {
        type: 'OBJECT',
        properties: { order_id: { type: 'STRING', description: 'Optional — omit to check the most recent order.' } }
      }
    },
    {
      name: 'cancel_order',
      description: 'Cancel a pending order and refund the customer\'s wallet if eligible. If order_id is omitted, cancels the customer\'s most recent pending order.',
      parameters: {
        type: 'OBJECT',
        properties: { order_id: { type: 'STRING', description: 'Optional — omit to cancel the most recent pending order.' } }
      }
    },
    {
      name: 'get_balance',
      description: 'Get the customer\'s current MJ HUB wallet balance in Naira.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_my_orders',
      description: 'Get the customer\'s recent order history.',
      parameters: { type: 'OBJECT', properties: {} }
    }
  ]
}];

function resolveCountry(name) {
  const key = String(name || '').toLowerCase().trim();
  if (key in COUNTRY_MAP) return { id: COUNTRY_MAP[key], name: key };
  // try a loose contains-match as a fallback for phrasing Gemini might use
  // that isn't an exact key (e.g. "United States of America")
  for (const [k, id] of Object.entries(COUNTRY_MAP)) {
    if (key.includes(k) || k.includes(key)) return { id, name: k };
  }
  return null;
}

async function executeGeminiFunction(fnName, args, telegramUserId, session) {
  switch (fnName) {
    case 'list_countries': {
      const names = [...new Set(Object.keys(COUNTRY_MAP).filter((k) => k.length > 2))];
      return { countries: names };
    }

    case 'get_prices': {
      const c = resolveCountry(args.country);
      if (!c) return { error: `Unknown country "${args.country}". Ask the user to clarify or try list_countries.` };
      let list = await grizzlyPrices(c.id);
      if (!list.length) return { error: `No services currently available for ${c.name}.` };
      if (args.service) {
        const filtered = matchServices(list, args.service);
        if (filtered.length) list = filtered;
      }
      session.country = c.name;
      session.countryId = c.id;
      return {
        country: c.name,
        services: list.slice(0, 15).map((s) => ({
          service: s.service_id,
          price_ngn: s.price_ngn,
          stock: s.stock
        }))
      };
    }

    case 'buy_number': {
      const c = resolveCountry(args.country);
      if (!c) return { error: `Unknown country "${args.country}".` };
      const list = await grizzlyPrices(c.id);
      const matched = matchServices(list, args.service);
      const svc = matched[0] || list.find((s) => String(s.service_id).toLowerCase() === String(args.service).toLowerCase());
      if (!svc) return { error: `"${args.service}" isn't available in ${c.name} right now.` };

      if (svc.price_ngn > 0 && session.balance < svc.price_ngn) {
        return {
          error: 'insufficient_balance',
          balance_ngn: session.balance,
          price_ngn: svc.price_ngn,
          message: `Customer's balance (₦${session.balance}) is below the price (₦${svc.price_ngn}). Tell them to top up their MJ HUB wallet and try again.`
        };
      }

      const bought = await grizzlyBuy(svc.service_id, c.id);
      if (!bought.success) return { error: bought.message || 'Purchase failed at the supplier.' };

      if (svc.price_ngn > 0) session.balance = Math.max(0, session.balance - svc.price_ngn);
      const order = {
        orderId: bought.order_id,
        provider: 'grizzly',
        serviceName: svc.service_id,
        phoneNumber: bought.number,
        price: svc.price_ngn,
        status: 'Waiting SMS',
        date: new Date().toISOString()
      };
      session.orders = [...(session.orders || []), order].slice(-30);

      return {
        success: true,
        order_id: bought.order_id,
        phone_number: bought.number,
        price_ngn: svc.price_ngn,
        new_balance_ngn: session.balance
      };
    }

    case 'check_status': {
      const orderId = args.order_id || (session.orders || []).slice(-1)[0]?.orderId;
      if (!orderId) return { error: 'No recent order found for this customer.' };
      const st = await grizzlyStatus(orderId);
      if (st.success && st.code) {
        session.orders = (session.orders || []).map((o) =>
          String(o.orderId) === String(orderId) ? { ...o, status: `Code: ${st.code}` } : o
        );
        return { order_id: orderId, code: st.code };
      }
      return { order_id: orderId, waiting: !!st.waiting, message: st.message || 'Still waiting for the SMS to arrive.' };
    }

    case 'cancel_order': {
      const orderId = args.order_id || (session.orders || []).slice(-1)[0]?.orderId;
      if (!orderId) return { error: 'No recent order found for this customer.' };
      const order = (session.orders || []).find((o) => String(o.orderId) === String(orderId));
      await grizzlyCancel(orderId);
      let refunded = 0;
      if (order && order.price > 0 && !/cancelled/i.test(order.status || '')) {
        refunded = order.price;
        session.balance += refunded;
      }
      session.orders = (session.orders || []).map((o) =>
        String(o.orderId) === String(orderId) ? { ...o, status: 'Cancelled' } : o
      );
      return { order_id: orderId, refunded_ngn: refunded, new_balance_ngn: session.balance };
    }

    case 'get_balance':
      return { balance_ngn: session.balance };

    case 'get_my_orders':
      return { orders: (session.orders || []).slice(-10) };

    default:
      return { error: `Unknown function ${fnName}` };
  }
}

async function callGeminiWithTools(session, telegramUserId, userText) {
  const contents = [
    ...(session.conversation || []),
    { role: 'user', parts: [{ text: userText }] }
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
    let res;
    try {
      res = await axios.post(
        GEMINI_URL,
        {
          systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
          contents,
          tools: GEMINI_TOOLS
        },
        { ...axiosCfg, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.error('gemini call failed', e.response?.data || e.message);
      return { reply: "Sorry, I'm having trouble reaching my brain right now — please try again in a moment.", contents };
    }

    const candidate = res.data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart) {
      const text = parts.map((p) => p.text || '').join('').trim() || "I'm not sure how to help with that — could you rephrase?";
      contents.push({ role: 'model', parts });
      return { reply: text, contents };
    }

    // Model wants to call a function — run it for real, then hand the
    // result back so it can either call another function or finally reply.
    contents.push({ role: 'model', parts });
    const { name, args } = functionCallPart.functionCall;
    const result = await executeGeminiFunction(name, args || {}, telegramUserId, session);
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name, response: result } }]
    });
  }

  return { reply: "I ran into a few steps trying to sort that out and want to double check with a human — try rephrasing, or contact support.", contents };
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
  const greeting = GEMINI_API_KEY
    ? `Hey! I'm Mira 👋 — I help you get virtual numbers for SMS verification (WhatsApp, Telegram, Google, and more) across a bunch of countries.\n\nJust tell me what you need in your own words — e.g. "I need a US number for WhatsApp" or "what's available in Nigeria" — and I'll sort it out.\n\n/balance — wallet\n/fund — top up\n/orders — history`
    : `Welcome to *MJ SMS* (Grizzly · Server 1)\n\nType a country + app, e.g.\n• *USA WhatsApp*\n• *Nigeria Telegram*\n• *UK Google*\n\n/balance — wallet\n/fund — top up\n/orders — history\n/status — supplier status`;
  await ctx.reply(greeting, { parse_mode: 'Markdown' });
});

bot.command(['balance', 'bal'], async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  await ctx.reply(`Balance: *₦${(s.balance || 0).toLocaleString()}*`, { parse_mode: 'Markdown' });
});

bot.command('orders', async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  if (!s.orders || !s.orders.length) return ctx.reply('No orders yet.');
  const lines = s.orders
    .slice(-10)
    .reverse()
    .map((o) => `• ${o.serviceName || o.service} | \`${o.phoneNumber}\` | ₦${o.price} | ${o.status}`)
    .join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  if (!GRIZZLY_KEY) return ctx.reply('GRIZZLYSMS_API_KEY not set on server.');
  const bal = await grizzlyBalance();
  if (bal == null) return ctx.reply('Grizzly: OFFLINE');
  await ctx.reply(`*Grizzly (Server 1):* ONLINE\nSupplier balance: \`${bal}\``, {
    parse_mode: 'Markdown'
  });
});

bot.command('fund', async (ctx) => {
  if (!PAYSTACK_SECRET_KEY) {
    return ctx.reply('Funding is managed on the MJ HUB website wallet for now. Ask admin if you need a top-up here.');
  }
  await ctx.reply('Send amount in Naira, e.g. `5000`', { parse_mode: 'Markdown' });
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
    return ctx.reply('Insufficient balance. Use /fund or top up on MJ HUB.');
  }

  await ctx.reply('Buying number…');
  const bought = await grizzlyBuy(serviceId, countryId);
  if (!bought.success) {
    return ctx.reply(`Failed: ${bought.message || 'No number'}`);
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
    `Number ready\n📞 \`${bought.number}\`\n🆔 \`${bought.order_id}\`\n\nTap below when the SMS arrives (or every ~10s).`,
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
    return ctx.reply(`Code: *${st.code}*`, { parse_mode: 'Markdown' });
  }
  return ctx.reply(st.waiting ? 'Still waiting for SMS… tap Check again.' : `Status: ${st.message || 'waiting'}`);
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
  await ctx.reply(price > 0 ? `Cancelled. ₦${price} refunded.` : 'Cancelled.');
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  const userId = ctx.from.id;
  const session = await getUserSession(userId);

  if (GEMINI_API_KEY) {
    try {
      await ctx.sendChatAction('typing');
    } catch (_) {}
    const { reply, contents } = await callGeminiWithTools(session, userId, text);
    // Cap history so the prompt sent to Gemini (and the row stored in
    // Supabase) doesn't grow unbounded across a long-running conversation.
    session.conversation = contents.slice(-MAX_CONVERSATION_TURNS);
    await saveUserSession(userId, session);
    try {
      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (_) {
      // Markdown parse errors (e.g. stray * or _ in the reply) shouldn't
      // eat the whole reply — retry once as plain text.
      await ctx.reply(reply);
    }
    return;
  }

  // Fallback used only if GEMINI_API_KEY isn't configured — the original
  // rigid substring/keyword flow, kept working rather than removed.
  const parsed = parseCountryService(text);
  if (!parsed.countryId) {
    return ctx.reply(
      'Tell me country + app in one message.\nExamples: *USA WhatsApp*, *Nigeria Telegram*, *UK Google*',
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply(`Checking Grizzly for *${parsed.countryName}*…`, { parse_mode: 'Markdown' });
  let list = await grizzlyPrices(parsed.countryId);
  if (!list.length) {
    return ctx.reply('No services returned for that country right now. Try another.');
  }
  if (parsed.serviceCode || parsed.serviceName) {
    list = matchServices(list, parsed.serviceName || parsed.serviceCode);
  }

  session.country = parsed.countryName;
  session.countryId = parsed.countryId;
  session.serviceQuery = parsed.serviceName || parsed.serviceCode;
  await saveUserSession(userId, session);

  const buttons = list.slice(0, 10).map((s) => [
    Markup.button.callback(
      `${s.service_id} · ₦${s.price_ngn}${s.stock ? ` · ~${s.stock}` : ''}`,
      `buy:${parsed.countryId}:${s.service_id}:${s.price_ngn}`
    )
  ]);

  await ctx.reply(
    `*Grizzly · Server 1*\nCountry: ${parsed.countryName} (${parsed.countryId})\nPick a service:`,
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
      return res.end('MJ SMS Bot (Grizzly Server 1) — Vercel');
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
