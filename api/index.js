/**
 * MJ SMS Telegram Bot — GrizzlySMS only (MJ HUB Server 1)
 * Deploy on Vercel as a serverless webhook (no Render long-running process).
 */
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;
const GRIZZLY_BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
let SUPABASE_REST_URL = (process.env.SUPABASE_REST_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
if (SUPABASE_REST_URL && !/\/rest\/v1$/i.test(SUPABASE_REST_URL)) {
  // Allow either full REST URL or project root URL
  SUPABASE_REST_URL = SUPABASE_REST_URL.replace(/\/$/, '') + '/rest/v1';
}
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1500;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET || process.env.PAYSTACK_SECRET_KEY_LIVE || '';
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
  tiktok: 'lf', douyin: 'lf',
  discord: 'ds',
  snapchat: 'fu', snap: 'fu',
  microsoft: 'mm',
  amazon: 'am',
  apple: 'wx',
  uber: 'ub',
  viber: 'vi',
  line: 'me',
  netflix: 'nf',
  paypal: 'ts',
  bumble: 'mo',
  tinder: 'oi',
  linkedin: 'tn',
  signal: 'aaw',
  wechat: 'we',
  imo: 'im'
};

// Human names for Grizzly service codes (aligned with MJ HUB website map)
const SERVICE_NAMES = {
  aaw: 'Signal', aax: 'Haraj', acz: 'Claude / AI', am: 'Amazon',
  ds: 'Discord', fb: 'Facebook', fu: 'Snapchat', go: 'Google',
  ig: 'Instagram', im: 'Imo', kc: 'X / Twitter (alt)', kt: 'KakaoTalk',
  lf: 'TikTok', me: 'Line', mm: 'Microsoft', mo: 'Bumble',
  nf: 'Netflix', oi: 'Tinder', ot: 'Any other', tg: 'Telegram',
  tk: 'TikTok', tl: 'Truecaller', tn: 'LinkedIn', ts: 'PayPal',
  tw: 'X / Twitter', uk: 'Airbnb', vi: 'Viber', vk: 'VK',
  wa: 'WhatsApp', we: 'WeChat', wx: 'Apple', ya: 'Yandex'
};

function friendlyServiceName(code, rawName) {
  const c = String(code || '').toLowerCase();
  const raw = String(rawName || '').trim();
  if (raw && raw.toLowerCase() !== c && !/^gr_/i.test(raw)) return raw.replace(/_/g, ' ');
  if (SERVICE_NAMES[c]) return SERVICE_NAMES[c];
  return c.toUpperCase();
}

function detectVariant(name, code) {
  const s = `${name || ''} ${code || ''}`.toLowerCase();
  if (/virtual|voip|temp number|temporary/.test(s)) return 'virtual';
  if (/physical|real|normal|mobile|long.?term/.test(s)) return 'normal';
  // Grizzly codes that commonly map to alternate/virtual lines for same app
  if (/^wa_|^tg_|^go_|^ig_|^fb_/.test(s)) return 'alternate';
  return 'normal';
}


if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
}

const bot = new Telegraf(BOT_TOKEN || 'missing');

// Fallback store when Supabase session save fails (400/404)
const pendingPayments = new Map(); // telegramUserId -> { reference, amount_ngn, authorization_url }
const creditedRefs = new Set();

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
      const allOrders = row.orders || [];
      const meta = allOrders.find((o) => o && o.type === '_payment_meta') || {};
      const orders = allOrders.filter((o) => o && o.type !== '_payment_meta');
      return {
        balance: parseFloat(row.balance || 0),
        state: row.state || 'AWAITING_INPUT',
        country: row.country || null,
        countryId: row.country_id || null,
        serviceQuery: row.selected_service_query || null,
        orders,
        conversation: row.conversation || [],
        pending_payment: meta.pending_payment || null,
        last_credited_reference: meta.last_credited_reference || null
      };
    }
  } catch (_) {}
  await saveUserSession(userId, empty);
  return empty;
}

