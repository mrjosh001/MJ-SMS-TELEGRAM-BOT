/**
 * MJ SMS Telegram Bot v3 — Server 1 (Grizzly) + Server 2 (SMS-Bus)
 * Vercel serverless webhook. Money/orders live in Postgres (bot_* tables) and change only
 * through atomic SQL functions — see lib/wallet.js and supabase/migrations.
 */
const { Telegraf, Markup } = require('telegraf');
const wallet = require('../lib/wallet');
const paystack = require('../lib/paystack');
const catalog = require('../lib/catalog');
const gemini = require('../lib/gemini');
const { providers, byServer, grizzly, smsbus } = require('../lib/providers');
const U = require('../lib/util');
const { COUNTRY_MAP, SERVICE_MAP, money, ngn, sleep, esc, parseNaira, formatWait } = U;

let waitUntil = (p) => { Promise.resolve(p).catch(() => {}); };
try { waitUntil = require('@vercel/functions').waitUntil; } catch (_) { /* optional dependency */ }

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SUPPORT_WA = (process.env.SUPPORT_WA || '14305583021').replace(/[^0-9]/g, '');
const SUPPORT_TG = process.env.SUPPORT_TG || 'https://t.me/mj_hub_tg';
const SUPPORT_SITE = process.env.SUPPORT_SITE || 'https://mjhub.store';
if (!BOT_TOKEN) console.error('BOT_TOKEN missing');

const bot = new Telegraf(BOT_TOKEN || 'missing');
const md = { parse_mode: 'Markdown' };
const safe = (s) => String(s ?? '').replace(/[_*`\[\]]/g, ' ');
const isAdmin = (ctx) => ADMIN_ID && String(ctx.from?.id) === ADMIN_ID;
const mins = (ms) => Math.round(ms / 60000);

const APPS = [['WhatsApp', 'wa'], ['Telegram', 'tg'], ['Google', 'go'], ['Instagram', 'ig'], ['Facebook', 'fb'], ['TikTok', 'lf'], ['Snapchat', 'fu'], ['Discord', 'ds']];
const COUNTRIES = ['USA', 'UK', 'Canada', 'Nigeria', 'Ghana', 'Kenya'];

const menuKb = Markup.inlineKeyboard([
  [Markup.button.callback('🛍 Open shop', 'menu:buy'), Markup.button.callback('💰 Wallet & deposit', 'menu:wallet')],
  [Markup.button.callback('📦 My history', 'menu:orders'), Markup.button.callback('🆘 Support & help', 'menu:support')]
]);

const MSG = {
  greet: 'How far 👋 Welcome to *MJ SMS*.\nI be *Mira* — I go help you get *real number* for verification.\n\n' +
    'Type country + app, e.g.\n• *USA WhatsApp*\n• *UK Telegram*\n• *Canada Instagram*\n\n' +
    'We get *two servers* — I go show you both prices.\n\n/balance · /fund 2k · /orders · /support',
  noStock: 'That one no dey available right now o. You fit try another country or app?',
  fallback: 'I no too catch that one o.\n\nTry:\n• *USA WhatsApp* — buy number\n• *Fund 5k* — top up\n• *Balance* — check wallet\n• *Orders* — your numbers',
  walletDown: 'Wallet service no gree answer small. Abeg try again in a minute. Nothing was charged.'
};

// ------------------------------------------------------------------ session (chat state only)
async function S(ctx) { return wallet.getSession(ctx.from.id); }
const save = (ctx, s) => wallet.saveSession(ctx.from.id, s);
const clearFlow = (s) => { s.state = null; s.country = null; s.service = null; return s; };

// ------------------------------------------------------------------ orders: OTP / expiry / refund
/** Look at the supplier once and move the order forward. Safe to call repeatedly. */
async function settleOrder(order) {
  const p = providers[order.provider];
  if (order.code) return { state: 'code', code: order.code, fresh: false };
  if (order.refunded) return { state: 'refunded' };
  const st = await p.status(order.order_id);
  if (st.state === 'code') {
    const r = await wallet.completeOrder(p.id, order.order_id, st.code);
    return r.delivered ? { state: 'code', code: st.code, fresh: true } : { state: 'refunded' };
  }
  if (st.state === 'expired') {
    const r = await wallet.refundOrder(p.id, order.order_id, 'expired');
    return { state: 'refunded', refund: r };
  }
  const age = Date.now() - new Date(order.created_at).getTime();
  if (age >= p.expiryMs) {
    const c = await p.cancel(order.order_id);
    if (c.ok) {
      const r = await wallet.refundOrder(p.id, order.order_id, 'expired');
      return { state: 'refunded', refund: r };
    }
  }
  return { state: 'waiting' };
}

async function sendCode(userId, order, code) {
  try {
    await bot.telegram.sendMessage(userId,
      `Your code don drop ✅\n\n*${safe(code)}*\n\n${p2(order)} · \`${order.order_id}\`\nCopy sharp. You need another number?`, md);
  } catch (e) { console.error('sendCode', e.message); }
}
const p2 = (o) => providers[o.provider].label;