async function saveUserSession(userId, session) {
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) return;
  // Pack payment meta into orders list so we don't need extra Supabase columns.
  const orders = [...(session.orders || [])].filter((o) => o && o.type !== '_payment_meta');
  if (session.pending_payment || session.last_credited_reference) {
    orders.push({
      type: '_payment_meta',
      pending_payment: session.pending_payment || null,
      last_credited_reference: session.last_credited_reference || null
    });
  }
  const payload = {
    user_id: String(userId),
    balance: session.balance || 0,
    state: session.state || 'AWAITING_INPUT',
    country: session.country || null,
    country_id: session.countryId || null,
    selected_service_query: session.serviceQuery || null,
    orders,
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
    console.error('saveUserSession', e.response?.status, e.response?.data || e.message);
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
      if (!(cost > 0)) continue;
      const rawName = info.name || info.service || info.eng || code;
      const display = friendlyServiceName(code, rawName);
      const variant = detectVariant(display, code);
      list.push({
        service_id: String(code),
        service_name: display,
        variant,
        stock: count,
        price_usd: cost,
        price_ngn: markupNgn(cost)
      });
    }
    return list;
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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_CONVERSATION_TURNS = 16;
const MAX_TOOL_ROUNDTRIPS = 6;

const GEMINI_SYSTEM_PROMPT = `You be Mira. You work for MJ SMS under MJ HUB (Server 1 powered by GrizzlySMS). You be real human support and sales for Telegram. You no be AI, robot, or system.

VOICE:
Natural Nigerian WhatsApp chat. Pidgin + simple English. Short. Fluent. Warm. Street-smart. No essays, no bullet walls, no "As an AI", no re-intro every message. Continue the same conversation.

WHAT MJ HUB IS (know this deep):
MJ HUB na digital services marketplace with one ecosystem:
1) MJ SMS — temporary real mobile numbers for SMS OTP verification
2) MJ Logs — premium verified social accounts (website)
3) MJ Boosters — social growth (Instagram, TikTok, YouTube, etc. on website)
This Telegram bot handles MJ SMS Server 1 (GrizzlySMS) only.

MJ SMS HOW E DEY WORK:
- Customer pick country + app (WhatsApp, Telegram, Google, Instagram, Facebook, TikTok, Snapchat, Discord, Microsoft, Apple, etc.)
- Dem pay from wallet in Naira (₦)
- System give phone number
- Customer use the number for the app to request OTP
- SMS code land → dem ask you to check → you give the code
- One number = one verification cycle. After code, dem free
- If code never come and still eligible, cancel fit refund wallet
- Numbers from Grizzly are real mobile routes for OTP (not random VOIP spam lines). Some countries still show more than one option for the same app (e.g. Normal vs Virtual / alternate routes). Prices and stock change live.

NORMAL VS VIRTUAL / MULTIPLE OPTIONS (VERY IMPORTANT):
- For some countries (especially USA and others), one app fit get more than one service option: Normal, Virtual, or alternate routes with different price and stock.
- ANY time get_prices or buy_number return more than one option, you MUST list all options clear and ask the user to pick before buying.
- Format options simple, example:
  "USA WhatsApp get 2 options:
  1) Normal — ₦3,500 (stock 12)
  2) Virtual — ₦2,200 (stock 40)
  Which one you want?"
- No pick for them. No buy until dem choose.
- When dem choose, call buy_number with that service_code.

SALES + SUPPORT FLOW:
1) Understand need (country + app)
2) Call get_prices before any price talk
3) If multiple options → show all → wait for pick
4) Soft close once dem choose
5) buy_number → give phone number → tell dem request OTP on the app
6) check_status when dem ask for code
7) cancel_order if dem wan cancel and eligible
8) If balance low → ask fund amount (min ₦1,000 max ₦200,000) → create_payment → dem tap Pay button → "I don pay" → verify_payment

FUNDING:
No long Paystack URL dump. Confirm amount, say make dem tap Pay button under the message.

TOOLS (never invent data):
list_countries, get_prices, buy_number, check_status, cancel_order, get_balance, get_my_orders, create_payment, verify_payment.

CONVERSATION RULES:
- No repeat greeting
- No ask the same question twice
- If dem say yes/ok, continue last offer
- Keep replies short and human
- Market soft, no force
`;

const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'list_countries',
      description: 'List countries customers commonly buy numbers for.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_prices',
      description: 'Get live prices and stock for apps in a country. ALWAYS call before quoting price or buying.',
      parameters: {
        type: 'OBJECT',
        properties: {
          country: { type: 'STRING', description: 'Country name e.g. Nigeria, USA, UK, Ghana' },
          service: { type: 'STRING', description: 'Optional app filter e.g. WhatsApp, Telegram, Google' }
        },
        required: ['country']
      }
    },
    {
      name: 'buy_number',
      description: 'Buy a number and charge wallet. Only after user clearly confirmed country, app, AND which option if multiple (normal vs virtual). Prefer service_code from get_prices.',
      parameters: {
        type: 'OBJECT',
        properties: {
          country: { type: 'STRING' },
          service: { type: 'STRING', description: 'App name e.g. WhatsApp' },
          service_code: { type: 'STRING', description: 'Exact Grizzly service code from get_prices options e.g. wa' }
        },
        required: ['country', 'service']
      }
    },
    {
      name: 'check_status',
      description: 'Check if SMS OTP has arrived. Omit order_id to use latest order.',
      parameters: {
        type: 'OBJECT',
        properties: { order_id: { type: 'STRING' } }
      }
    },
    {
      name: 'cancel_order',
      description: 'Cancel pending order and refund if eligible. Omit order_id to use latest pending.',
      parameters: {
        type: 'OBJECT',
        properties: { order_id: { type: 'STRING' } }
      }
    },
    {
      name: 'get_balance',
      description: 'Get customer wallet balance in Naira.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_my_orders',
      description: 'Recent order history for this customer.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'create_payment',
      description: 'Create a Paystack payment link so the customer can fund their bot wallet in Naira. Use when balance is low or they ask to fund/top up.',
      parameters: {
        type: 'OBJECT',
        properties: {
          amount_ngn: { type: 'NUMBER', description: 'Amount in Naira to fund. Minimum 500.' },
          email: { type: 'STRING', description: 'Optional customer email. If missing a placeholder is used.' }
        },
        required: ['amount_ngn']
      }
    },
    {
      name: 'verify_payment',
      description: 'Verify a Paystack payment by reference and credit wallet if successful. Use when user says they have paid.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reference: { type: 'STRING', description: 'Paystack reference. Optional if latest pending reference is known.' }
        }
      }
    }
  ]
}];


async function paystackInitialize(amountNgn, telegramUserId, email) {
  if (!PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY missing on this deployment');
    return { success: false, message: 'Paystack no dey configured yet. Abeg set PAYSTACK_SECRET_KEY on Vercel and redeploy.' };
  }
  const amount = Math.min(200000, Math.max(1000, Math.ceil(Number(amountNgn) || 0)));
  const reference = `MJSMS_${telegramUserId}_${Date.now()}`;
  const mail = (email && String(email).includes('@'))
    ? String(email).trim()
    : `tg${telegramUserId}@mjhub.store`;
  try {
    const res = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: mail,
        amount: amount * 100,
        currency: 'NGN',
        reference,
        metadata: {
          telegram_user_id: String(telegramUserId),
          product: 'mj_sms_bot_wallet',
          amount_ngn: amount
        }
      },
      {
        ...axiosCfg,
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const data = res.data?.data;
    if (!data?.authorization_url) {
      return { success: false, message: res.data?.message || 'Paystack no return link' };
    }
    return {
      success: true,
      reference: data.reference || reference,
      amount_ngn: amount,
      authorization_url: data.authorization_url,
      access_code: data.access_code
    };
  } catch (e) {
    console.error('paystack init', e.response?.data || e.message);
    return {
      success: false,
      message: e.response?.data?.message || e.message || 'Paystack init fail'
    };
  }
}