/** After a purchase, keep checking for ~55s so the code is pushed without a tap. */
async function pollOrder(order) {
  for (let i = 0; i < 11; i++) {
    await sleep(5000);
    try {
      const fresh = (await wallet.getOrder(order.provider, order.order_id)) || order;
      const r = await settleOrder(fresh);
      if (r.state === 'code') { if (r.fresh) await sendCode(order.user_id, order, r.code); return; }
      if (r.state === 'refunded') {
        if (r.refund?.refunded) {
          await bot.telegram.sendMessage(order.user_id, `No code came, so I don refund you ✅\n${ngn(r.refund.amount)} back · Balance: ${ngn(r.refund.balance)}`);
        }
        return;
      }
    } catch (e) { console.error('poll', e.message); }
  }
}

// ------------------------------------------------------------------ buying
async function showOptions(ctx, s, countryText, code) {
  const appName = U.SERVICE_NAMES[code] || code.toUpperCase();
  await ctx.reply(`Checking ${countryText} · ${appName}…`);
  let res;
  try { res = await catalog.options(countryText, code); }
  catch (e) { console.error('options', e.message); return ctx.reply('Prices no gree load now. Try again in a moment.'); }
  clearFlow(s); await save(ctx, s);
  if (!res.list.length) return ctx.reply(MSG.noStock);

  const rows = res.list.slice(0, 10).map((o) => {
    const pool = o.countryName && o.server === 1 && /\(2\)/.test(o.countryName) ? ` ${o.countryName}` : '';
    const label = `${o.provider === 'smsbus' ? 'S2' : 'S1'}${pool} · ${o.serviceName} · ${ngn(o.price)}`;
    return [Markup.button.callback(label.slice(0, 60), `b:${o.server}:${o.countryId}:${o.serviceId}:${o.price}`.slice(0, 64))];
  });
  rows.push([Markup.button.callback('❌ Cancel', 'opt:cancel')]);
  return ctx.reply(`*${safe(res.country)}* · ${safe(appName)}\nS1 = Server 1 · S2 = Server 2 (different stock and price).\nPick one:`,
    { ...md, ...Markup.inlineKeyboard(rows) });
}

async function refundFailedBuy(userId, price, ref) {
  for (let i = 0; i < 3; i++) {
    try { await wallet.credit(userId, price, 'refund', `buyfail:${ref}`); return true; } catch (e) { await sleep(500); }
  }
  console.error('CRITICAL refund after failed buy NOT applied', userId, price, ref);
  return false;
}

async function purchase(ctx, opt) {
  const userId = ctx.from.id;
  const p = byServer[opt.server];
  const ref = `${p.id}:${userId}:${Date.now()}`;

  let d;
  try { d = await wallet.debit(userId, opt.price, 'purchase', ref, { service: opt.serviceId, country: opt.countryId }); }
  catch (e) { console.error('debit', e.message); return ctx.reply(MSG.walletDown); }
  if (!d.ok) {
    return ctx.reply(`Balance no reach o.\nYou need ${ngn(opt.price)} · you get ${ngn(d.balance)}.`,
      Markup.inlineKeyboard([[Markup.button.callback(`💳 Fund ${ngn(Math.max(1000, opt.price - d.balance))}`, `fund:${Math.max(1000, opt.price - d.balance)}`)]]));
  }

  await ctx.reply('I dey grab the number… hold on.');
  const bought = await p.buy(opt.serviceId, opt.countryId);
  if (!bought.ok) {
    const ok = await refundFailedBuy(userId, opt.price, ref);
    return ctx.reply(`${bought.message || 'No number available.'}\n${ok ? 'You no pay anything — wallet restored.' : 'If your balance dey short, contact /support.'}`);
  }

  const order = {
    user_id: String(userId), provider: p.id, order_id: bought.orderId, service_id: opt.serviceId,
    service_name: opt.serviceName, country_id: opt.countryId, country_name: opt.countryName || null,
    phone: bought.number, price: opt.price, status: 'waiting', expires_at: new Date(Date.now() + p.expiryMs).toISOString()
  };
  await wallet.createOrder(order);
  const bal = await wallet.balance(userId).catch(() => d.balance);
  const phone = String(bought.number || '');
  await ctx.reply(
    `Number ready ✅  _(${p.label})_\n📞 \`${phone}\`\n🆔 \`${bought.orderId}\`\n${ngn(opt.price)} debited · Balance: ${ngn(bal)}\n\n` +
    `Use am for the app to request OTP. I go send the code here — or tap Check.\n_Cancel opens after ~${Math.max(1, mins(p.cancelMinMs))} min. ` +
    `${p.id === 'smsbus' ? 'This number expires in 5 min.' : ''}_`,
    {
      ...md,
      ...Markup.inlineKeyboard([
        [{ text: '📋 Copy number', copy_text: { text: phone } }],
        [Markup.button.callback('Check SMS code', `chk:${p.id}:${bought.orderId}`)],
        [Markup.button.callback(`⏳ Cancel (after ${Math.max(1, mins(p.cancelMinMs))}m)`, `can:${p.id}:${bought.orderId}`)]
      ])
    });
  waitUntil(pollOrder({ ...order, created_at: new Date().toISOString() }));
}