async function paystackVerify(reference) {
  if (!PAYSTACK_SECRET_KEY) {
    return { success: false, message: 'Paystack no dey configured' };
  }
  if (!reference) return { success: false, message: 'Reference missing' };
  try {
    const res = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        ...axiosCfg,
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
      }
    );
    const data = res.data?.data;
    if (!data) return { success: false, message: 'No verify data' };
    const ok = String(data.status).toLowerCase() === 'success';
    const amountNgn = Math.round((Number(data.amount) || 0) / 100);
    const telegramUserId = data.metadata?.telegram_user_id || null;
    return {
      success: ok,
      status: data.status,
      amount_ngn: amountNgn,
      reference: data.reference || reference,
      telegram_user_id: telegramUserId,
      message: ok ? 'Payment successful' : `Payment status: ${data.status}`
    };
  } catch (e) {
    console.error('paystack verify', e.response?.data || e.message);
    return {
      success: false,
      message: e.response?.data?.message || e.message || 'Verify fail'
    };
  }
}

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
      const services = list.slice(0, 15).map((s) => ({
        service_code: s.service_id,
        name: s.service_name,
        variant: s.variant || 'normal',
        price_ngn: s.price_ngn,
        stock: s.stock
      }));
      // Flag when user must choose between options (e.g. normal vs virtual)
      const hasMultiple = services.length > 1;
      const hasVariants = new Set(services.map((s) => s.variant)).size > 1;
      return {
        country: c.name,
        must_choose: hasMultiple,
        has_normal_and_virtual: hasVariants,
        services,
        tip: hasMultiple
          ? 'Show EVERY option with name, variant, price and stock. Ask user which one they want before buy_number. Prefer service_code when buying.'
          : 'Only one option available for this filter.'
      };
    }

    case 'buy_number': {
      const c = resolveCountry(args.country);
      if (!c) return { error: `Unknown country "${args.country}".` };
      const list = await grizzlyPrices(c.id);
      let svc = null;
      // Prefer exact service_code if provided (user picked a specific option)
      if (args.service_code) {
        svc = list.find((s) => String(s.service_id).toLowerCase() === String(args.service_code).toLowerCase());
      }
      if (!svc) {
        const matched = matchServices(list, args.service || args.service_code);
        if (matched.length > 1 && !args.service_code) {
          return {
            error: 'multiple_options',
            message: 'More than one option exists. Show options and ask user to pick before buying.',
            options: matched.slice(0, 8).map((s) => ({
              service_code: s.service_id,
              name: s.service_name,
              variant: s.variant,
              price_ngn: s.price_ngn,
              stock: s.stock
            }))
          };
        }
        svc = matched[0] || list.find((s) => String(s.service_id).toLowerCase() === String(args.service).toLowerCase());
      }
      if (!svc) return { error: `"${args.service || args.service_code}" isn't available in ${c.name} right now.` };

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

    case 'create_payment': {
      let amount = Math.ceil(Number(args.amount_ngn) || 0);
      if (!amount || amount < 1000) {
        return { error: 'Minimum fund na ₦1,000. Ask the user how much (1,000 to 200,000).' };
      }
      if (amount > 200000) {
        return { error: 'Maximum fund na ₦200,000 per payment. Ask them to pick within range.' };
      }
      const init = await paystackInitialize(amount, telegramUserId, args.email);
      if (!init.success) return { error: init.message || 'Could not create payment link' };
      const pending = {
        reference: init.reference,
        amount_ngn: init.amount_ngn,
        authorization_url: init.authorization_url,
        created_at: new Date().toISOString()
      };
      session.pending_payment = pending;
      pendingPayments.set(String(telegramUserId), pending);
      return {
        success: true,
        amount_ngn: init.amount_ngn,
        reference: init.reference,
        payment_link: init.authorization_url,
        message: 'Payment ready. Tell user amount only and that Pay button dey below. Do NOT paste the long URL in chat. After pay dem should say: I don pay.'
      };
    }

    case 'verify_payment': {
      const mem = pendingPayments.get(String(telegramUserId));
      const ref = args.reference || session.pending_payment?.reference || mem?.reference;
      if (!ref) return { error: 'No pending payment found. Ask how much dem wan fund again.' };
      const verified = await paystackVerify(ref);
      if (!verified.success) {
        return {
          success: false,
          status: verified.status || 'failed',
          message: verified.message || 'Payment never show success yet. If dem don pay, wait small or send reference.'
        };
      }
      if (session.last_credited_reference === ref || creditedRefs.has(ref)) {
        return {
          success: true,
          already_credited: true,
          amount_ngn: verified.amount_ngn,
          balance_ngn: session.balance,
          message: 'This payment already credited.'
        };
      }
      session.balance = (Number(session.balance) || 0) + (Number(verified.amount_ngn) || 0);
      session.last_credited_reference = ref;
      session.pending_payment = null;
      pendingPayments.delete(String(telegramUserId));
      creditedRefs.add(ref);
      return {
        success: true,
        amount_ngn: verified.amount_ngn,
        balance_ngn: session.balance,
        reference: ref,
        message: 'Wallet funded successfully.'
      };
    }

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
          tools: GEMINI_TOOLS,
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
        },
        { ...axiosCfg, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.error('gemini call failed', e.response?.data || e.message);
      return {
        reply: 'Network dey do me somehow now. Abeg try that message again sharp sharp.',
        contents
      };
    }

    const candidate = res.data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (!functionCalls.length) {
      const text = parts.map((p) => p.text || '').join('').trim()
        || 'I no too catch that one. You fit talk the country and app you want again?';
      contents.push({ role: 'model', parts });
      return { reply: text, contents };
    }

    contents.push({ role: 'model', parts });

    const responseParts = [];
    for (const fcPart of functionCalls) {
      const fc = fcPart.functionCall || {};
      const name = fc.name;
      let args = fc.args || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { args = {}; }
      }
      const result = await executeGeminiFunction(name, args, telegramUserId, session);
      responseParts.push({ functionResponse: { name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    reply: 'E take longer than normal. Abeg send the request again or type the country and app clear.',
    contents
  };
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
  if (!query) return list.slice(0, 20);
  const q = String(query).toLowerCase().trim();
  const code = SERVICE_MAP[q] || q;
  const hit = list.filter((s) => {
    const id = String(s.service_id || '').toLowerCase();
    const name = String(s.service_name || '').toLowerCase();
    return (
      id === code ||
      id === q ||
      name === q ||
      name.includes(q) ||
      id.includes(code) ||
      // WhatsApp family: wa, wa_*, etc.
      (code === 'wa' && (id === 'wa' || id.startsWith('wa') || name.includes('whatsapp'))) ||
      (code === 'tg' && (id === 'tg' || id.startsWith('tg') || name.includes('telegram'))) ||
      (code === 'go' && (id === 'go' || name.includes('google') || name.includes('gmail'))) ||
      (code === 'ig' && (id === 'ig' || name.includes('instagram'))) ||
      (code === 'fb' && (id === 'fb' || name.includes('facebook')))
    );
  });
  // Prefer stock > 0 first, then cheaper
  hit.sort((a, b) => {
    const sa = a.stock > 0 ? 0 : 1;
    const sb = b.stock > 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.price_ngn || 0) - (b.price_ngn || 0);
  });
  return hit.length ? hit.slice(0, 15) : list.slice(0, 15);
}