bot.action(/^b:([12]):([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const [, srv, cid, sid, shown] = ctx.match;
  let fresh;
  try { fresh = await catalog.quote(Number(srv), cid, sid); } catch (e) { return ctx.reply('Prices no gree load now. Try again.'); }
  if (!fresh) return ctx.reply('That option no dey available again. Pick another one.');
  if (fresh.price !== Number(shown)) {
    return ctx.reply(`Price don change to ${ngn(fresh.price)} (was ${ngn(shown)}). You still want am?`,
      Markup.inlineKeyboard([[Markup.button.callback(`✅ Buy · ${ngn(fresh.price)}`, `b:${srv}:${cid}:${sid}:${fresh.price}`.slice(0, 64))], [Markup.button.callback('❌ Cancel', 'opt:cancel')]]));
  }
  return purchase(ctx, fresh);
});

bot.action('opt:cancel', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Alright, cancelled. Wetin you need instead?'); });

// ------------------------------------------------------------------ OTP check + cancel
async function ownOrder(ctx, provider, orderId) {
  const o = await wallet.getOrder(provider, orderId);
  return o && String(o.user_id) === String(ctx.from.id) ? o : null;
}

bot.action(/^chk:(grizzly|smsbus):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking…');
  const order = await ownOrder(ctx, ctx.match[1], ctx.match[2]);
  if (!order) return ctx.reply('I no see that order.');
  const r = await settleOrder(order);
  if (r.state === 'code') return ctx.reply(`Code: *${safe(r.code)}*`, md);
  if (r.state === 'refunded') return ctx.reply(r.refund?.refunded ? `No code came — refunded ✅ Balance: ${ngn(r.refund.balance)}` : 'This order don close and refund.');
  return ctx.reply('Still waiting for SMS… tap Check again in a few seconds.');
});

bot.action(/^can:(grizzly|smsbus):([^:]+)$/, async (ctx) => {
  const [, provider, orderId] = ctx.match;
  const order = await ownOrder(ctx, provider, orderId);
  if (!order) { await ctx.answerCbQuery(); return ctx.reply('I no see that order.'); }
  const p = providers[provider];
  if (order.refunded) { await ctx.answerCbQuery(); return ctx.reply('This order already cancelled.'); }
  if (order.code) { await ctx.answerCbQuery(); return ctx.reply('Code already arrive — cancel no dey available.'); }

  const age = Date.now() - new Date(order.created_at).getTime();
  if (age < p.cancelMinMs) {
    const left = formatWait(Math.ceil((p.cancelMinMs - age) / 1000));
    return ctx.answerCbQuery(`⏳ Cancel opens in ${left}`, { show_alert: true });
  }
  await ctx.answerCbQuery('Cancelling…');

  const last = await settleOrder(order);               // never refund if the SMS already came
  if (last.state === 'code') return ctx.reply(`A code just arrive: *${safe(last.code)}* — cancel no dey available.`, md);
  if (last.state === 'refunded') return ctx.reply(last.refund?.refunded ? `Cancelled ✅ ${ngn(last.refund.amount)} refunded · Balance: ${ngn(last.refund.balance)}` : 'This order already cancelled.');

  const c = await p.cancel(orderId);
  if (!c.ok) return ctx.reply(`${c.message}\n\nNo refund yet — order still active.`);
  const r = await wallet.refundOrder(provider, orderId, 'cancelled');
  return ctx.reply(r.refunded
    ? `Cancelled ✅\n${ngn(r.amount)} refunded.\nBalance: ${ngn(r.balance)}`
    : `This order already cancelled.\nBalance: ${ngn(r.balance)}`);
});

// ------------------------------------------------------------------ funding
async function startFund(ctx, s, amount) {
  if (amount < paystack.MIN_FUND) { s.state = 'AWAITING_FUND'; await save(ctx, s); return ctx.reply('Minimum na ₦1,000. Example: *2k* or *5000*', md); }
  if (amount > paystack.MAX_FUND) { s.state = 'AWAITING_FUND'; await save(ctx, s); return ctx.reply('Maximum na ₦200,000 per payment. Example: *50k*', md); }
  const init = await paystack.initialize(amount, ctx.from.id, null);
  if (!init.success) return ctx.reply(init.message || 'Paystack no gree right now.');
  s.state = null;
  s.pending_payment = { reference: init.reference, amount_ngn: init.amount_ngn, created_at: new Date().toISOString() };
  await save(ctx, s);
  return ctx.reply(`Top up *${ngn(init.amount_ngn)}*\n\nTap *Pay* below. When e successful, type: *I don pay*\n_(Your wallet also updates by itself.)_`,
    { ...md, ...Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]]) });
}

async function confirmPayment(ctx, s, ref) {
  const v = await paystack.verify(ref);
  if (!v.success) return ctx.reply(v.message === 'Payment successful' ? 'Could not verify.' : `${v.message}\nIf you don pay, wait 30 seconds and type: I don pay`);
  if (v.telegram_user_id !== String(ctx.from.id)) return ctx.reply('That payment belongs to a different account.');
  const c = await wallet.credit(ctx.from.id, v.amount_ngn, 'fund', v.reference);
  if (s.pending_payment?.reference === v.reference) { s.pending_payment = null; await save(ctx, s); }
  return ctx.reply(c.applied
    ? `Payment confirmed ✅\n${ngn(v.amount_ngn)} don enter your wallet.\nNew balance: ${ngn(c.balance)}\n\nTell me country + app to buy.`
    : `This payment already credited.\nBalance: ${ngn(c.balance)}`);
}

// ------------------------------------------------------------------ commands + menu
bot.start(async (ctx) => ctx.reply(MSG.greet, { ...md, ...menuKb }));
bot.command(['balance', 'bal'], async (ctx) => {
  try { await ctx.reply(`Balance: *${ngn(await wallet.balance(ctx.from.id))}*`, md); } catch (e) { await ctx.reply(MSG.walletDown); }
});
bot.command('fund', async (ctx) => {
  const s = await S(ctx);
  const raw = (ctx.message.text || '').trim().split(/\s+/)[1];
  if (!raw) { s.state = 'AWAITING_FUND'; await save(ctx, s); return ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\nExample: 5000'); }
  return startFund(ctx, s, parseNaira(raw));
});

async function sendOrders(ctx) {
  let list;
  try { list = await wallet.listOrders(ctx.from.id, 8); } catch (e) { return ctx.reply(MSG.walletDown); }
  if (!list.length) return ctx.reply('No orders yet.\n\nType e.g. *USA WhatsApp* to buy.', md);
  for (const o of list.filter((x) => x.status === 'waiting').slice(0, 3)) {   // catch up expired/OTP in the background of the listing
    try { const r = await settleOrder(o); if (r.state === 'code') { o.code = r.code; o.status = 'completed'; } else if (r.state === 'refunded') { o.status = 'expired'; o.refunded = true; } } catch (_) {}
  }
  const lines = list.map((o, i) =>
    `*${i + 1}. ${safe(o.service_name || o.service_id)}* _(${p2(o)})_\n📞 \`${o.phone || '—'}\`\n${ngn(o.price)} · ${o.code ? `Code: ${safe(o.code)}` : (o.refunded ? 'Refunded' : o.status)}`).join('\n\n');
  return ctx.reply(`*Your recent orders*\n\n${lines}`, md);
}
bot.command('orders', sendOrders);

bot.command('support', async (ctx) => {
  const pre = encodeURIComponent(`Hello MJ Hub support, I need help on MJ SMS Telegram bot.\nTelegram: @${ctx.from.username || 'n/a'} (id ${ctx.from.id})`);
  return ctx.reply('*MJ SMS Support*\n\nNeed human? Same channels as *mjhub.store*:', {
    ...md,
    ...Markup.inlineKeyboard([
      [Markup.button.url('💬 WhatsApp Support', `https://wa.me/${SUPPORT_WA}?text=${pre}`)],
      [Markup.button.url('✈️ Telegram Support', SUPPORT_TG)],
      [Markup.button.url('🌐 MJ Hub website', SUPPORT_SITE)]
    ])
  });
});
bot.command('privacy', (ctx) => ctx.reply(
  '*MJ SMS Privacy*\n\n• We use your Telegram ID to run your wallet and orders.\n• Numbers you buy are for your OTP use; we do not sell your chat data.\n• Payments run through Paystack.\n• Order history is stored so you can check numbers and status.\n• Help: /support · mjhub.store', md));

bot.command('status', async (ctx) => {          // admin: supplier health
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const [g, b] = await Promise.all([grizzly.balance(), smsbus.balance()]);
  return ctx.reply(`Server 1: ${g == null ? 'OFFLINE' : `online · balance ${g}`}\nServer 2: ${b == null ? 'OFFLINE' : `online · balance ${b}`}`);
});
bot.command('stats', async (ctx) => {           // admin: business numbers
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  try {
    const x = await wallet.stats();
    return ctx.reply(`Users: ${x.users}\nWallet money held: ${ngn(x.held)}\nOrders: ${x.orders} (${x.done} delivered)\nDelivered sales: ${ngn(x.sales)}`);
  } catch (e) { return ctx.reply(`Stats failed: ${e.message}`); }
});

async function openShop(ctx) {
  const rows = []; for (let i = 0; i < COUNTRIES.length; i += 2) rows.push(COUNTRIES.slice(i, i + 2).map((c) => Markup.button.callback(c, `cty:${c}`)));
  return ctx.reply('🛍 *Shop*\nPick a country (or just type e.g. *France Telegram*):', { ...md, ...Markup.inlineKeyboard(rows) });
}
async function openWallet(ctx) {
  let bal;
  try { bal = await wallet.balance(ctx.from.id); } catch (e) { return ctx.reply(MSG.walletDown); }
  return ctx.reply(`💰 *Wallet*\nBalance: *${ngn(bal)}*\n\nTop up with Paystack:`, {
    ...md,
    ...Markup.inlineKeyboard([
      [1000, 2000, 5000].map((a) => Markup.button.callback(ngn(a), `fund:${a}`)),
      [10000, 20000, 50000].map((a) => Markup.button.callback(ngn(a), `fund:${a}`)),
      [Markup.button.callback('✏️ Other amount', 'menu:fund')]
    ])
  });
}
bot.command('shop', openShop);
bot.command('wallet', openWallet);
bot.action('menu:buy', async (ctx) => { await ctx.answerCbQuery(); return openShop(ctx); });
bot.action(/^cty:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = await S(ctx); s.country = ctx.match[1]; s.state = 'AWAITING_APP'; await save(ctx, s);
  const rows = []; for (let i = 0; i < APPS.length; i += 2) rows.push(APPS.slice(i, i + 2).map(([n, c]) => Markup.button.callback(n, `app:${c}`)));
  return ctx.reply(`Country: *${safe(s.country)}*\n\nWhich app?`, { ...md, ...Markup.inlineKeyboard(rows) });
});
bot.action(/^app:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery('Loading…');
  const s = await S(ctx);
  if (!s.country) return ctx.reply('Pick a country first: type e.g. *USA WhatsApp*', md);
  return showOptions(ctx, s, s.country, ctx.match[1]);
});
bot.action(['menu:wallet', 'menu:bal'], async (ctx) => { await ctx.answerCbQuery(); return openWallet(ctx); });
bot.action('menu:orders', async (ctx) => { await ctx.answerCbQuery(); return sendOrders(ctx); });
bot.action('menu:support', async (ctx) => { await ctx.answerCbQuery(); return ctx.reply('Type /support to reach a human.'); });
bot.action('menu:fund', async (ctx) => {
  await ctx.answerCbQuery(); const s = await S(ctx); s.state = 'AWAITING_FUND'; await save(ctx, s);
  return ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\nExample: 5000');
});
bot.action(/^fund:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); return startFund(ctx, await S(ctx), Number(ctx.match[1])); });