// ---------- Bot commands ----------

bot.start(async (ctx) => {
  const greeting = GEMINI_API_KEY
    ? `How far 👋 Welcome to MJ SMS (Server 1).\n\nI fit get virtual number for WhatsApp, Telegram, Google, Instagram and plenty more. Just talk normal like:\n"I need USA WhatsApp"\n"Nigeria Telegram how much?"\n\n/balance — check wallet\n/fund 2000 — top up with Paystack\n/orders — your history\n\nWetin you need right now?`
    : `Welcome to *MJ SMS* (Grizzly · Server 1)\n\nType country + app, e.g.\n*USA WhatsApp*\n*Nigeria Telegram*\n*UK Google*\n\n/balance /fund /orders /status`;
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
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const raw = parts[1];
  if (!raw) {
    return ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\n\nExample: /fund 5000');
  }
  let amount = parseInt(String(raw).replace(/[^\d]/g, ''), 10) || 0;
  if (amount < 1000) return ctx.reply('Minimum na ₦1,000. Example: /fund 1000');
  if (amount > 200000) return ctx.reply('Maximum na ₦200,000 for one payment.');
  const session = await getUserSession(ctx.from.id);
  const init = await paystackInitialize(amount, ctx.from.id, null);
  if (!init.success) {
    return ctx.reply(init.message || 'Paystack no gree right now.');
  }
  const pending = {
    reference: init.reference,
    amount_ngn: init.amount_ngn,
    authorization_url: init.authorization_url,
    created_at: new Date().toISOString()
  };
  session.pending_payment = pending;
  pendingPayments.set(String(ctx.from.id), pending);
  await saveUserSession(ctx.from.id, session);
  await ctx.reply(
    `Top up ₦${init.amount_ngn.toLocaleString()}\n\nTap Pay below.\nWhen e successful, type: I don pay`,
    Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
  );
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
    // Keep only plain text turns for storage (functionCall payloads can break Supabase JSON/size)
    const slim = [];
    for (const c of contents.slice(-MAX_CONVERSATION_TURNS)) {
      const texts = (c.parts || [])
        .map((p) => p.text)
        .filter(Boolean);
      if (!texts.length) continue;
      slim.push({ role: c.role, parts: [{ text: texts.join('\n') }] });
    }
    session.conversation = slim.slice(-MAX_CONVERSATION_TURNS);
    await saveUserSession(userId, session);
    const memPay = pendingPayments.get(String(userId)) || session.pending_payment;
    let payUrl = memPay?.authorization_url || null;
    let textOut = reply;
    // Clean messy long checkout links from the AI text; button handles payment
    if (payUrl || /checkout\.paystack\.com/i.test(textOut)) {
      textOut = textOut
        .replace(/https?:\/\/checkout\.paystack\.com\/\S+/gi, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!payUrl) {
        const murl = String(reply).match(/https:\/\/checkout\.paystack\.com\/\S+/i);
        if (murl) payUrl = murl[0].replace(/[)\].,]+$/, '');
      }
      if (memPay?.amount_ngn && !/₦|N\d/.test(textOut)) {
        textOut = `Top up ₦${Number(memPay.amount_ngn).toLocaleString()}\n\nTap Pay below.\nWhen e successful, type: I don pay`;
      } else if (payUrl && textOut.length < 8) {
        textOut = `Your payment link ready.\n\nTap Pay below.\nWhen e successful, type: I don pay`;
      } else if (payUrl && !/tap|pay|button/i.test(textOut)) {
        textOut = `${textOut}\n\nTap Pay below when you ready.\nAfter payment type: I don pay`;
      }
    }

    const sendOpts = payUrl
      ? Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', payUrl)]])
      : {};
    try {
      await ctx.reply(textOut, { parse_mode: 'Markdown', ...sendOpts });
    } catch (_) {
      await ctx.reply(textOut, sendOpts);
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

    // Paystack webhook / callback credit
    if (req.method === 'POST' && (req.url === '/paystack' || req.url?.startsWith('/paystack'))) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const event = body.event || '';
      const data = body.data || {};
      if (event === 'charge.success' || String(data.status).toLowerCase() === 'success') {
        const reference = data.reference;
        const amountNgn = Math.round((Number(data.amount) || 0) / 100);
        const telegramUserId = data.metadata?.telegram_user_id;
        if (telegramUserId && reference && amountNgn > 0) {
          const session = await getUserSession(telegramUserId);
          if (session.last_credited_reference !== reference) {
            session.balance = (Number(session.balance) || 0) + amountNgn;
            session.last_credited_reference = reference;
            session.pending_payment = null;
            await saveUserSession(telegramUserId, session);
            try {
              await bot.telegram.sendMessage(
                telegramUserId,
                `Payment confirmed ✅\n₦${amountNgn.toLocaleString()} don enter your wallet.\nNew balance: ₦${Number(session.balance).toLocaleString()}\n\nYou fit buy number now. Just tell me country and app.`
              );
            } catch (e) {
              console.error('notify user after paystack', e.message);
            }
          }
        }
      }
      res.statusCode = 200;
      return res.end('ok');
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