// ------------------------------------------------------------------ free text
const GREETING = /^(hi|hello|hey|yo|awfa|how far|good (morning|evening|afternoon)|sup|mira|thanks|thank you|ok|okay|alright)\b/i;
const FUND_WORDS = /\b(fund|top\s*up|topup|deposit|recharge|add\s*money|load\s*wallet)\b/i;
const BAL_WORDS = /\b(balance|how\s*much\s*(i\s*get|dey|left)|my\s*balance|wallet\s*balance)\b/i;
const ORDER_WORDS = /\b(orders?|history|my\s*numbers?)\b/i;
const PAID = /^(i\s*don\s*pay|i\s*have\s*paid|i\s*paid|payment\s*done|don\s*pay|paid)\b/i;

/** Pull { code, country } out of a short message like "USA WhatsApp". */
async function parseRequest(text) {
  const t = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  if (!t || words.length > 6) return {};
  let code = null, country = null;
  for (const [name, c] of Object.entries(SERVICE_MAP).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${esc(name)}\\b`).test(t)) { code = c; break; }
  }
  for (const name of Object.keys(COUNTRY_MAP).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${esc(name)}\\b`).test(t)) { country = name; break; }
  }
  if (!country) {
    try {
      for (const name of (await catalog.knownCountryNames()).sort((a, b) => b.length - a.length)) {
        if (new RegExp(`\\b${esc(name.toLowerCase())}\\b`).test(t)) { country = name; break; }
      }
    } catch (_) {}
  }
  return { code, country };
}

async function miraTools(ctx, name, args, box) {
  const userId = ctx.from.id;
  if (name === 'get_prices') {
    const code = SERVICE_MAP[String(args.service || '').toLowerCase().trim()];
    if (!code) return { error: `Unknown app "${args.service}". Ask which app (WhatsApp, Telegram, Instagram, Google, Facebook, TikTok...).` };
    const res = await catalog.options(String(args.country || ''), code);
    if (!res.list.length) return { error: `Nothing available for ${args.country} ${args.service} right now.` };
    box.opts = { country: res.country, code, list: res.list };
    return { country: res.country, note: 'Buy buttons will be shown to the customer. Tell them to tap one.',
      options: res.list.slice(0, 10).map((o) => ({ server: o.server, name: o.serviceName, price_ngn: o.price, stock: o.stock })) };
  }
  if (name === 'get_balance') return { balance_ngn: await wallet.balance(userId) };
  if (name === 'get_my_orders') return { orders: (await wallet.listOrders(userId, 8)).map((o) => ({ order_id: o.order_id, server: providers[o.provider].server, service: o.service_name, phone: o.phone, price_ngn: o.price, status: o.refunded ? 'refunded' : o.status, code: o.code })) };
  if (name === 'check_status') {
    const list = await wallet.listOrders(userId, 5);
    const order = args.order_id ? list.find((o) => o.order_id === String(args.order_id)) : list.find((o) => o.status === 'waiting') || list[0];
    if (!order) return { error: 'No recent order found.' };
    const r = await settleOrder(order);
    if (r.state === 'code' && r.fresh) return { order_id: order.order_id, code: r.code };
    return { order_id: order.order_id, state: r.state, code: r.code || null, refunded_ngn: r.refund?.refunded ? r.refund.amount : undefined };
  }
  return { error: `Unknown tool ${name}` };
}

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (!text || text.startsWith('/')) return;
  const lower = text.toLowerCase();
  const s = await S(ctx);

  // payment confirmation (button-free): "I don pay" or a pasted reference
  const refMatch = text.match(/MJSMS_\d+_\d+/);
  if (PAID.test(lower) || refMatch) {
    const ref = refMatch ? refMatch[0] : s.pending_payment?.reference;
    if (!ref) return ctx.reply('I no see any pending payment. Type /fund 2000 first, pay, then come back.');
    return confirmPayment(ctx, s, ref);
  }

  // funding amount
  const onlyAmount = /^(?:₦|ngn|naira)?\s*\d+(?:[.,]\d+)?\s*(?:k|thousand)?\s*$/i.test(text);
  if (s.state === 'AWAITING_FUND' || (onlyAmount && parseNaira(text) >= 1000 && parseNaira(text) <= paystack.MAX_FUND)) {
    return startFund(ctx, s, parseNaira(text));
  }
  if (FUND_WORDS.test(lower)) {
    const a = parseNaira(text);
    if (a >= 1000) return startFund(ctx, s, a);
    s.state = 'AWAITING_FUND'; await save(ctx, s);
    return ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\nExample: *2k* · *5k* · *5000*', md);
  }
  if (/^(cancel|stop|reset|start over|never mind)$/i.test(lower)) { clearFlow(s); await save(ctx, s); return ctx.reply('Alright, e clear. Wetin you need now?', menuKb); }
  if (BAL_WORDS.test(lower)) { try { return ctx.reply(`Your balance na *${ngn(await wallet.balance(ctx.from.id))}* 💰`, md); } catch (e) { return ctx.reply(MSG.walletDown); } }
  if (ORDER_WORDS.test(lower) && text.split(/\s+/).length <= 4) return sendOrders(ctx);
  if (/^(help|menu)$/i.test(lower)) return ctx.reply(MSG.greet, { ...md, ...menuKb });

  // "<country> <app>" and its half-finished variants
  const req = await parseRequest(text);
  if (req.country && req.code) return showOptions(ctx, s, req.country, req.code);
  if (req.country && !req.code) {
    if (s.service) return showOptions(ctx, s, req.country, s.service);
    s.country = req.country; s.state = 'AWAITING_APP'; await save(ctx, s);
    return ctx.reply(`Which app for *${safe(req.country)}*?\nWhatsApp, Telegram, Instagram, TikTok, Google…`, md);
  }
  if (req.code && !req.country) {
    if (s.country) return showOptions(ctx, s, s.country, req.code);
    s.service = req.code; s.state = 'AWAITING_COUNTRY'; await save(ctx, s);
    return ctx.reply(`Which country for *${safe(U.SERVICE_NAMES[req.code] || req.code)}*?\nExample: USA, UK, Nigeria, Canada`, md);
  }

  // everything else: Mira (read-only tools) or a short canned reply
  if (process.env.GEMINI_API_KEY && !GREETING.test(lower)) {
    const box = {};
    const r = await gemini.chat(s.conversation, text, (n, a) => miraTools(ctx, n, a, box));
    if (r.history) { s.conversation = r.history; await save(ctx, s); }
    if (r.reply) {
      if (box.opts) {
        const rows = box.opts.list.slice(0, 10).map((o) => [Markup.button.callback(
          `${o.provider === 'smsbus' ? 'S2' : 'S1'} · ${o.serviceName} · ${ngn(o.price)}`.slice(0, 60), `b:${o.server}:${o.countryId}:${o.serviceId}:${o.price}`.slice(0, 64))]);
        rows.push([Markup.button.callback('❌ Cancel', 'opt:cancel')]);
        return ctx.reply(r.reply.slice(0, 3500), Markup.inlineKeyboard(rows));
      }
      return ctx.reply(r.reply.slice(0, 3500));
    }
  }
  if (GREETING.test(lower)) return ctx.reply('How far 👋 I dey.\nYou need *number*, *fund* wallet, or check *balance*?', { ...md, ...menuKb });
  return ctx.reply(MSG.fallback, md);
});

bot.catch((err) => console.error('bot error', err));

// ------------------------------------------------------------------ HTTP handler
const readBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
const send = (res, code, body, type = 'text/plain') => { res.statusCode = code; res.setHeader('Content-Type', type); return res.end(body); };

module.exports = async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const base = `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;
    const u = new URL(base + (req.url || '/'));
    // vercel.json rewrites tag the route in ?route=...; plain paths work too
    const path = (u.searchParams.get('route') || u.pathname).replace(/^\/+|\/+$/g, '') || '/';

    if (req.method === 'GET' && path.startsWith('setup-webhook')) {
      if (!BOT_TOKEN) return send(res, 500, 'BOT_TOKEN missing');
      if (!WEBHOOK_SECRET) return send(res, 503, 'Set WEBHOOK_SECRET in Vercel first, then open this URL again with ?secret=YOUR_SECRET');
      if (u.searchParams.get('secret') !== WEBHOOK_SECRET) return send(res, 401, 'Unauthorized');
      await bot.telegram.setWebhook(`${base}/api`, { drop_pending_updates: true, secret_token: WEBHOOK_SECRET });
      const menu = [
        { command: 'start', description: '🏠 Main menu' },
        { command: 'shop', description: '🛍 Open shop' },
        { command: 'wallet', description: '💰 Wallet & deposit' },
        { command: 'orders', description: '📦 My history' },
        { command: 'support', description: '🆘 Support & help' }
      ];
      await bot.telegram.setMyCommands(menu).catch(() => {});
      await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } }).catch(() => {});
      return send(res, 200, JSON.stringify({ ok: true, webhook: `${base}/api`, secured: true }), 'application/json');
    }

    if (req.method === 'GET') return send(res, 200, 'MJ SMS Bot — online');

    // Paystack webhook: the request body is NOT trusted. We only use its reference,
    // then ask Paystack directly whether that payment really succeeded.
    if (req.method === 'POST' && path.endsWith('paystack')) {
      const ref = readBody(req).data?.reference;
      if (ref && /^MJSMS_\d+_\d+$/.test(String(ref))) {
        const v = await paystack.verify(ref);
        if (v.success && v.telegram_user_id && v.amount_ngn > 0) {
          const c = await wallet.credit(v.telegram_user_id, v.amount_ngn, 'fund', v.reference);
          if (c.applied) {
            await bot.telegram.sendMessage(v.telegram_user_id,
              `Payment confirmed ✅\n${ngn(v.amount_ngn)} don enter your wallet.\nNew balance: ${ngn(c.balance)}\n\nTell me country + app to buy.`).catch(() => {});
          }
        }
      }
      return send(res, 200, 'ok');                         // always 200 so Paystack stops retrying
    }

    if (req.method === 'POST') {
      // Fail closed: without the secret anybody could forge updates as any Telegram user.
      if (!WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return send(res, 401, 'unauthorized');
      await bot.handleUpdate(readBody(req));
      return send(res, 200, 'ok');
    }
    return send(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('handler', e);
    return send(res, 200, 'ok');                           // avoid Telegram retry storms
  }
};
