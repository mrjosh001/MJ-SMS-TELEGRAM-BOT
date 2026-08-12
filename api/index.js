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

// MJ HUB website is a DIFFERENT Supabase project. Bot sessions use SUPABASE_* above.
// Catalog selling prices come from the website DB via these env vars (read-only).
let MJ_HUB_REST_URL = (
  process.env.MJ_HUB_REST_URL ||
  process.env.MJ_HUB_SUPABASE_URL ||
  process.env.MJHUB_SUPABASE_URL ||
  ''
).replace(/\/$/, '');
if (MJ_HUB_REST_URL && !/\/rest\/v1$/i.test(MJ_HUB_REST_URL)) {
  MJ_HUB_REST_URL = MJ_HUB_REST_URL + '/rest/v1';
}
const MJ_HUB_SERVICE_KEY =
  process.env.MJ_HUB_SERVICE_KEY ||
  process.env.MJ_HUB_SUPABASE_SERVICE_KEY ||
  process.env.MJHUB_SERVICE_KEY ||
  '';
const mjHubHeaders = {
  apikey: MJ_HUB_SERVICE_KEY || '',
  Authorization: `Bearer ${MJ_HUB_SERVICE_KEY || ''}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
};

const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1500;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET || process.env.PAYSTACK_SECRET_KEY_LIVE || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7466363018';
// Same support channels as MJ Hub website (index.html ADMIN_WA + t.me/mj_hub_tg)
const SUPPORT_WA = (process.env.SUPPORT_WA || '14305583021').replace(/[^0-9]/g, '');
const SUPPORT_WA_LINK = `https://wa.me/${SUPPORT_WA}`;
const SUPPORT_TG_LINK = process.env.SUPPORT_TG || 'https://t.me/mj_hub_tg';
const SUPPORT_SITE = process.env.SUPPORT_SITE || 'https://mjhub.store';
// Grizzly blocks cancel shortly after getNumber (often ~2 min). Use 3 min default; override with MIN_CANCEL_SECONDS.
const MIN_CANCEL_MS = (Number(process.env.MIN_CANCEL_SECONDS) || 180) * 1000;

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
  malaysia: 7, my: 7,
  australia: 175, au: 175,
  belarus: 51, by: 51,

  japan: 182, jp: 182,
  'south korea': 103, korea: 103, kr: 103,
  uae: 95, dubai: 95, emirates: 95, 'united arab emirates': 95,
  portugal: 117, pt: 117,
  pakistan: 66, pk: 66,
  bangladesh: 60, bd: 60,
  morocco: 37, ma: 37,
  argentina: 39, ar: 39,
  colombia: 33, co: 33,
  chile: 151, cl: 151,
  peru: 65, pe: 65,
  romania: 32, ro: 32,
  sweden: 46, se: 46,
  norway: 174, no: 174,
  denmark: 172, dk: 172,
  finland: 163, fi: 163,
  ireland: 23, ie: 23,
  'new zealand': 67, nz: 67,
  singapore: 196, sg: 196,
  'hong kong': 14, hk: 14,
  taiwan: 55, tw: 55,
  israel: 13, il: 13,
  saudi: 53, 'saudi arabia': 53, sa: 53,
  iraq: 40, iq: 40,
  serbia: 29, rs: 29,
  croatia: 35, hr: 35,
  hungary: 100, hu: 100,
  czech: 63, 'czech republic': 63, cz: 63,
  austria: 50, at: 50,
  switzerland: 173, ch: 173,
  belgium: 82, be: 82,
  cameroon: 41, cm: 41,
  'ivory coast': 27, 'cote divoire': 27, ci: 27,
  senegal: 61, sn: 61,
  uganda: 75, ug: 75,
  tanzania: 34, tz: 34,
  ethiopia: 71, et: 71
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

function asName(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object') {
    return String(v.eng || v.english || v.name || v.title || v.country || v.label || '').trim();
  }
  return String(v).trim();
}

function friendlyServiceName(code, rawName) {
  const c = String(code || '').toLowerCase();
  const raw = String(rawName || '').trim();
  if (raw && raw.toLowerCase() !== c && !/^gr_/i.test(raw)) return raw.replace(/_/g, ' ');
  if (SERVICE_NAMES[c]) return SERVICE_NAMES[c];
  return c.toUpperCase();
}

function detectVariant(name, code) {
  const s = `${name || ''} ${code || ''}`.toLowerCase();
  // Only label virtual when supplier name/code clearly indicates it
  if (/\bvirtual\b|\bvoip\b|temp number|temporary/.test(s)) return 'virtual';
  if (/\bphysical\b|\breal sim\b|\bnormal\b|long.?term/.test(s)) return 'normal';
  // Alternate route codes (wa_x style) — only when code has a suffix, not plain "wa"
  if (/^(wa|tg|go|ig|fb)_.+/.test(s)) return 'alternate';
  return 'normal';
}


if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
}

const bot = new Telegraf(BOT_TOKEN || 'missing');

// Fallback store when Supabase session save fails (400/404)
const pendingPayments = new Map(); // telegramUserId -> { reference, amount_ngn, authorization_url }
/** In-memory intent (survives within warm serverless instance; backed by Supabase too) */
const pendingIntent = new Map(); // userId -> { service, countryId, countryName, at }

function setIntent(userId, data) {
  pendingIntent.set(String(userId), { ...data, at: Date.now() });
}
function getIntent(userId) {
  const p = pendingIntent.get(String(userId));
  if (!p) return null;
  if (Date.now() - p.at > 45 * 60 * 1000) {
    pendingIntent.delete(String(userId));
    return null;
  }
  return p;
}
function clearIntent(userId) {
  pendingIntent.delete(String(userId));
}

/** If user replied to a bot message, pull service/country hints from that message */
function contextFromReply(ctx) {
  const rt = ctx.message?.reply_to_message;
  if (!rt || !rt.text) return {};
  const t = String(rt.text);
  const out = {};
  const forSvc = t.match(/country for\s+([a-z0-9][a-z0-9\s]{0,30}?)\??$/i)
    || t.match(/for\s+(whatsapp|telegram|instagram|google|facebook|tiktok|snapchat|discord)\??/i);
  if (forSvc) out.service = forSvc[1].trim();
  const appFor = t.match(/app for\s+([a-z][a-z\s]{1,30}?)\??$/i);
  if (appFor) out.country = appFor[1].trim();
  const checking = t.match(/Checking\s+([^·\n]+)(?:·\s*(\S+))?/i);
  if (checking) {
    out.country = out.country || checking[1].trim();
    if (checking[2]) out.service = out.service || checking[2].trim();
  }
  return out;
}

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
      const meta = allOrders.find((o) => o && (o.type === '_meta' || o.type === '_payment_meta')) || {};
      const orders = allOrders.filter((o) => o && o.type !== '_meta' && o.type !== '_payment_meta');
      return {
        balance: parseFloat(row.balance || 0),
        state: row.state || 'AWAITING_INPUT',
        country: row.country || null,
        countryId: row.country_id || null,
        serviceQuery: row.selected_service_query || null,
        pendingService: row.selected_service_query || meta.pendingService || null,
        orders,
        conversation: meta.conversation || [],
        pending_payment: meta.pending_payment || null,
        last_credited_reference: meta.last_credited_reference || null
      };
    }
  } catch (_) {}
  await saveUserSession(userId, empty);
  return empty;
}

async function saveUserSession(userId, session) {
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) {
    console.error('saveUserSession: missing SUPABASE env');
    return false;
  }
  // Only columns that exist on user_sessions. conversation column is NOT in schema.
  const orders = [...(session.orders || [])].filter((o) => o && o.type !== '_meta');
  const pending = session.pendingService || session.serviceQuery || null;
  orders.push({
    type: '_meta',
    pending_payment: session.pending_payment || null,
    last_credited_reference: session.last_credited_reference || null,
    pendingService: pending,
    conversation: (session.conversation || []).slice(-8)
  });
  const payload = {
    user_id: String(userId),
    balance: money(session.balance),
    state: session.state || 'AWAITING_INPUT',
    country: session.country || null,
    country_id: session.countryId || null,
    selected_service_query: pending,
    orders,
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
    return true;
  } catch (e) {
    console.error('saveUserSession', e.response?.status, e.response?.data || e.message);
    return false;
  }
}

async function grizzlyGet(params) {
  const res = await axios.get(GRIZZLY_BASE, {
    ...axiosCfg,
    params: { api_key: (GRIZZLY_KEY || '').trim(), ...params }
  });
  return res.data;
}

// Live country cache from Grizzly (full list, not hardcoded map only)
let _countryCache = null;
let _countryCacheAt = 0;
const COUNTRY_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function grizzlyCountries() {
  const now = Date.now();
  if (_countryCache && now - _countryCacheAt < COUNTRY_CACHE_MS) return _countryCache;
  try {
    const data = await grizzlyGet({ action: 'getCountries' });
    const list = [];
    if (Array.isArray(data)) {
      for (const c of data) {
        const id = Number(c.id ?? c.country ?? c.code ?? c.country_id);
        const name = asName(c.eng || c.english || c.name || c.country_name || c.title || c);
        if (Number.isFinite(id) && id >= 0 && name && name !== '[object Object]') list.push({ id, name });
      }
    } else if (data && typeof data === 'object') {
      for (const [k, info] of Object.entries(data)) {
        const id = Number(info?.id ?? info?.country ?? k);
        const name = asName(info?.eng || info?.english || info?.name || info?.country_name || info);
        if (Number.isFinite(id) && id >= 0 && name && name !== '[object Object]') list.push({ id, name });
      }
    }
    if (list.length) {
      _countryCache = list;
      _countryCacheAt = now;
      console.log('[countries] loaded from Grizzly:', list.length);
      return list;
    }
  } catch (e) {
    console.error('grizzlyCountries', e.message);
  }
  // Fallback catalog when Grizzly getCountries is down (502 etc.)
  // Names are searchable free-text; ids are SMS-Activate / Grizzly compatible.
  const FALLBACK = [
    [0,'Russia'],[1,'Ukraine'],[2,'Kazakhstan'],[3,'China'],[4,'Philippines'],
    [5,'Myanmar'],[6,'Indonesia'],[7,'Malaysia'],[8,'Kenya'],[9,'Tanzania'],
    [10,'Vietnam'],[11,'Kyrgyzstan'],[12,'USA'],[13,'Israel'],[14,'Hong Kong'],
    [15,'Poland'],[16,'United Kingdom'],[17,'Madagascar'],[18,'Congo'],[19,'Nigeria'],
    [20,'Macau'],[21,'Egypt'],[22,'India'],[23,'Ireland'],[24,'Cambodia'],
    [25,'Laos'],[26,'Haiti'],[27,'Ivory Coast'],[28,'Gambia'],[29,'Serbia'],
    [30,'Yemen'],[31,'South Africa'],[32,'Romania'],[33,'Colombia'],[34,'Estonia'],
    [35,'Azerbaijan'],[36,'Canada'],[37,'Morocco'],[38,'Ghana'],[39,'Argentina'],
    [40,'Uzbekistan'],[41,'Cameroon'],[42,'Chad'],[43,'Germany'],[44,'Lithuania'],
    [45,'Croatia'],[46,'Sweden'],[47,'Iraq'],[48,'Netherlands'],[49,'Latvia'],
    [50,'Austria'],[51,'Belarus'],[52,'Thailand'],[53,'Saudi Arabia'],[54,'Mexico'],
    [55,'Taiwan'],[56,'Spain'],[57,'Iran'],[58,'Algeria'],[59,'Slovenia'],
    [60,'Bangladesh'],[61,'Senegal'],[62,'Turkey'],[63,'Czech Republic'],[64,'Sri Lanka'],
    [65,'Peru'],[66,'Pakistan'],[67,'New Zealand'],[68,'Guinea'],[69,'Mali'],
    [70,'Venezuela'],[71,'Ethiopia'],[72,'Mongolia'],[73,'Brazil'],[74,'Afghanistan'],
    [75,'Uganda'],[76,'Angola'],[77,'Cyprus'],[78,'France'],[79,'Papua New Guinea'],
    [80,'Mozambique'],[81,'Nepal'],[82,'Belgium'],[83,'Bulgaria'],[84,'Hungary'],
    [85,'Moldova'],[86,'Italy'],[87,'Paraguay'],[88,'Honduras'],[89,'Tunisia'],
    [90,'Nicaragua'],[91,'Timor-Leste'],[92,'Bolivia'],[93,'Costa Rica'],[94,'Guatemala'],
    [95,'UAE'],[96,'Zimbabwe'],[97,'Puerto Rico'],[98,'Sudan'],[99,'Togo'],
    [100,'Kuwait'],[101,'El Salvador'],[102,'Libya'],[103,'South Korea'],[104,'Jamaica'],
    [105,'Trinidad and Tobago'],[109,'Ecuador'],[114,'Lebanon'],[117,'Portugal'],
    [129,'Greece'],[141,'Georgia'],[151,'Chile'],[163,'Finland'],[172,'Denmark'],
    [173,'Switzerland'],[174,'Norway'],[175,'Australia'],[176,'Eritrea'],[179,'Niger'],
    [182,'Japan'],[187,'USA'],[196,'Singapore']
  ];
  const byId = new Map(FALLBACK);
  for (const [name, id] of Object.entries(COUNTRY_MAP)) {
    if (name.length <= 2) continue;
    if (!byId.has(id)) byId.set(id, name);
  }
  const list = [...byId.entries()].map(([id, name]) => ({ id, name: String(name) }));
  console.log('[countries] using fallback list', list.length);
  return list;
}

function isGrizzlyHubRow(r) {
  // Strict: only MJ HUB rows that belong to Grizzly / Server 1 SMS — not log-domain / other servers
  const blob = [
    r.supplier, r.provider, r.server, r.domain, r.source, r.platform,
    r.supplier_name, r.server_name, r.product_type, r.category
  ].map((x) => String(x || '').toLowerCase()).join(' ');
  if (!blob.trim()) return true; // no metadata → allow (legacy rows)
  if (/log\s*domain|logdomain|server\s*2|hero|sms-?man|5sim|daisy/.test(blob)) return false;
  if (/grizzly|server\s*1|server_1|server1/.test(blob)) return true;
  // If metadata exists but doesn't look like another SMS supplier, keep
  if (/log|account|boost/.test(blob) && !/grizzly|sms|number/.test(blob)) return false;
  return true;
}

async function fetchHubPriceByServiceIds(countryId, serviceIds) {
  if (!MJ_HUB_REST_URL || !MJ_HUB_SERVICE_KEY) return new Map();
  const ids = [...new Set((serviceIds || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const priceMap = new Map(); // key: service_id lower -> ONE hub row (grizzly only)
  // Request common supplier fields if present (PostgREST ignores unknown? use * safe subset)
  const select =
    'id,service_id,service_name,country_id,country_name,price,available_quantity,is_available,supplier_price,supplier,server,domain,provider,source';
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const inList = chunk.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
    try {
      let url =
        `${MJ_HUB_REST_URL}/number_services?select=${select}` +
        `&country_id=eq.${encodeURIComponent(countryId)}` +
        `&service_id=in.(${inList})` +
        `&price=gt.0&order=price.asc&limit=100`;
      let res;
      try {
        res = await axios.get(url, { ...axiosCfg, headers: mjHubHeaders });
      } catch (colErr) {
        // Table may not have supplier/server/domain columns — retry minimal select
        const selectMin =
          'id,service_id,service_name,country_id,country_name,price,available_quantity,is_available,supplier_price';
        url =
          `${MJ_HUB_REST_URL}/number_services?select=${selectMin}` +
          `&country_id=eq.${encodeURIComponent(countryId)}` +
          `&service_id=in.(${inList})` +
          `&price=gt.0&order=price.asc&limit=100`;
        res = await axios.get(url, { ...axiosCfg, headers: mjHubHeaders });
      }
      let rows = Array.isArray(res.data) ? res.data : [];
      rows = rows.filter(isGrizzlyHubRow);
      for (const r of rows) {
        if (r.is_available === false || r.is_available === 'false') continue;
        const sid = String(r.service_id || '').toLowerCase();
        const price = Math.ceil(Number(r.price) || 0);
        if (!(price > 0) || !sid) continue;
        // One price per service_id only (first = cheapest due to order=price.asc)
        if (priceMap.has(sid)) continue;
        priceMap.set(sid, {
          service_id: String(r.service_id),
          service_name: friendlyServiceName(r.service_id, r.service_name),
          price_ngn: price,
          stock: Number(r.available_quantity) || 0,
          price_usd: Number(r.supplier_price) || 0,
          hub_id: r.id,
          country_name: r.country_name || null,
          source: 'hub'
        });
      }
    } catch (e) {
      console.error('fetchHubPriceByServiceIds', e.response?.status, e.message);
    }
  }
  return priceMap;
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


// Pull selling prices from MJ HUB website catalog (number_services)
async function fetchHubServices(countryId, serviceFilter) {
  // Website catalog = different Supabase project
  if (!MJ_HUB_REST_URL || !MJ_HUB_SERVICE_KEY) {
    console.error('fetchHubServices: MJ_HUB_SUPABASE_URL / MJ_HUB_SERVICE_KEY missing');
    return [];
  }
  try {
    const select =
      'id,service_id,service_name,country_id,country_name,price,available_quantity,is_available,supplier_price';

    // Build optional service filter at the DB level (more reliable than JS-only)
    let serviceQuery = '';
    if (serviceFilter) {
      const q = String(serviceFilter).toLowerCase().trim();
      const code = (SERVICE_MAP[q] || q).toLowerCase();
      // Map common apps to name patterns + exact codes
      const namePat =
        code === 'wa' || q.includes('whatsapp')
          ? 'whatsapp'
          : code === 'tg' || q.includes('telegram')
            ? 'telegram'
            : code === 'go' || q.includes('google') || q.includes('gmail')
              ? 'google'
              : code === 'ig' || q.includes('instagram')
                ? 'instagram'
                : code === 'fb' || q.includes('facebook')
                  ? 'facebook'
                  : code === 'lf' || q.includes('tiktok')
                    ? 'tiktok'
                    : code === 'fu' || q.includes('snapchat')
                      ? 'snapchat'
                      : code === 'ds' || q.includes('discord')
                        ? 'discord'
                        : q.replace(/[^a-z0-9]/g, '');
      // Exclude false friends like WAF when looking for WhatsApp
      const exclude =
        namePat === 'whatsapp' ? '&service_id=neq.waf&service_name=not.ilike.*waf*' : '';
      serviceQuery =
        `&or=(service_id.eq.${encodeURIComponent(code)},service_name.ilike.*${encodeURIComponent(namePat)}*)` +
        exclude;
    }

    let url =
      `${MJ_HUB_REST_URL}/number_services?select=${select}` +
      `&country_id=eq.${encodeURIComponent(countryId)}` +
      `&price=gt.0` +
      serviceQuery +
      `&order=price.asc&limit=50`;

    let res = await axios.get(url, { ...axiosCfg, headers: mjHubHeaders });
    let rows = Array.isArray(res.data) ? res.data : [];

    // Fallback: country_name match (admin shows "USA" / "USA (2)")
    if (!rows.length) {
      const pretty =
        String(countryId) === '12'
          ? 'USA'
          : String(countryId) === '16'
            ? 'United Kingdom'
            : String(countryId) === '19'
              ? 'Nigeria'
              : '';
      if (pretty) {
        url =
          `${MJ_HUB_REST_URL}/number_services?select=${select}` +
          `&country_name=ilike.*${encodeURIComponent(pretty)}*` +
          `&price=gt.0` +
          serviceQuery +
          `&order=price.asc&limit=50`;
        res = await axios.get(url, { ...axiosCfg, headers: mjHubHeaders });
        rows = Array.isArray(res.data) ? res.data : [];
        console.log('[hub] country_name', pretty, 'rows', rows.length);
      }
    }

    // Last try for WhatsApp: no country filter, then keep USA-ish rows
    if (!rows.length && serviceFilter && /whatsapp|wa/i.test(String(serviceFilter))) {
      url =
        `${MJ_HUB_REST_URL}/number_services?select=${select}` +
        `&or=(service_id.eq.wa,service_name.ilike.*whatsapp*)` +
        `&service_id=neq.waf` +
        `&price=gt.0&order=price.asc&limit=30`;
      res = await axios.get(url, { ...axiosCfg, headers: mjHubHeaders });
      let all = Array.isArray(res.data) ? res.data : [];
      rows = all.filter((r) => {
        const cn = String(r.country_name || '').toUpperCase();
        const cid = String(r.country_id);
        return cid === String(countryId) || cn.includes('USA') || cn.includes('UNITED STATES');
      });
      console.log('[hub] global whatsapp then USA filter', all.length, '->', rows.length);
    }

    const available = rows.filter((r) => r.is_available !== false && r.is_available !== 'false');
    if (available.length) rows = available;

    // Dedupe by service_id + price
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const name = friendlyServiceName(r.service_id, r.service_name);
      const price = Math.ceil(Number(r.price) || 0);
      if (!(price > 0)) continue;
      // Drop WAF / non-whatsapp when user asked WhatsApp
      if (serviceFilter && /whatsapp|^wa$/i.test(String(serviceFilter))) {
        const id = String(r.service_id || '').toLowerCase();
        const nm = String(r.service_name || '').toLowerCase();
        if (id === 'waf' || (id !== 'wa' && !nm.includes('whatsapp'))) continue;
      }
      const key = `${r.service_id}|${price}|${r.country_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        service_id: String(r.service_id),
        service_name: name,
        variant: detectVariant(name, r.service_id),
        stock: Number(r.available_quantity) || 0,
        price_ngn: price,
        price_usd: Number(r.supplier_price) || 0,
        source: 'hub',
        hub_id: r.id,
        country_name: r.country_name || null
      });
    }
    console.log(
      '[hub] final',
      countryId,
      serviceFilter,
      out.map((s) => `${s.service_id}:${s.price_ngn}`).join(',')
    );
    return out;
  } catch (e) {
    console.error('fetchHubServices', e.response?.status, JSON.stringify(e.response?.data || e.message));
    return [];
  }
}

async function getSellableServices(countryId, serviceFilter) {
  // 1) Full service catalog from Grizzly for this country
  let live = await grizzlyPrices(countryId);
  if (serviceFilter) live = matchServices(live, serviceFilter);
  if (!live.length) {
    // Secondary: try hub-only list if Grizzly empty
    const hubOnly = await fetchHubServices(countryId, serviceFilter);
    if (hubOnly.length) {
      console.log('[prices] Grizzly empty — using hub-only', countryId, serviceFilter, hubOnly.length);
      return hubOnly;
    }
    return [];
  }

  // 2) Pull MJ HUB selling prices by exact service_id (+ country_id)
  const hubMap = await fetchHubPriceByServiceIds(
    countryId,
    live.map((s) => s.service_id)
  );

  const MIN_SALE = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
  const out = live.map((s) => {
    const sid = String(s.service_id).toLowerCase();
    const hub = hubMap.get(sid);
    if (hub) {
      return {
        ...s,
        service_name: hub.service_name || s.service_name,
        price_ngn: hub.price_ngn,
        stock: hub.stock > 0 ? hub.stock : s.stock,
        price_usd: hub.price_usd || s.price_usd,
        source: 'hub',
        hub_id: hub.hub_id,
        country_name: hub.country_name || null
      };
    }
    // No hub row for this service_id → live Grizzly markup (floor)
    return {
      ...s,
      price_ngn: Math.max(MIN_SALE, Number(s.price_ngn) || 0),
      source: 'live_grizzly'
    };
  });

  const hubCount = out.filter((s) => s.source === 'hub').length;
  let deduped = dedupeServices(out);

  // If user asked for a specific app, keep primary service_id + real variants only
  if (serviceFilter) {
    const code = (SERVICE_MAP[String(serviceFilter).toLowerCase().trim()] || '').toLowerCase();
    if (code) {
      const primary = deduped.filter((s) => String(s.service_id).toLowerCase() === code);
      const variants = deduped.filter((s) => {
        const id = String(s.service_id).toLowerCase();
        const name = String(s.service_name).toLowerCase();
        if (id === code) return false;
        return (
          new RegExp(`^${code}_`).test(id) ||
          /virtual|voip|alternate/.test(name) ||
          /virtual|voip|alternate/.test(id)
        );
      });
      if (primary.length || variants.length) {
        deduped = dedupeServices([...primary, ...variants]);
      }
    }
  }

  console.log(
    '[prices] grizzly-only catalog',
    live.length,
    '| final',
    deduped.length,
    '| hub price overlay',
    hubCount,
    '| country',
    countryId,
    serviceFilter || '(all)'
  );
  return deduped;
}

function optionButtons(countryId, services) {
  // Only show Normal/Virtual labels when supplier actually returned distinct variants
  const variants = new Set(services.map((s) => s.variant || 'normal'));
  const showVariantLabel = services.length > 1 && variants.size > 1;
  const rows = services.slice(0, 12).map((s, idx) => {
    let label;
    if (showVariantLabel) {
      const tag =
        s.variant === 'virtual' ? '👻 Virtual' :
        s.variant === 'alternate' ? '🔀 Alternate' :
        '📱 Normal';
      label = `${tag} · ${s.service_name} · ₦${Number(s.price_ngn).toLocaleString()}`;
    } else if (services.length > 1) {
      // Multiple real service_ids but same variant class — show name + price only
      label = `${s.service_name} · ₦${Number(s.price_ngn).toLocaleString()}`;
    } else {
      label = `✅ Buy · ₦${Number(s.price_ngn).toLocaleString()}`;
    }
    const data = `opt:${countryId}:${s.service_id}:${s.price_ngn}`;
    return [Markup.button.callback(label.slice(0, 64), data.slice(0, 64))];
  });
  rows.push([Markup.button.callback('⬅️ Cancel', 'opt:cancel')]);
  return Markup.inlineKeyboard(rows);
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
  // Grizzly / SMS-Activate: status 8 = cancel activation
  // Success response: ACCESS_CANCEL
  // Common failures: NO_ACTIVATION, BAD_STATUS, EARLY_CANCEL_DENIED (often < ~2 min)
  if (!orderId) {
    return { success: false, message: 'Missing order id', raw: '' };
  }
  try {
    const raw = await grizzlyGet({
      action: 'setStatus',
      id: String(orderId).trim(),
      status: '8'
    });
    const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw || '');
    console.log('[cancel]', orderId, text);
    if (/ACCESS_CANCEL/i.test(text)) {
      return { success: true, message: 'Cancelled at supplier', raw: text };
    }
    if (/EARLY_CANCEL|TOO_EARLY|WAIT/i.test(text)) {
      return {
        success: false,
        early: true,
        message: 'Too early to cancel. Wait a few more minutes after buying, then try again.',
        raw: text
      };
    }
    if (/NO_ACTIVATION/i.test(text)) {
      return { success: false, message: 'Supplier has no record of this order.', raw: text };
    }
    if (/BAD_STATUS|STATUS_CANCEL|already/i.test(text)) {
      // Already cancelled on supplier — treat as success so wallet can refund once
      return { success: true, message: 'Already cancelled at supplier', raw: text };
    }
    return {
      success: false,
      message: 'Could not cancel this order right now. Try again shortly.',
      raw: text
    };
  } catch (e) {
    console.error('grizzlyCancel', e.message);
    return { success: false, message: 'Supplier unreachable. Try again in a few minutes.', raw: e.message || '' };
  }
}


function cancelWaitInfo(order) {
  const boughtAt = order?.date || order?.created_at || order?.bought_at || null;
  if (!boughtAt) {
    // No timestamp — still enforce short soft wait from now is not possible; allow API decide
    return { allowed: true, waitMs: 0, waitSec: 0 };
  }
  const t0 = new Date(boughtAt).getTime();
  if (!Number.isFinite(t0)) return { allowed: true, waitMs: 0, waitSec: 0 };
  const elapsed = Date.now() - t0;
  if (elapsed >= MIN_CANCEL_MS) return { allowed: true, waitMs: 0, waitSec: 0, unlockAt: t0 + MIN_CANCEL_MS };
  const waitMs = MIN_CANCEL_MS - elapsed;
  return {
    allowed: false,
    waitMs,
    waitSec: Math.max(1, Math.ceil(waitMs / 1000)),
    unlockAt: t0 + MIN_CANCEL_MS
  };
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  return v > 0 ? v : 0;
}

/**
 * Nigerian amount parse: 2k → 2000, 5k → 5000, 1.5k → 1500, 10,000 → 10000, ₦3k → 3000
 * Also plain digits. Returns 0 if nothing useful.
 */
function parseNairaAmount(text) {
  const raw = String(text || '').trim().toLowerCase().replace(/,/g, '');
  if (!raw) return 0;
  // 2k, 5k, 10k, 1.5k, 2.5k
  let m = raw.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  // 2 thousand / 5 thsd
  m = raw.match(/(\d+(?:\.\d+)?)\s*(?:thousand|thsd|ths)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  // plain number (strip currency junk)
  m = raw.match(/(\d+(?:\.\d+)?)/);
  if (m) return Math.round(parseFloat(m[1]));
  return 0;
}

/** Reload session, debit only if enough funds. Verifies persist. Returns { ok, balance, session, debited } */
async function safeDebit(userId, amount, meta = {}) {
  const session = await getUserSession(userId);
  amount = money(amount);
  const bal = money(session.balance);
  if (amount <= 0) return { ok: true, balance: bal, session, debited: 0 };
  if (bal < amount) {
    return { ok: false, balance: bal, session, debited: 0, need: amount };
  }
  const next = money(bal - amount);
  session.balance = next;
  const saved = await saveUserSession(userId, session);
  if (!saved) {
    console.error('[money] debit SAVE FAILED', userId, amount, meta);
    return { ok: false, balance: bal, session: { ...session, balance: bal }, debited: 0, saveFailed: true };
  }
  // Re-read to confirm wallet actually moved
  const verify = await getUserSession(userId);
  const verifiedBal = money(verify.balance);
  if (verifiedBal !== next) {
    console.error('[money] debit VERIFY MISMATCH', userId, { expected: next, got: verifiedBal, meta });
    // Force-write once more
    verify.balance = next;
    const saved2 = await saveUserSession(userId, verify);
    if (!saved2) {
      return { ok: false, balance: verifiedBal, session: verify, debited: 0, saveFailed: true };
    }
  }
  const finalS = await getUserSession(userId);
  console.log('[money] debit', userId, amount, '→', money(finalS.balance), meta);
  return { ok: true, balance: money(finalS.balance), session: finalS, debited: amount };
}

/** Reload session, credit once. */
async function safeCredit(userId, amount, meta = {}) {
  const session = await getUserSession(userId);
  amount = money(amount);
  if (amount <= 0) return { ok: true, balance: money(session.balance), session, credited: 0 };
  session.balance = money(money(session.balance) + amount);
  const saved = await saveUserSession(userId, session);
  if (!saved) {
    console.error('[money] credit SAVE FAILED', userId, amount, meta);
    return { ok: false, balance: money(session.balance) - amount, session, credited: 0, saveFailed: true };
  }
  const finalS = await getUserSession(userId);
  console.log('[money] credit', userId, amount, '→', money(finalS.balance), meta);
  return { ok: true, balance: money(finalS.balance), session: finalS, credited: amount };
}

function formatWait(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_CONVERSATION_TURNS = 16;
const MAX_TOOL_ROUNDTRIPS = 6;

const GEMINI_SYSTEM_PROMPT = `You be Mira, the official MJ SMS Assistant for MJ Hub (mjhub.store).

Your main work:
- Help users get real non-VOIP SMS numbers and OTP codes directly here on Telegram
- Guide users step by step to buy number
- Deliver the number and later deliver the code (only via tools — never invent)
- Answer questions about MJ SMS and MJ Hub
- Softly sell and grow the brand
- Talk natural Nigerian Pidgin mixed with clear English (fluent and real, no force Pidgin)

Personality:
- Calm, sharp, helpful, street-smart
- Talk the way real Nigerians dey talk online
- Be patient with new users
- Be fast and clear when dem ready to buy
- No dey sound like robot or script
- Always helpful and solution-focused

About MJ Hub (know this deep so you fit answer customer questions alone):
- All-in-one marketplace: MJ Logs (verified accounts), MJ SMS (real numbers for OTP), MJ Boosters (followers/likes/views)
- One dashboard, one wallet (Naira or USD)
- Website: https://mjhub.store
- Support: same WhatsApp + Telegram as on the site; use /support for links
- Referral: members earn 2% for life when people they invite fund their wallet
- MJ Logs: premium Facebook, Instagram, X, Gmail, Spotify, dating accounts etc. — ordered on the website
- MJ Boosters: SMM panel (followers, likes, views, comments) for IG, TikTok, YouTube, Telegram, X — ordered on the website
- This Telegram bot is ONLY for MJ SMS (Server 1). For logs/boosters, point them to mjhub.store

About MJ SMS (this bot = Server 1 numbers):
- Real mobile numbers (not VOIP) — better success for WhatsApp and major apps
- Works for WhatsApp, Telegram, Instagram, Google, Facebook, TikTok, Snapchat, Discord, Microsoft, Apple, Netflix, and plenty more
- Over 200 countries available
- Pay from wallet on this bot (/fund AMOUNT) or fund on mjhub.store (balances are separate: bot wallet vs website wallet)
- OTP usually drops within about 1 minute after they request the code in the app
- If code no drop after some time, user fit cancel/refund when supplier allows (usually wait ~3 minutes after buy)
- Prices shown in Naira; stock changes live — always use tools, never invent
- You can fund any amount between ₦1,000 and ₦200,000 per payment via Paystack

How you handle SMS request (step by step):
1. If dem no mention app → ask which service (WhatsApp, Telegram, Instagram, Google…)
2. If dem no mention country → ask which country
3. Confirm: "Alright, [Country] [Service]. You ready make I process am?"
4. Only when dem confirm OR dem already gave full request (e.g. "USA WhatsApp") → use tools get_prices then buy_number
5. Never invent number or code. Only tool results.

Important rules:
1. Never invent price, stock, number, or OTP code
2. Always use tools for prices, buy, status, cancel, balance, payment
3. If get_prices returns options, show the price from tool and let dem pick / confirm before buy_number
4. If balance low → guide /fund — do not promise free number
5. If no stock → say try another country (do not invent Server 2 stock on this bot unless tool says so)
6. If dem just dey yarn (hi, how far) → yarn natural, then soft ask wetin dem need
7. Keep replies short when dem dey buy
8. After successful number: tell dem use am for OTP; code go show when dem tap Check or when check_status returns it
9. After code delivered: ask if dem need another number
10. Never mention Grizzly, suppliers, API, or internal systems to the customer
11. Never claim you are AI/robot
12. Cancel: supplier blocks cancel for a few minutes after buy — tell dem the wait time from tool, no fake refund

Payment:
- Wallet top-up with /fund AMOUNT (Paystack)
- Minimum practical top-up around ₦1000
- If no balance: "You never get enough balance. You fit /fund or fund on mjhub.store. How you wan do am?"

Reply style examples:
- "I need number" → "Okay. Which service you need the number for? (WhatsApp, Telegram, Instagram, Google…)"
- Dem say WhatsApp → "Which country you want?"
- Dem say USA → "Alright, USA WhatsApp. You ready make I get the number for you now?"
- No stock → "That one no dey available for now. You fit try another country?"
- Code waiting → "Code never drop yet. Make I check… If e no show after some minutes, you fit cancel for refund when the timer allow."
- After code → "Your code don drop: XXXXXX. Copy am sharp. You need another number?"

Tools you must use (do not skip):
list_countries, get_prices, buy_number, check_status, cancel_order, get_balance, get_my_orders, create_payment, verify_payment.

When user already typed full request like "UK WhatsApp" or "Nigeria Telegram", call get_prices immediately — no need to re-ask.
`;

const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'list_countries',
      description: 'List all countries available for number purchases (full catalog).',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_prices',
      description: 'Get live prices and stock for apps in a country. ALWAYS call before quoting price or buying.',
      parameters: {
        type: 'OBJECT',
        properties: {
          country: { type: 'STRING', description: 'Any country name the customer typed (free search, full catalog)' },
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
          service_code: { type: 'STRING', description: 'Exact service code from get_prices options e.g. wa' }
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

async function resolveCountry(name) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  if (!key) return null;

  const live = await grizzlyCountries();

  // Numeric country id
  if (/^\d+$/.test(key)) {
    const id = Number(key);
    const hit = live.find((c) => c.id === id);
    return { id, name: asName(hit ? hit.name : key) || key };
  }

  // Exact match on live Grizzly country name
  let hit = live.find((c) => c.name.toLowerCase() === key);
  if (hit) return { id: hit.id, name: asName(hit.name) || key };

  // Starts-with / contains on live names (prefer longer names)
  const ranked = live
    .map((c) => ({ ...c, n: c.name.toLowerCase() }))
    .filter((c) => c.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);

  hit = ranked.find((c) => c.n.startsWith(key) || key.startsWith(c.n));
  if (hit) return { id: hit.id, name: asName(hit.name) || key };

  hit = ranked.find((c) => c.n.includes(key) || key.includes(c.n));
  if (hit) return { id: hit.id, name: asName(hit.name) || key };

  // Soft alias only if live search missed (ng → Nigeria, etc.)
  if (key in COUNTRY_MAP) {
    const id = COUNTRY_MAP[key];
    const liveHit = live.find((c) => c.id === id);
    return { id, name: liveHit ? liveHit.name : key };
  }
  for (const [k, id] of Object.entries(COUNTRY_MAP)) {
    if (k.length < 3) continue;
    if (key.includes(k) || k.includes(key)) {
      const liveHit = live.find((c) => c.id === id);
      return { id, name: liveHit ? liveHit.name : k };
    }
  }
  return null;
}

async function executeGeminiFunction(fnName, args, telegramUserId, session) {
  switch (fnName) {
    case 'list_countries': {
      const live = await grizzlyCountries();
      // Prefer proper country names; include popular aliases tip
      const names = live
        .map((c) => c.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      return {
        total: names.length,
        countries: names.slice(0, 100),
        tip: 'Full live catalog. Customer can type ANY country name freely — not limited to this preview.'
      };
    }

    case 'get_prices': {
      const c = await resolveCountry(args.country);
      if (!c) return { error: `Unknown country "${args.country}". Ask the user to clarify or try list_countries.` };
      const list = await getSellableServices(c.id, args.service || null);
      if (!list.length) return { error: `No services currently available for ${c.name}.` };
      session.country = c.name;
      session.countryId = c.id;
      session.last_options = list.slice(0, 12).map((s) => ({
        service_code: s.service_id,
        name: s.service_name,
        variant: s.variant || 'normal',
        price_ngn: s.price_ngn,
        stock: s.stock,
        country_id: c.id
      }));
      const services = session.last_options;
      const hasMultiple = services.length > 1;
      const hasVariants = new Set(services.map((s) => s.variant)).size > 1;
      return {
        country: c.name,
        price_source: 'catalog',
        must_choose: hasMultiple,
        has_normal_and_virtual: hasVariants,
        services,
        tip: hasMultiple
          ? 'User will also see Telegram buttons to pick Normal/Virtual. Still list options briefly and wait for their pick. Do not buy yet.'
          : 'Only one option — confirm once then buy if they agree.'
      };
    }

    case 'buy_number': {
      const c = await resolveCountry(args.country);
      if (!c) return { error: `Unknown country "${args.country}".` };
      const list = await getSellableServices(c.id, args.service || null);
      let svc = null;
      if (args.service_code) {
        svc = list.find((s) => String(s.service_id).toLowerCase() === String(args.service_code).toLowerCase());
        // If filter missed it, try full country list
        if (!svc) {
          const all = await getSellableServices(c.id, null);
          svc = all.find((s) => String(s.service_id).toLowerCase() === String(args.service_code).toLowerCase());
        }
      }
      if (!svc) {
        const matched = args.service ? matchServices(list, args.service) : list;
        if (matched.length > 1 && !args.service_code) {
          session.last_options = matched.slice(0, 12).map((s) => ({
            service_code: s.service_id,
            name: s.service_name,
            variant: s.variant,
            price_ngn: s.price_ngn,
            stock: s.stock,
            country_id: c.id
          }));
          return {
            error: 'multiple_options',
            message: 'More than one option exists. User should tap a button or tell you which one.',
            options: session.last_options
          };
        }
        svc = matched[0];
      }
      if (!svc) return { error: `"${args.service || args.service_code}" isn't available in ${c.name} right now.` };

      if (svc.price_ngn > 0 && session.balance < svc.price_ngn) {
        return {
          error: 'insufficient_balance',
          balance_ngn: session.balance,
          price_ngn: svc.price_ngn,
          message: `Customer's balance (₦${session.balance}) is below the price (₦${svc.price_ngn}). Tell them to top up their wallet and try again.`
        };
      }

      const bought = await grizzlyBuy(svc.service_id, c.id);
      if (!bought.success) return { error: bought.message || 'Purchase failed at the supplier.' };

      const priceN = money(svc.price_ngn);
      if (priceN > 0) {
        const deb = await safeDebit(telegramUserId, priceN, { orderId: bought.order_id });
        Object.assign(session, deb.session);
      }
      const order = {
        orderId: bought.order_id,
        provider: 'grizzly',
        service: svc.service_id,
        serviceName: svc.service_name || svc.service_id,
        phoneNumber: bought.number,
        price: money(svc.price_ngn),
        status: 'Waiting for SMS',
        date: new Date().toISOString(),
        charged: true,
        refunded: false
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
      if (order && /cancelled/i.test(order.status || '')) {
        return { order_id: orderId, already_cancelled: true, balance_ngn: session.balance };
      }
      const wait = cancelWaitInfo(order);
      if (!wait.allowed) {
        return {
          error: 'too_early',
          early: true,
          wait_seconds: wait.waitSec,
          order_id: orderId,
          message: `Too early to cancel. Tell user to wait about ${formatWait(wait.waitSec)} more (supplier needs ~${Math.round(MIN_CANCEL_MS / 60000)} min after purchase). Do NOT refund.`
        };
      }
      const result = await grizzlyCancel(orderId);
      if (!result.success) {
        return {
          error: result.message,
          early: !!result.early,
          order_id: orderId,
          message: result.early
            ? result.message
            : 'Cancel failed at supplier. Do NOT tell user they were refunded.'
        };
      }
      if (order && order.refunded === true) {
        return {
          success: true,
          order_id: orderId,
          already_refunded: true,
          new_balance_ngn: money(session.balance)
        };
      }
      const refunded = money(order?.price || 0);
      if (refunded > 0) {
        const cr = await safeCredit(telegramUserId, refunded, { orderId, reason: 'cancel' });
        Object.assign(session, cr.session);
      }
      session.orders = (session.orders || []).map((o) =>
        String(o.orderId) === String(orderId)
          ? { ...o, status: 'Cancelled', refunded: true, refunded_amount: refunded }
          : o
      );
      return {
        success: true,
        order_id: orderId,
        refunded_ngn: refunded,
        new_balance_ngn: money(session.balance)
      };
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
      const errData = e.response?.data || e.message;
      console.error('gemini call failed', errData);
      const status = e.response?.status;
      const msg = String(e.response?.data?.error?.message || e.message || '');
      if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg)) {
        return {
          reply: 'QUOTA_EXCEEDED',
          contents,
          quota: true
        };
      }
      if (status === 404 || /no longer available|not found/i.test(msg)) {
        return {
          reply: 'MODEL_UNAVAILABLE',
          contents,
          modelFail: true
        };
      }
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

async function parseCountryService(text) {
  const original = String(text || '').trim();
  // Pure digits = fund amount / order id, not a country
  if (/^[\d,.\s₦]+$/i.test(original)) {
    return { countryId: null, countryName: null, serviceCode: null, serviceName: null };
  }
  const t = original.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let countryId = null;
  let countryName = null;
  let serviceCode = null;
  let serviceName = null;

  // Services first (so "WhatsApp" doesn't get eaten as a country fragment)
  const serviceEntries = Object.entries(SERVICE_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of serviceEntries) {
    if (name.length < 2) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(t)) {
      serviceCode = code;
      serviceName = name;
      break;
    }
  }

  // Free-search country against full live Grizzly list
  try {
    const live = await grizzlyCountries();
    const ranked = [...live]
      .map((c) => ({ id: c.id, name: c.name, n: String(c.name || '').toLowerCase().trim() }))
      .filter((c) => c.n.length >= 2)
      .sort((a, b) => b.n.length - a.n.length);

    // Prefer multi-word country names present in the message
    for (const c of ranked) {
      if (c.n.length < 3 && c.n.length !== 2) continue;
      const re = new RegExp(`\\b${c.n.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`);
      if (re.test(t)) {
        countryId = c.id;
        countryName = c.name;
        break;
      }
    }

    // If still nothing, try alias map only as helper (ng, uk, usa…)
    if (countryId == null) {
      const aliasEntries = Object.entries(COUNTRY_MAP).sort((a, b) => b[0].length - a[0].length);
      for (const [name, id] of aliasEntries) {
        if (name.length < 2) continue;
        if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(t)) {
          countryId = id;
          const liveHit = ranked.find((c) => c.id === id);
          countryName = liveHit ? liveHit.name : name;
          break;
        }
      }
    }
  } catch (_) {}

  return { countryId, countryName, serviceCode, serviceName };
}


function matchServices(list, query) {
  if (!query) return dedupeServices(list).slice(0, 20);
  const q = String(query).toLowerCase().trim();
  const code = (SERVICE_MAP[q] || q).toLowerCase();

  // Primary exact service_id match first (wa, tg, go…)
  const exact = list.filter((s) => String(s.service_id || '').toLowerCase() === code);

  // Extra variants ONLY if supplier name/code clearly marks virtual/alternate
  // Do NOT pull every service whose name merely contains "whatsapp"
  const extras = list.filter((s) => {
    const id = String(s.service_id || '').toLowerCase();
    const name = String(s.service_name || '').toLowerCase();
    if (id === code) return false; // already in exact
    // same family with explicit suffix: wa_xxx, tg_xxx
    if (code.length >= 2 && new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_`).test(id)) {
      return true;
    }
    // name must include app AND variant keyword
    const appWord =
      code === 'wa' ? 'whatsapp' :
      code === 'tg' ? 'telegram' :
      code === 'go' ? 'google' :
      code === 'ig' ? 'instagram' :
      code === 'fb' ? 'facebook' :
      code === 'lf' ? 'tiktok' :
      code === 'fu' ? 'snapchat' :
      q;
    if (!name.includes(appWord) && id !== q) return false;
    return /virtual|voip|alternate|temp/.test(name) || /virtual|voip|alternate|temp/.test(id);
  });

  let hit = [...exact, ...extras];

  // Fallback: loose name match only if nothing exact (single best row)
  if (!hit.length) {
    hit = list.filter((s) => {
      const id = String(s.service_id || '').toLowerCase();
      const name = String(s.service_name || '').toLowerCase();
      return id === q || name === q || name.includes(q);
    });
  }

  hit = dedupeServices(hit);

  // Prefer stock > 0, then cheaper
  hit.sort((a, b) => {
    const sa = a.stock > 0 ? 0 : 1;
    const sb = b.stock > 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.price_ngn || 0) - (b.price_ngn || 0);
  });

  // If only the primary code exists, return just that (1 option)
  // If supplier has real extras, return primary + extras
  return hit.slice(0, 8);
}

/** Unique by service_id — never show the same supplier service twice */
function dedupeServices(list) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    const id = String(s.service_id || '').toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(s);
  }
  return out;
}


// ---------- Bot commands ----------
async function registerBotMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot · talk to Mira' },
      { command: 'balance', description: 'Check your wallet balance' },
      { command: 'fund', description: 'Top up your wallet (e.g. /fund 2000)' },
      { command: 'orders', description: 'View numbers you bought' },
      { command: 'privacy', description: 'View our privacy policy' },
      { command: 'support', description: 'Contact customer care / help' }
    ]);
  } catch (e) {
    console.error('setMyCommands', e.message);
  }
}
registerBotMenu();



bot.start(async (ctx) => {
  await getUserSession(ctx.from.id);
  await ctx.reply(
    `How far 👋 I be *Mira* — MJ SMS assistant.\n\n` +
      `I fit get real number for WhatsApp, Telegram, Instagram, Google and more.\n\n` +
      `Just type like:\n` +
      `• *USA WhatsApp*\n` +
      `• *Nigeria Telegram*\n` +
      `• or say *I need number*\n\n` +
      `/balance — wallet\n` +
      `/fund 2000 — top up\n` +
      `/orders — numbers you bought\n` +
      `/support — help\n\n` +
      `Wetin you need right now?`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('hubtest', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_TELEGRAM_ID)) {
    return ctx.reply('Admin only.');
  }
  const hasUrl = Boolean(MJ_HUB_REST_URL);
  const hasKey = Boolean(MJ_HUB_SERVICE_KEY);
  let msg = `MJ_HUB_REST_URL: ${hasUrl ? 'set' : 'MISSING'}\nMJ_HUB_SERVICE_KEY: ${hasKey ? 'set' : 'MISSING'}\n`;
  if (!hasUrl || !hasKey) {
    return ctx.reply(msg + '\nAdd env and redeploy.');
  }
  try {
    // Direct WhatsApp query on Hub
    const waUrl =
      `${MJ_HUB_REST_URL}/number_services?select=service_id,service_name,country_id,country_name,price,supplier_price` +
      `&or=(service_id.eq.wa,service_name.ilike.*whatsapp*)&price=gt.0&order=price.asc&limit=15`;
    const waRes = await axios.get(waUrl, { ...axiosCfg, headers: mjHubHeaders });
    const waRows = Array.isArray(waRes.data) ? waRes.data : [];
    msg += `Hub WhatsApp rows (any country): ${waRows.length}\n`;
    msg +=
      waRows
        .slice(0, 10)
        .map(
          (r) =>
            `• ${r.service_id} | ${r.service_name} | ₦${r.price} | cid=${r.country_id} | ${r.country_name}`
        )
        .join('\n') || '(none)';

    const sell = await getSellableServices(12, 'whatsapp');
    msg += `\n\nSellable USA WhatsApp: ${sell.length}\n`;
    msg += sell.map((s) => `• ${s.service_id} ${s.service_name} ₦${s.price_ngn} [${s.source}]`).join('\n');
    await ctx.reply(msg.slice(0, 3500));
  } catch (e) {
    await ctx.reply(
      msg +
        `\nERROR ${e.response?.status || ''}\n` +
        JSON.stringify(e.response?.data || e.message).slice(0, 500)
    );
  }
});


bot.command('privacy', async (ctx) => {
  await ctx.reply(
    `*MJ SMS Privacy Policy*\n\n` +
      `• We only use your Telegram ID to run your wallet and orders on this bot.\n` +
      `• Phone numbers you buy are for your OTP use; we do not sell your personal chat data.\n` +
      `• Payments are processed securely via Paystack.\n` +
      `• Order history is stored so you can check numbers and status.\n` +
      `• You can request support anytime with /support.\n\n` +
      `Website: mjhub.store`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('support', async (ctx) => {
  const prefill = encodeURIComponent(
    `Hello MJ Hub support, I need help on MJ SMS Telegram bot.\nTelegram: @${ctx.from.username || 'n/a'} (id ${ctx.from.id})`
  );
  const waUrl = `${SUPPORT_WA_LINK}?text=${prefill}`;
  await ctx.reply(
    `*MJ SMS Support*\n\n` +
      `I be *Mira* — I fit help you buy number and check OTP here.\n\n` +
      `Need human support? Same channels as *mjhub.store*:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💬 WhatsApp Support', waUrl)],
        [Markup.button.url('✈️ Telegram Support', SUPPORT_TG_LINK)],
        [Markup.button.url('🌐 MJ Hub website', SUPPORT_SITE)],
        [Markup.button.callback('💰 Balance', 'menu:bal')],
        [Markup.button.callback('💳 Fund wallet', 'menu:fund')]
      ])
    }
  );
});


bot.command(['balance', 'bal'], async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  await ctx.reply(`Balance: *₦${money(s.balance).toLocaleString()}*`, { parse_mode: 'Markdown' });
});

bot.command('orders', async (ctx) => {
  const s = await getUserSession(ctx.from.id);
  const list = (s.orders || []).filter((o) => o && o.orderId && o.type !== '_meta');
  if (!list.length) {
    return ctx.reply('No orders yet.\n\nType country + app e.g. *USA WhatsApp* to buy.', {
      parse_mode: 'Markdown'
    });
  }
  const lines = list
    .slice(-15)
    .reverse()
    .map((o, i) => {
      const phone = String(o.phoneNumber || o.number || o.phone || '').trim() || '—';
      const svc = o.serviceName || o.service || 'SMS';
      const price = money(o.price);
      const st = o.status || '—';
      const id = o.orderId || '';
      const when = o.date ? new Date(o.date).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : '';
      return (
        `*${i + 1}. ${svc}*\n` +
        `📞 \`${phone}\`\n` +
        `🆔 \`${id}\`\n` +
        `₦${price.toLocaleString()} · ${st}` +
        (when ? `\n${when}` : '')
      );
    })
    .join('\n\n');
  await ctx.reply(`*Your recent orders*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  if (!GRIZZLY_KEY) return ctx.reply('GRIZZLYSMS_API_KEY not set on server.');
  const bal = await grizzlyBalance();
  if (bal == null) return ctx.reply('Supplier: OFFLINE');
  await ctx.reply(`*Supplier:* ONLINE\nBalance: \`${bal}\``, {
    parse_mode: 'Markdown'
  });
});

bot.command('fund', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const raw = parts[1];
  const session = await getUserSession(ctx.from.id);

  // /fund with no amount → ask and WAIT for next message as the amount
  if (!raw) {
    session.state = 'AWAITING_FUND_AMOUNT';
    await saveUserSession(ctx.from.id, session);
    return ctx.reply(
      'How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\n\nExample: 5000\n(or type /fund 5000)'
    );
  }

  let amount = parseNairaAmount(raw);
  if (amount < 1000) {
    session.state = 'AWAITING_FUND_AMOUNT';
    await saveUserSession(ctx.from.id, session);
    return ctx.reply('Minimum na ₦1,000. Example: *2k* or *5000*', { parse_mode: 'Markdown' });
  }
  if (amount > 200000) {
    session.state = 'AWAITING_FUND_AMOUNT';
    await saveUserSession(ctx.from.id, session);
    return ctx.reply('Maximum na ₦200,000 for one payment. Example: *50k*', { parse_mode: 'Markdown' });
  }

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
  session.state = 'AWAITING_INPUT';
  pendingPayments.set(String(ctx.from.id), pending);
  await saveUserSession(ctx.from.id, session);
  await ctx.reply(
    `Top up ₦${init.amount_ngn.toLocaleString()}\n\nTap Pay below.\nWhen e successful, type: I don pay`,
    Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
  );
});

// Buy callback: buy:countryId:serviceId:priceNgn

bot.action('menu:home', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Select the country for your number:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🇺🇸 United States', 'cty:12'),
        Markup.button.callback('🇬🇧 United Kingdom', 'cty:16')
      ],
      [
        Markup.button.callback('🇨🇦 Canada', 'cty:36'),
        Markup.button.callback('🇳🇬 Nigeria', 'cty:19')
      ],
      [
        Markup.button.callback('🇬🇭 Ghana', 'cty:38'),
        Markup.button.callback('🇰🇪 Kenya', 'cty:8')
      ]
    ])
  );
});

bot.action('menu:fund', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getUserSession(ctx.from.id);
  session.state = 'AWAITING_FUND_AMOUNT';
  await saveUserSession(ctx.from.id, session);
  await ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\n\nExample: 5000');
});

bot.action('menu:bal', async (ctx) => {
  await ctx.answerCbQuery();
  const s = await getUserSession(ctx.from.id);
  await ctx.reply(`Balance: ₦${Number(s.balance || 0).toLocaleString()}`);
});

bot.action(/^cty:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const countryId = ctx.match[1];
  const nameFromId = Object.entries(COUNTRY_MAP).find(([, id]) => String(id) === String(countryId));
  const countryName = nameFromId ? nameFromId[0] : `country ${countryId}`;
  const session = await getUserSession(ctx.from.id);
  session.countryId = Number(countryId);
  session.country = countryName;
  session.state = 'AWAITING_APP';
  await saveUserSession(ctx.from.id, session);
  await ctx.reply(
    `Country: *${countryName}*\n\nWhich app?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('WhatsApp', `app:${countryId}:whatsapp`),
          Markup.button.callback('Telegram', `app:${countryId}:telegram`)
        ],
        [
          Markup.button.callback('Google', `app:${countryId}:google`),
          Markup.button.callback('Instagram', `app:${countryId}:instagram`)
        ],
        [
          Markup.button.callback('Facebook', `app:${countryId}:facebook`),
          Markup.button.callback('TikTok', `app:${countryId}:tiktok`)
        ],
        [
          Markup.button.callback('Snapchat', `app:${countryId}:snapchat`),
          Markup.button.callback('Discord', `app:${countryId}:discord`)
        ],
        [Markup.button.callback('⬅️ Back', 'menu:home')]
      ])
    }
  );
});

bot.action(/^app:(\d+):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery('Loading…');
  const countryId = ctx.match[1];
  const app = ctx.match[2];
  const session = await getUserSession(ctx.from.id);
  const nameFromId = Object.entries(COUNTRY_MAP).find(([, id]) => String(id) === String(countryId));
  const countryName = session.country || (nameFromId ? nameFromId[0] : countryId);
  await showServiceOptions(ctx, session, ctx.from.id, countryId, countryName, app);
});

bot.action('opt:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getUserSession(ctx.from.id);
  session.last_options = null;
  await saveUserSession(ctx.from.id, session);
  await ctx.reply('Alright, cancelled. Wetin you need instead?');
});

bot.action(/^opt:(\d+):([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Buying…');
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const price = money(parseInt(ctx.match[3], 10) || 0);
  const userId = ctx.from.id;
  let session = await getUserSession(userId);

  if (price > 0 && money(session.balance) < price) {
    return ctx.reply(
      `Balance no reach o.\nYou need ₦${price.toLocaleString()} · you get ₦${money(session.balance).toLocaleString()}.\n\nType /fund ${price} make I top you up.`
    );
  }

  await ctx.reply('I dey grab the number… hold on.');
  const bought = await grizzlyBuy(serviceId, countryId);
  if (!bought.success) {
    return ctx.reply(
      /502|503|gateway|unreachable|timeout/i.test(String(bought.message || ''))
        ? 'Supplier temporarily unavailable. Abeg try again in a few minutes.'
        : `E no work: ${bought.message || 'No number available. Try another option.'}`
    );
  }

  // MUST debit after supplier success — never give free number
  const deb = await safeDebit(userId, price, { orderId: bought.order_id, path: 'opt' });
  if (price > 0 && !deb.ok) {
    // Try cancel at supplier so customer isn't charged twice later
    try {
      await grizzlyCancel(bought.order_id);
    } catch (_) {}
    console.error('[buy] debit failed after getNumber', userId, price, bought.order_id, deb);
    return ctx.reply(
      deb.saveFailed
        ? 'Number come out but wallet no update. Abeg contact /support with this id: `' +
            bought.order_id +
            '` — we go sort am.'
        : `Balance no reach to complete this buy.\nNeed ₦${price.toLocaleString()} · you get ₦${money(deb.balance).toLocaleString()}.\n\nFund and try again.`,
      { parse_mode: 'Markdown' }
    );
  }

  session = deb.session || (await getUserSession(userId));
  const order = {
    orderId: bought.order_id,
    provider: 'grizzly',
    service: serviceId,
    serviceName: serviceId,
    phoneNumber: bought.number,
    price,
    status: 'Waiting SMS',
    date: new Date().toISOString(),
    charged: true,
    refunded: false
  };
  session.orders = [...(session.orders || []), order].slice(-30);
  session.last_options = null;
  session.state = 'AWAITING_INPUT';
  session.pendingService = null;
  await saveUserSession(userId, session);

  // Fresh balance for message
  const balNow = money((await getUserSession(userId)).balance);
  const phone = String(bought.number || '');
  const cancelLabel = `⏳ Cancel (wait ${Math.round(MIN_CANCEL_MS / 60000)}m)`;
  await ctx.reply(
    `Number ready ✅\n📞 \`${phone}\`\n🆔 \`${bought.order_id}\`\n₦${price.toLocaleString()} debited · Balance: ₦${balNow.toLocaleString()}\n\nUse am for the app to request OTP.\nI go auto-check the code — or tap Check anytime.\n\n_Cancel opens after ~${Math.round(MIN_CANCEL_MS / 60000)} minutes._`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [{ text: '📋 Copy number', copy_text: { text: phone } }],
        [Markup.button.callback('Check SMS code', `chk:${bought.order_id}:${price}`)],
        [Markup.button.callback(cancelLabel.slice(0, 64), `can:${bought.order_id}:${price}`)]
      ])
    }
  );
  // Auto-poll SMS status → push code to user when ready
  try {
    const baseUrl =
      process.env.BOT_PUBLIC_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
    if (baseUrl) {
      startStatusPolling(baseUrl, userId, bought.order_id, price, 0).catch((e) =>
        console.error('startStatusPolling', e.message)
      );
    }
  } catch (e) {
    console.error('schedule poll', e.message);
  }
});

bot.action(/^buy:(\d+):([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const price = parseInt(ctx.match[3], 10) || 0;
  const session = await getUserSession(userId);

  const priceN = money(price);
  if (priceN > 0 && money(session.balance) < priceN) {
    return ctx.reply(
      `Balance no reach. Need ₦${priceN.toLocaleString()} · you get ₦${money(session.balance).toLocaleString()}.\nUse /fund to top up.`
    );
  }

  await ctx.reply('I dey grab the number… hold on.');
  const bought = await grizzlyBuy(serviceId, countryId);
  if (!bought.success) {
    return ctx.reply(
      /502|503|gateway|unreachable|timeout/i.test(String(bought.message || ''))
        ? 'Supplier temporarily unavailable. Abeg try again in a few minutes.'
        : /NO_NUMBERS/i.test(String(bought.message || ''))
          ? 'No stock for that country/app right now. Try another country.'
          : `Failed: ${bought.message || 'No number'}`
    );
  }

  const deb = await safeDebit(userId, priceN, { orderId: bought.order_id, service: serviceId, path: 'buy' });
  if (priceN > 0 && !deb.ok) {
    try {
      await grizzlyCancel(bought.order_id);
    } catch (_) {}
    return ctx.reply(
      deb.saveFailed
        ? `Number come out but wallet no update. Contact /support with id \`${bought.order_id}\`.`
        : `Balance no reach. Need ₦${priceN.toLocaleString()} · you get ₦${money(deb.balance).toLocaleString()}.`,
      { parse_mode: 'Markdown' }
    );
  }
  let sess = deb.session || (await getUserSession(userId));
  const order = {
    orderId: bought.order_id,
    provider: 'grizzly',
    service: serviceId,
    serviceName: serviceId,
    phoneNumber: bought.number,
    price: priceN,
    status: 'Waiting for SMS',
    date: new Date().toISOString(),
    charged: true,
    refunded: false
  };
  sess.orders = [...(sess.orders || []), order].slice(-30);
  await saveUserSession(userId, sess);

  const balNow = money((await getUserSession(userId)).balance);
  const phone = String(bought.number || '');
  const cancelLabel = `⏳ Cancel (wait ${Math.round(MIN_CANCEL_MS / 60000)}m)`;
  await ctx.reply(
    `Number ready ✅\n📞 \`${phone}\`\n🆔 \`${bought.order_id}\`\n₦${priceN.toLocaleString()} debited · Balance: ₦${balNow.toLocaleString()}\n\nI go auto-check the code — or tap Check.\n\n_Cancel opens after ~${Math.round(MIN_CANCEL_MS / 60000)} minutes._`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [{ text: '📋 Copy number', copy_text: { text: phone } }],
        [Markup.button.callback('Check SMS code', `chk:${bought.order_id}:${priceN}`)],
        [Markup.button.callback(cancelLabel.slice(0, 64), `can:${bought.order_id}:${priceN}`)]
      ])
    }
  );
  try {
    const baseUrl =
      process.env.BOT_PUBLIC_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
    if (baseUrl) {
      startStatusPolling(baseUrl, userId, bought.order_id, priceN, 0).catch((e) =>
        console.error('startStatusPolling', e.message)
      );
    }
  } catch (e) {
    console.error('schedule poll', e.message);
  }
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
  await ctx.answerCbQuery('Cancelling…');
  const orderId = ctx.match[1];
  const price = parseInt(ctx.match[2], 10) || 0;
  const session = await getUserSession(ctx.from.id);
  const order = (session.orders || []).find((o) => String(o.orderId) === String(orderId));

  // Already cancelled locally — don't double-refund
  if (order && /cancelled/i.test(order.status || '')) {
    return ctx.reply('This order already cancelled.');
  }

  // Dynamic countdown from order.date (default 3 min window)
  const wait = cancelWaitInfo(order || { date: null });
  if (!wait.allowed) {
    const remain = formatWait(wait.waitSec);
    const label = `⏳ ${remain} left`.slice(0, 64);
    try {
      await ctx.answerCbQuery(`⏳ Cancel opens in ${remain}`, { show_alert: true });
    } catch (_) {}
    // Refresh buttons with live remaining time
    const phone = String(order?.phoneNumber || '');
    const kb = {
      inline_keyboard: [
        phone ? [{ text: '📋 Copy number', copy_text: { text: phone } }] : [],
        [{ text: 'Check SMS code', callback_data: `chk:${orderId}:${price}`.slice(0, 64) }],
        [{ text: label, callback_data: `can:${orderId}:${price}`.slice(0, 64) }]
      ].filter((row) => row.length)
    };
    try {
      await ctx.editMessageReplyMarkup(kb);
    } catch (_) {}
    // Also edit message text footer with countdown if possible
    try {
      const base = (ctx.callbackQuery?.message?.text || '').split('\n\n⏳')[0];
      if (base) {
        await ctx.editMessageText(
          `${base}\n\n⏳ Cancel available in *${remain}*\n(Tap Cancel again to refresh timer)`,
          { parse_mode: 'Markdown', reply_markup: kb }
        );
      }
    } catch (_) {}
    return;
  }

  // Fresh session before any money move
  let sess = await getUserSession(ctx.from.id);
  const ord = (sess.orders || []).find((o) => String(o.orderId) === String(orderId));

  if (ord && (/cancelled/i.test(ord.status || '') || ord.refunded === true)) {
    return ctx.reply(
      `This order already cancelled.\nBalance: ₦${money(sess.balance).toLocaleString()}`
    );
  }

  const result = await grizzlyCancel(orderId);
  if (!result.success) {
    return ctx.reply(
      result.early
        ? `Supplier still blocking cancel.\n\nWait a bit more (about ${Math.round(MIN_CANCEL_MS / 60000)} min from purchase), then try again.\nNo refund yet.`
        : `${result.message}\n\nNo refund yet — order still active on supplier.`
    );
  }

  // Refund ONLY the order's recorded price (never trust button alone), once
  const refundAmt = money(ord?.price ?? price);
  let newBal = money(sess.balance);

  if (refundAmt > 0 && ord && ord.refunded !== true) {
    const credited = await safeCredit(ctx.from.id, refundAmt, { orderId, reason: 'cancel' });
    sess = credited.session;
    newBal = credited.balance;
    sess.orders = (sess.orders || []).map((o) =>
      String(o.orderId) === String(orderId)
        ? { ...o, status: 'Cancelled', refunded: true, refunded_amount: refundAmt }
        : o
    );
    await saveUserSession(ctx.from.id, sess);
  } else {
    sess.orders = (sess.orders || []).map((o) =>
      String(o.orderId) === String(orderId) ? { ...o, status: 'Cancelled', refunded: true } : o
    );
    await saveUserSession(ctx.from.id, sess);
    newBal = money(sess.balance);
  }

  // Re-read for display truth
  const finalS = await getUserSession(ctx.from.id);
  await ctx.reply(
    refundAmt > 0
      ? `Cancelled ✅\n₦${refundAmt.toLocaleString()} refunded.\nBalance: ₦${money(finalS.balance).toLocaleString()}`
      : `Cancelled ✅\nBalance: ₦${money(finalS.balance).toLocaleString()}`
  );
});



// ---------- Mira smart flow (works without Gemini) ----------
const MIRA = {
  greet:
    'How far 👋 I be Mira.\n\nI go help you get real number for WhatsApp, Telegram, IG, Google and the rest.\n\nJust yarn e.g.\n• USA WhatsApp\n• UK Telegram\n• or “I need number”\n\nBalance · Fund (even *2k*) · Orders · Support — I dey.',
  askService: 'Which app? WhatsApp, Telegram, Instagram, Google, Facebook, TikTok…',
  askCountry: (svc) =>
    svc ? `Which country for ${svc}? e.g. USA, UK, Nigeria, Canada` : 'Which country you want?',
  noStock: 'That one no dey available right now. Try another country?',
  lowBal: (need, bal) =>
    `Balance no reach o.\nYou need ₦${Number(need).toLocaleString()} · you get ₦${Number(bal).toLocaleString()}.\n\nType /fund ${need} or just *fund ${Math.ceil(Number(need) / 1000)}k*.`,
  yarn: 'I dey. Tell me country + app — like USA WhatsApp — or fund / balance.',
  about:
    'MJ Hub na one place for:\n\n' +
    '• MJ SMS — real numbers for OTP (wetin we dey do here)\n' +
    '• MJ Logs — verified accounts on the website\n' +
    '• MJ Boosters — followers/likes/views on the website\n\n' +
    'Site: mjhub.store\nThis bot wallet separate from the website wallet.\nReferral on the site: 2% for life when your people fund.',
  howSms:
    'E simple:\n\n' +
    '1. Tell me country + app\n' +
    '2. I show price, you buy from wallet\n' +
    '3. You use the number request OTP\n' +
    '4. Code usually land within about 1 minute — tap Check\n' +
    '5. If e no come, cancel after ~3 min for refund\n\n' +
    'Numbers here na real mobile, no be VOIP.',
  fundHelp:
    'To fund:\n• /fund 2k  or  /fund 5000\n• or type fund then amount (2k, 5k, 10k…)\nPaystack go open — after pay, wallet update. You fit also type “I don pay”.\n\nBot wallet ≠ mjhub.store wallet.',
  supportHelp: 'I fit handle number and OTP here. For human support type /support or use mjhub.store.',
};

function detectServiceOnly(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  const entries = Object.entries(SERVICE_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of entries) {
    if (name.length < 2) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
      return { serviceName: name, serviceCode: code };
    }
  }
  return null;
}

function isYes(text) {
  return /^(yes|y|yeah|yep|ok|okay|sure|go|process|buy|do am|ready|proceed|sharp|abeg)\b/i.test(
    String(text || '').trim()
  );
}

function isNo(text) {
  return /^(no|nah|nope|cancel|stop|never mind|later)\b/i.test(String(text || '').trim());
}

function looksLikeNeedNumber(text) {
  return /\b(number|sms|otp|verify|verification|i need|get me|buy|i wan|i want|give me|get number|need number)\b/i.test(
    String(text || '')
  );
}

function looksLikeChitchat(text) {
  const t = String(text || '').toLowerCase().trim();
  return (
    /^(hi|hello|hey|yo|awfa|how far|how you dey|how far na|wetin be your name|what is your name|who are you|good morning|good evening|good afternoon|sup|mira|thanks|thank you|ok|okay|alright|sharp)\b/i.test(
      t
    ) || /your name|who you be|you be who|wetin you (fit|can) do/.test(t)
  );
}

/** Resolve country only if message is mainly a country name (not random chat / amounts) */
async function resolveCountryStrict(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 48) return null;
  // Don't treat questions / chat as countries
  if (/[?]/.test(raw) || looksLikeChitchat(raw)) return null;
  if (detectServiceOnly(raw)) return null;
  // Pure numbers are fund amounts or order ids — never country names
  // (country ids exist, but users type names; numeric-only caused "Checking 3000")
  if (/^[\d,.\s₦nairaNGN]+$/i.test(raw)) return null;

  const words = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // Short 2-letter codes only if the whole message is that code
  if (words.length === 1 && words[0].length <= 2) {
    const key = words[0];
    if (key in COUNTRY_MAP) {
      const id = COUNTRY_MAP[key];
      const live = await grizzlyCountries();
      const hit = live.find((c) => c.id === id);
      return { id, name: asName(hit?.name) || key };
    }
  }
  return resolveCountry(raw);
}

async function miraShowPricesAndConfirm(ctx, session, userId, countryId, countryName, serviceQuery) {
  countryName = asName(countryName) || String(countryName);
  serviceQuery = asName(serviceQuery) || serviceQuery || '';
  await ctx.reply(`Checking ${countryName}${serviceQuery ? ' · ' + serviceQuery : ''}…`);

  let list = await getSellableServices(countryId, serviceQuery);
  if (!list.length) {
    list = await getSellableServices(countryId, null);
    if (serviceQuery) list = matchServices(list, serviceQuery);
  }
  list = dedupeServices(list || []);
  if (!list.length) {
    session.state = 'AWAITING_INPUT';
    session.pendingService = null;
    clearIntent(userId);
    await saveUserSession(userId, session);
    return ctx.reply(MIRA.noStock);
  }
  setIntent(userId, { service: serviceQuery, countryId, countryName });

  session.country = countryName;
  session.countryId = countryId;
  session.serviceQuery = serviceQuery;
  session.pendingService = serviceQuery;
  session.last_options = list.slice(0, 8).map((s) => ({
    service_code: s.service_id,
    name: s.service_name,
    variant: s.variant || 'normal',
    price_ngn: s.price_ngn,
    stock: s.stock,
    country_id: countryId
  }));
  session.state = 'AWAITING_CONFIRM';
  await saveUserSession(userId, session);

  if (list.length === 1) {
    const s = list[0];
    return ctx.reply(
      `${countryName} ${serviceQuery || s.service_name}\n₦${Number(s.price_ngn).toLocaleString()}\n\nYou ready?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `✅ Buy · ₦${Number(s.price_ngn).toLocaleString()}`,
            `opt:${countryId}:${s.service_id}:${s.price_ngn}`.slice(0, 64)
          )
        ],
        [Markup.button.callback('❌ Cancel', 'opt:cancel')]
      ])
    );
  }

  return ctx.reply(
    `${countryName} · ${serviceQuery || 'options'}\nPick one:`,
    optionButtons(countryId, list.slice(0, 8))
  );
}

/** Only real apps count as a service — never junk like "cheaper ones" */
function isRealServiceName(name) {
  if (!name) return false;
  const s = String(name).toLowerCase().trim();
  if (s.length < 2 || s.length > 24) return false;
  if (/cheaper|option|number|price|available|stock|please|help|fund|wallet|balance|country|service/.test(s)) {
    return false;
  }
  if (SERVICE_MAP[s]) return true;
  if (Object.keys(SERVICE_MAP).some((k) => k.length > 2 && (s.includes(k) || k.includes(s)))) return true;
  if (SERVICE_NAMES[s]) return true;
  return false;
}

function clearBuyState(session, userId) {
  session.state = 'AWAITING_INPUT';
  session.pendingService = null;
  session.serviceQuery = null;
  session.country = null;
  session.countryId = null;
  session.last_options = [];
  clearIntent(userId);
}

async function miraHandleSmartText(ctx, session, userId, textMsg) {
  const lower = String(textMsg || '').trim().toLowerCase();
  let state = session.state || 'AWAITING_INPUT';

  // Scrub junk pending service left from old bugs ("cheaper ones", etc.)
  if (session.pendingService && !isRealServiceName(session.pendingService)) {
    session.pendingService = null;
    session.serviceQuery = null;
    if (state === 'AWAITING_COUNTRY') state = 'AWAITING_INPUT';
    session.state = state;
  }
  if (session.serviceQuery && !isRealServiceName(session.serviceQuery)) {
    session.serviceQuery = null;
  }

  // ========== ESCAPE INTENTS (always win over stuck buy flow) ==========
  const wantsFund =
    /\b(fund|top\s*up|topup|deposit|recharge|add\s*money|load\s*wallet|pay\s*in)\b/i.test(lower);
  // Balance ONLY if not a fund request ("fund my wallet" must not match balance)
  const wantsBalance =
    !wantsFund &&
    /\b(balance|check\s*wallet|how\s*much\s*(i\s*get|dey|left)|wallet\s*balance|wetin\s*(remain|left)|what.?s?\s*my\s*balance|my\s*balance)\b/i.test(
      lower
    );
  const wantsCancelFlow =
    /^(cancel|stop|never mind|forget|reset|start over|abeg forget|no more)$/i.test(lower.trim());
  const wantsHelp =
    /^(help|menu|start)$/i.test(lower.trim()) ||
    /\b(wetin you fit do|what can you do|commands?)\b/i.test(lower);

  if (wantsCancelFlow) {
    clearBuyState(session, userId);
    await saveUserSession(userId, session);
    return ctx.reply('Alright, e clear. Wetin you need now? Number, fund, or balance?');
  }

  // FUND first — never confuse with balance
  if (wantsFund) {
    clearBuyState(session, userId);
    const amount = parseNairaAmount(textMsg);
    if (amount >= 1000 && amount <= 200000) {
      const init = await paystackInitialize(amount, userId, null);
      if (!init.success) {
        await saveUserSession(userId, session);
        return ctx.reply(init.message || 'Paystack no gree right now. Try /fund later.');
      }
      const pending = {
        reference: init.reference,
        amount_ngn: init.amount_ngn,
        authorization_url: init.authorization_url,
        created_at: new Date().toISOString()
      };
      session.pending_payment = pending;
      session.state = 'AWAITING_INPUT';
      pendingPayments.set(String(userId), pending);
      await saveUserSession(userId, session);
      return ctx.reply(
        `Top up *₦${init.amount_ngn.toLocaleString()}*\n\nTap *Pay* below.\nWhen e successful, type: *I don pay*`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
        }
      );
    }
    session.state = 'AWAITING_FUND_AMOUNT';
    await saveUserSession(userId, session);
    return ctx.reply(
      'How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\n\nExample: *2k* · *5k* · *5000*',
      { parse_mode: 'Markdown' }
    );
  }

  if (wantsBalance) {
    clearBuyState(session, userId);
    await saveUserSession(userId, session);
    return ctx.reply(`Your balance na *₦${money(session.balance).toLocaleString()}* 💰`, {
      parse_mode: 'Markdown'
    });
  }

  if (wantsHelp || looksLikeChitchat(textMsg)) {
    // Don't trap greetings inside a stuck buy flow
    if (state === 'AWAITING_COUNTRY' || state === 'AWAITING_SERVICE' || state === 'AWAITING_CONFIRM') {
      clearBuyState(session, userId);
      await saveUserSession(userId, session);
    }
    if (wantsHelp) {
      return ctx.reply(MIRA.greet, { parse_mode: 'Markdown' });
    }
    // chitchat falls through only if no active buy — else greet
    if (!session.pendingService && state === 'AWAITING_INPUT') {
      return ctx.reply(
        'How far 👋 I dey. You need number, or you wan check balance / fund wallet?',
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Knowledge FAQ — also escapes stuck flow
  if (
    /\b(what\s*is\s*mj\s*(hub|sms)|about\s*mj|wetin\s*be\s*mj|mj\s*hub\s*na\s*wetin|tell\s*me\s*about)\b/i.test(
      lower
    )
  ) {
    clearBuyState(session, userId);
    await saveUserSession(userId, session);
    return ctx.reply(MIRA.about, { parse_mode: 'Markdown' });
  }
  if (/\b(how\s*(does|do|e\s*dey)\s*work|how\s*to\s*(buy|get|use)|how\s*sms\s*work)\b/i.test(lower)) {
    clearBuyState(session, userId);
    await saveUserSession(userId, session);
    return ctx.reply(MIRA.howSms, { parse_mode: 'Markdown' });
  }

  // Merge: memory intent + supabase session + reply-to message (only REAL services)
  const mem = getIntent(userId) || {};
  const replyCtx = contextFromReply(ctx);
  if (replyCtx.service && isRealServiceName(replyCtx.service) && !session.pendingService) {
    session.pendingService = replyCtx.service;
    session.serviceQuery = replyCtx.service;
  }
  if (mem.service && isRealServiceName(mem.service) && !session.pendingService) {
    session.pendingService = mem.service;
    session.serviceQuery = mem.service;
  }
  if (mem.countryId && !session.countryId) {
    session.countryId = mem.countryId;
    session.country = mem.countryName || session.country;
  }
  if (session.pendingService && isRealServiceName(session.pendingService) && !state.startsWith('AWAITING')) {
    state = 'AWAITING_COUNTRY';
    session.state = 'AWAITING_COUNTRY';
  }

  // --- Confirm ---
  if (state === 'AWAITING_CONFIRM') {
    if (isNo(lower)) {
      session.state = 'AWAITING_INPUT';
      session.pendingService = null;
      session.last_options = [];
      await saveUserSession(userId, session);
      return ctx.reply('Alright. Wetin else?');
    }
    if (isYes(lower) && session.last_options?.length) {
      const s = session.last_options[0];
      const countryId = session.countryId || s.country_id;
      const price = money(s.price_ngn);
      if (money(session.balance) < price) {
        return ctx.reply(MIRA.lowBal(price, session.balance), {
          ...Markup.inlineKeyboard([[Markup.button.callback('💳 Fund', 'menu:fund')]])
        });
      }
      await ctx.reply('I dey grab the number… hold on.');
      const bought = await grizzlyBuy(s.service_code, countryId);
      if (!bought.success) {
        return ctx.reply(
          /502|503|gateway|unreachable|timeout/i.test(String(bought.message || ''))
            ? 'Supplier offline now. Try again small time.'
            : `E no work: ${bought.message || 'No number'}`
        );
      }
      const deb = await safeDebit(userId, price, { orderId: bought.order_id, path: 'confirm' });
      if (price > 0 && !deb.ok) {
        try {
          await grizzlyCancel(bought.order_id);
        } catch (_) {}
        return ctx.reply(
          deb.saveFailed
            ? `Number come out but wallet no update. Contact /support with id \`${bought.order_id}\`.`
            : MIRA.lowBal(price, deb.balance),
          { parse_mode: 'Markdown' }
        );
      }
      Object.assign(session, deb.session || {});
      session.balance = money(deb.balance);
      const order = {
        orderId: bought.order_id,
        service: s.service_code,
        serviceName: s.name,
        phoneNumber: bought.number,
        price,
        status: 'Waiting for SMS',
        date: new Date().toISOString(),
        countryId,
        charged: true,
        refunded: false
      };
      session.orders = [...(session.orders || []), order].slice(-30);
      session.state = 'AWAITING_INPUT';
      session.pendingService = null;
      session.last_options = [];
      await saveUserSession(userId, session);
      const balNow = money((await getUserSession(userId)).balance);
      const phone = String(bought.number || '');
      const cancelLabel = `⏳ Cancel (wait ${Math.round(MIN_CANCEL_MS / 60000)}m)`;
      try {
        const baseUrl =
          process.env.BOT_PUBLIC_URL ||
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
        if (baseUrl) {
          startStatusPolling(baseUrl, userId, bought.order_id, price, 0).catch((e) =>
            console.error('startStatusPolling', e.message)
          );
        }
      } catch (e) {
        console.error('schedule poll', e.message);
      }
      return ctx.reply(
        `Number ready ✅\n📞 \`${phone}\`\n🆔 \`${bought.order_id}\`\n₦${price.toLocaleString()} debited · Balance: ₦${balNow.toLocaleString()}\n\nUse am for OTP. I go auto-check — or tap Check.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [{ text: '📋 Copy number', copy_text: { text: phone } }],
            [Markup.button.callback('Check SMS code', `chk:${bought.order_id}:${price}`)],
            [Markup.button.callback(cancelLabel.slice(0, 64), `can:${bought.order_id}:${price}`)]
          ])
        }
      );
    }
  }

  // --- Waiting for country (service already known — REAL apps only) ---
  {
    const rawPending =
      session.pendingService || session.serviceQuery || mem.service || replyCtx.service || null;
    const svcPending = isRealServiceName(rawPending) ? rawPending : null;
    if (!svcPending && (session.pendingService || session.serviceQuery)) {
      // Drop junk and don't trap the user
      session.pendingService = null;
      session.serviceQuery = null;
      if (state === 'AWAITING_COUNTRY') {
        state = 'AWAITING_INPUT';
        session.state = 'AWAITING_INPUT';
      }
    }
    const c = await resolveCountryStrict(textMsg);
    if (c && svcPending) {
      return miraShowPricesAndConfirm(ctx, session, userId, c.id, c.name, svcPending);
    }
    if (state === 'AWAITING_COUNTRY' && svcPending && !c && !detectServiceOnly(textMsg)) {
      return ctx.reply(
        `Which country for *${svcPending}*?\n\n_Reply with country name e.g. USA, UK, Nigeria_`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // --- Waiting for service (country already known) ---
  if (state === 'AWAITING_SERVICE' || session.countryId) {
    const svc = detectServiceOnly(textMsg);
    if (svc && session.countryId) {
      return miraShowPricesAndConfirm(
        ctx,
        session,
        userId,
        session.countryId,
        session.country || session.countryId,
        svc.serviceName
      );
    }
    if (state === 'AWAITING_SERVICE' && !svc) {
      return ctx.reply(MIRA.askService);
    }
  }

  // Recover pending service / country from session (REAL services only)
  const pendingSvcRaw = session.pendingService || session.serviceQuery || null;
  const pendingSvc = isRealServiceName(pendingSvcRaw) ? pendingSvcRaw : null;
  const pendingCountryId = session.countryId || null;
  const pendingCountryName = session.country || null;

  // --- One-shot: country + service together ---
  const parsed = await parseCountryService(textMsg);
  if (parsed.countryId && (parsed.serviceName || parsed.serviceCode)) {
    return miraShowPricesAndConfirm(
      ctx,
      session,
      userId,
      parsed.countryId,
      parsed.countryName,
      parsed.serviceName || parsed.serviceCode
    );
  }

  // Country message while we already have a pending service → process
  const countryGuess = await resolveCountryStrict(textMsg);
  if (countryGuess && pendingSvc) {
    return miraShowPricesAndConfirm(
      ctx,
      session,
      userId,
      countryGuess.id,
      countryGuess.name,
      pendingSvc
    );
  }

  // Service message while we already have a country → process
  const svcGuess =
    detectServiceOnly(textMsg) ||
    (parsed.serviceName && isRealServiceName(parsed.serviceName)
      ? { serviceName: parsed.serviceName, serviceCode: parsed.serviceCode }
      : null);
  if (svcGuess && pendingCountryId) {
    return miraShowPricesAndConfirm(
      ctx,
      session,
      userId,
      pendingCountryId,
      pendingCountryName || pendingCountryId,
      svcGuess.serviceName || svcGuess.serviceCode
    );
  }

  // Service only → ask country (keep service in session)
  if (svcGuess || (parsed.serviceName && isRealServiceName(parsed.serviceName)) || parsed.serviceCode) {
    const svc = svcGuess || {
      serviceName: parsed.serviceName,
      serviceCode: parsed.serviceCode
    };
    session.pendingService = svc.serviceName || svc.serviceCode;
    session.serviceQuery = session.pendingService;
    session.state = 'AWAITING_COUNTRY';
    setIntent(userId, { service: session.pendingService });
    await saveUserSession(userId, session);
    // Ask as reply-friendly text so user can reply to this message
    return ctx.reply(
      `Which country for ${session.pendingService}?\n\n_Reply to this message with the country_`,
      { parse_mode: 'Markdown' }
    );
  }

  // Country only (no pending service) → ask service
  if (countryGuess) {
    const svcNowRaw =
      session.pendingService || session.serviceQuery || replyCtx.service || mem.service || null;
    const svcNow = isRealServiceName(svcNowRaw) ? svcNowRaw : null;
    if (svcNow) {
      return miraShowPricesAndConfirm(ctx, session, userId, countryGuess.id, countryGuess.name, svcNow);
    }
    session.countryId = countryGuess.id;
    session.country = countryGuess.name;
    session.state = 'AWAITING_SERVICE';
    setIntent(userId, { countryId: countryGuess.id, countryName: countryGuess.name });
    await saveUserSession(userId, session);
    return ctx.reply(
      `Which app for *${asName(countryGuess.name)}*?\n\nWhatsApp, Telegram, Instagram, Google…`,
      { parse_mode: 'Markdown' }
    );
  }

  if (looksLikeNeedNumber(textMsg)) {
    clearBuyState(session, userId);
    session.state = 'AWAITING_SERVICE';
    await saveUserSession(userId, session);
    return ctx.reply(MIRA.askService);
  }

  if (/\b(orders?|history|my\s*numbers?)\b/i.test(lower)) {
    const list = (session.orders || []).filter((o) => o && o.orderId && o.type !== '_meta');
    if (!list.length) {
      return ctx.reply('You never buy any number yet.\n\nType e.g. *USA WhatsApp* make I get one for you.', {
        parse_mode: 'Markdown'
      });
    }
    const lines = list
      .slice(-8)
      .reverse()
      .map((o, i) => {
        const phone = String(o.phoneNumber || o.number || '').trim() || '—';
        const svc = o.serviceName || o.service || 'SMS';
        return `${i + 1}. *${svc}* · \`${phone}\` · ${o.status || '—'}`;
      })
      .join('\n');
    return ctx.reply(`*Your recent orders*\n\n${lines}`, { parse_mode: 'Markdown' });
  }

  if (/\b(referral|2%|commission|invite)\b/i.test(lower)) {
    return ctx.reply(
      'For referral: go *mjhub.store*, sign up, copy your link.\nWhen your people fund, you earn *2% for life* on the website wallet.',
      { parse_mode: 'Markdown' }
    );
  }

  if (/\b(voip|real\s*number|is\s*it\s*real)\b/i.test(lower)) {
    return ctx.reply(
      'Numbers here na *real mobile* (non-VOIP). Dem dey work well for WhatsApp and major apps.\n\nTell me country + app e.g. *USA WhatsApp*.',
      { parse_mode: 'Markdown' }
    );
  }

  if (/\b(support|human|customer\s*care)\b/i.test(lower)) {
    return ctx.reply(MIRA.supportHelp);
  }

  // Soft fallback — Pidgin, helpful, not stuck
  return ctx.reply(
    'I no too catch that one.\n\n' +
      'Talk to me like:\n' +
      '• *USA WhatsApp* — buy number\n' +
      '• *Fund* or */fund 5000* — top up\n' +
      '• *Balance* — check wallet\n' +
      '• *How e dey work?* — explain SMS\n' +
      '• *Cancel* — clear and start fresh',
    { parse_mode: 'Markdown' }
  );
}

bot.on('text', async (ctx) => {
  const textMsg = (ctx.message.text || '').trim();
  if (textMsg.startsWith('/')) return;

  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const lower = textMsg.toLowerCase();

  // --- "I don pay" / payment confirmation (works without Gemini) ---
  if (/^(i\s*don\s*pay|i\s*have\s*paid|i\s*paid|payment\s*done|don\s*pay|paid)\b/i.test(lower)) {
    const mem = pendingPayments.get(String(userId));
    const ref = session.pending_payment?.reference || mem?.reference;
    if (!ref) {
      return ctx.reply('I no see any pending payment. Type /fund 2000 (or amount) first, pay, then come back.');
    }
    const verified = await paystackVerify(ref);
    if (!verified.success) {
      return ctx.reply(
        verified.message ||
          'Payment never show success yet. If you don pay, wait 30 seconds and type: I don pay'
      );
    }
    if (session.last_credited_reference === ref || creditedRefs.has(ref)) {
      return ctx.reply(
        `This payment already credited.\nBalance: ₦${money(session.balance).toLocaleString()}`
      );
    }
    session.balance = money(money(session.balance) + money(verified.amount_ngn));
    session.last_credited_reference = ref;
    session.pending_payment = null;
    pendingPayments.delete(String(userId));
    creditedRefs.add(ref);
    await saveUserSession(userId, session);
    return ctx.reply(
      `Payment confirmed ✅\n₦${money(verified.amount_ngn).toLocaleString()} don enter your wallet.\nNew balance: ₦${money(session.balance).toLocaleString()}\n\nYou fit buy number now — tell me country + app.`
    );
  }

  // --- FUND WALLET amount (after /fund, Fund button, or "fund my wallet") ---
  // Also accept bare amounts like 2k / 5000 if user clearly just got asked to fund
  const isFundAmountState = session.state === 'AWAITING_FUND_AMOUNT';
  const looksLikeOnlyAmount =
    /^(?:₦|ngn|naira)?\s*\d+(?:[.,]\d+)?\s*k?\s*$/i.test(textMsg.trim()) ||
    /^\d+(?:[.,]\d+)?\s*(?:k|thousand)\s*$/i.test(textMsg.trim());

  if (isFundAmountState || (looksLikeOnlyAmount && session.pending_payment == null && parseNairaAmount(textMsg) >= 1000)) {
    // If bare amount without state, only treat as fund if previous bot message was about funding
    // — we rely on AWAITING_FUND_AMOUNT primarily; bare amount alone is OK when state set
    if (isFundAmountState || session.state === 'AWAITING_FUND_AMOUNT') {
      const amount = parseNairaAmount(textMsg);
      if (amount < 1000) {
        return ctx.reply('Minimum na ₦1,000. Type *2k*, *5k* or *5000*.', {
          parse_mode: 'Markdown'
        });
      }
      if (amount > 200000) {
        return ctx.reply('Maximum na ₦200,000 for one payment. Example: *50k*', {
          parse_mode: 'Markdown'
        });
      }
      const init = await paystackInitialize(amount, userId, null);
      if (!init.success) {
        session.state = 'AWAITING_INPUT';
        await saveUserSession(userId, session);
        return ctx.reply(init.message || 'Paystack no gree right now. Try /fund again later.');
      }
      const pending = {
        reference: init.reference,
        amount_ngn: init.amount_ngn,
        authorization_url: init.authorization_url,
        created_at: new Date().toISOString()
      };
      session.pending_payment = pending;
      session.state = 'AWAITING_INPUT';
      pendingPayments.set(String(userId), pending);
      await saveUserSession(userId, session);
      return ctx.reply(
        `Top up *₦${init.amount_ngn.toLocaleString()}*\n\nTap *Pay* below.\nWhen e successful, type: *I don pay*`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
        }
      );
    }
  }

  // Fund intent BEFORE Gemini — Gemini was asking for amount without setting state
  const fundIntent =
    /\b(fund|top\s*up|topup|deposit|recharge|add\s*money|load\s*wallet|pay\s*in)\b/i.test(lower);
  if (fundIntent) {
    return miraHandleSmartText(ctx, session, userId, textMsg);
  }

  // Keep country session if still browsing
  if (session.countryId && session.state === 'AWAITING_APP') {
    const svc = detectServiceOnly(textMsg) || (await parseCountryService(textMsg));
    const q = svc.serviceName || svc.serviceCode || textMsg;
    return miraShowPricesAndConfirm(ctx, session, userId, session.countryId, session.country, q);
  }

  // Gemini optional enhancement for pure chat — Mira owns buy + fund path
  const buyIntent =
    looksLikeNeedNumber(textMsg) ||
    fundIntent ||
    session.state === 'AWAITING_FUND_AMOUNT' ||
    !!(await parseCountryService(textMsg)).countryId ||
    !!(await parseCountryService(textMsg)).serviceName ||
    ['AWAITING_SERVICE', 'AWAITING_COUNTRY', 'AWAITING_CONFIRM', 'AWAITING_FUND_AMOUNT'].includes(
      session.state
    ) ||
    detectServiceOnly(textMsg);

  if (GEMINI_API_KEY && !buyIntent && session.state === 'AWAITING_INPUT') {
    try {
      const result = await callGeminiWithTools(session, userId, textMsg);
      // Persist conversation + any side-effects from tools (balance, pending_payment, etc.)
      if (result?.contents) {
        session.conversation = result.contents
          .filter((c) => c.role === 'user' || c.role === 'model')
          .slice(-MAX_CONVERSATION_TURNS);
      }
      await saveUserSession(userId, session);

      if (result?.quota) {
        return miraHandleSmartText(ctx, session, userId, textMsg);
      }
      if (result?.modelFail) {
        return miraHandleSmartText(ctx, session, userId, textMsg);
      }
      const replyText = result?.reply;
      if (replyText && replyText !== 'QUOTA_EXCEEDED' && replyText !== 'MODEL_UNAVAILABLE') {
        // If create_payment tool ran, attach Pay button instead of raw URL
        if (session.pending_payment?.authorization_url) {
          return ctx.reply(
            replyText.slice(0, 3500),
            Markup.inlineKeyboard([
              [Markup.button.url('💳 Pay here', session.pending_payment.authorization_url)]
            ])
          );
        }
        const opts = session.last_options || [];
        if (opts.length > 1 && session.countryId) {
          return ctx.reply(
            replyText.slice(0, 4000),
            optionButtons(
              session.countryId,
              opts.map((o) => ({
                service_id: o.service_code,
                service_name: o.name,
                price_ngn: o.price_ngn,
                variant: o.variant
              }))
            )
          );
        }
        return ctx.reply(replyText.slice(0, 4000));
      }
    } catch (e) {
      console.error('gemini text', e.message);
    }
  }

  // Built-in Mira smart conversation (always on)
  return miraHandleSmartText(ctx, session, userId, textMsg);
});


async function showServiceOptions(ctx, session, userId, countryId, countryName, serviceQuery) {
  countryName = asName(countryName) || `country ${countryId}`;
  serviceQuery = asName(serviceQuery) || serviceQuery;
  await ctx.reply(`Checking *${countryName}* prices…`, { parse_mode: 'Markdown' });
  let list = await getSellableServices(countryId, serviceQuery);
  if (!list.length) {
    list = await getSellableServices(countryId, null);
    if (serviceQuery) list = matchServices(list, serviceQuery);
  }
  if (!list.length) {
    return ctx.reply('No numbers available for that option right now. Try another country or app.');
  }

  list = dedupeServices(list);

  session.country = countryName;
  session.countryId = countryId;
  session.serviceQuery = serviceQuery;
  session.last_options = list.slice(0, 8).map((s) => ({
    service_code: s.service_id,
    name: s.service_name,
    variant: s.variant || 'normal',
    price_ngn: s.price_ngn,
    stock: s.stock,
    country_id: countryId
  }));
  session.state = 'AWAITING_INPUT';
  await saveUserSession(userId, session);

  // Single supplier option → one buy button (no fake Normal/Virtual pair)
  if (list.length === 1) {
    const s = list[0];
    return ctx.reply(
      `*${s.service_name}* · ${countryName}\n₦${Number(s.price_ngn).toLocaleString()}\n\nTap to buy:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(
            `✅ Buy · ₦${Number(s.price_ngn).toLocaleString()}`,
            `opt:${countryId}:${s.service_id}:${s.price_ngn}`.slice(0, 64)
          )],
          [Markup.button.callback('⬅️ Cancel', 'opt:cancel')]
        ])
      }
    );
  }

  // Multiple real service_ids from supplier only
  return ctx.reply(
    `*${countryName}* · ${serviceQuery || 'services'}\n\nSelect an option:`,
    {
      parse_mode: 'Markdown',
      ...optionButtons(countryId, list.slice(0, 8))
    }
  );
}

bot.catch((err) => console.error('bot error', err));

// ---------- SMS status: webhook + auto-poll ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find which Telegram user owns this activation id */
async function findUserIdByOrderId(orderId) {
  if (!orderId || !SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) return null;
  const oid = String(orderId).trim();
  try {
    // orders is jsonb array — filter rows updated recently and scan
    const res = await axios.get(
      `${SUPABASE_REST_URL}/user_sessions?select=user_id,orders&orders=not.is.null&order=updated_at.desc&limit=80`,
      { ...axiosCfg, headers: sbHeaders }
    );
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const row of rows) {
      const orders = row.orders || [];
      if (orders.some((o) => o && String(o.orderId) === oid)) {
        return String(row.user_id);
      }
    }
  } catch (e) {
    console.error('findUserIdByOrderId', e.message);
  }
  return null;
}

/** Persist code on order + DM the customer */
async function deliverCodeToUser(telegramUserId, orderId, code, fullText) {
  const session = await getUserSession(telegramUserId);
  let found = false;
  session.orders = (session.orders || []).map((o) => {
    if (String(o.orderId) === String(orderId)) {
      found = true;
      return { ...o, status: `Code: ${code}`, sms_text: fullText || null, code_at: new Date().toISOString() };
    }
    return o;
  });
  if (!found) {
    session.orders = [
      ...(session.orders || []),
      {
        orderId: String(orderId),
        status: `Code: ${code}`,
        sms_text: fullText || null,
        code_at: new Date().toISOString()
      }
    ].slice(-30);
  }
  await saveUserSession(telegramUserId, session);
  const msg =
    `Your code don drop ✅\n\n` +
    `*${code}*\n` +
    (fullText && fullText !== code ? `\n_${String(fullText).slice(0, 200)}_\n` : '') +
    `\nOrder: \`${orderId}\`\nCopy sharp. You need another number?`;
  try {
    await bot.telegram.sendMessage(telegramUserId, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('deliverCodeToUser send', e.message);
  }
  return true;
}

/**
 * Handle inbound SMS status (webhook body or polled result).
 * Accepts SMS-Activate style:
 *   { activationId, code, text, service, country, receivedAt }
 * or our internal: { order_id, code, text, telegram_user_id }
 */
async function handleSmsStatusPayload(body) {
  const orderId =
    body.activationId ||
    body.activation_id ||
    body.id ||
    body.order_id ||
    body.orderId ||
    null;
  const code = body.code || body.sms_code || body.otp || null;
  const text = body.text || body.sms || body.message || null;
  let userId =
    body.telegram_user_id ||
    body.telegramUserId ||
    body.user_id ||
    null;

  if (!orderId) return { ok: false, error: 'missing order/activation id' };

  // Extract code from text if needed
  let finalCode = code ? String(code).trim() : '';
  if (!finalCode && text) {
    const m = String(text).match(/\b(\d{4,8})\b/);
    if (m) finalCode = m[1];
  }
  if (!finalCode) return { ok: false, error: 'no code yet', waiting: true, orderId };

  if (!userId) userId = await findUserIdByOrderId(orderId);
  if (!userId) {
    console.error('[status] no user for order', orderId);
    return { ok: false, error: 'user not found for order', orderId, code: finalCode };
  }

  // Skip if already delivered
  const session = await getUserSession(userId);
  const existing = (session.orders || []).find((o) => String(o.orderId) === String(orderId));
  if (existing && /Code:\s*\d/i.test(String(existing.status || ''))) {
    return { ok: true, already: true, orderId, code: finalCode };
  }

  await deliverCodeToUser(userId, orderId, finalCode, text);
  return { ok: true, orderId, code: finalCode, userId };
}

/** After buy: poll Grizzly a few times and push code when ready (serverless-friendly chain) */
async function startStatusPolling(baseUrl, telegramUserId, orderId, price, attempt = 0) {
  const maxAttempts = Number(process.env.STATUS_POLL_ATTEMPTS) || 18; // ~18 * 8s ≈ 2.5 min
  const delayMs = Number(process.env.STATUS_POLL_MS) || 8000;
  const secret = process.env.WEBHOOK_SECRET || process.env.INTERNAL_POLL_SECRET || '';

  try {
    const st = await grizzlyStatus(orderId);
    if (st.success && st.code) {
      await handleSmsStatusPayload({
        order_id: orderId,
        code: st.code,
        telegram_user_id: String(telegramUserId)
      });
      return { done: true, code: st.code };
    }
  } catch (e) {
    console.error('[poll] status', e.message);
  }

  if (attempt + 1 >= maxAttempts) {
    console.log('[poll] give up', orderId, 'user', telegramUserId);
    try {
      await bot.telegram.sendMessage(
        telegramUserId,
        `Code never drop yet for order \`${orderId}\`.\nTap *Check SMS code* on the order message, or cancel when the timer allow.`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
    return { done: false, exhausted: true };
  }

  // Chain next poll via HTTP so each Vercel invocation stays short
  const nextUrl = `${baseUrl.replace(/\/$/, '')}/api/poll-status`;
  setTimeout(() => {
    axios
      .post(
        nextUrl,
        {
          telegram_user_id: String(telegramUserId),
          order_id: String(orderId),
          price: price || 0,
          attempt: attempt + 1
        },
        {
          timeout: 8000,
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-internal-secret': secret } : {})
          }
        }
      )
      .catch((e) => console.error('[poll] chain', e.message));
  }, Math.min(delayMs, 2000)); // schedule soon; actual wait is between invocations via attempt spacing

  // Also wait a bit in-process once (helps first few checks)
  if (attempt === 0) {
    await sleep(Math.min(delayMs, 6000));
    try {
      const st2 = await grizzlyStatus(orderId);
      if (st2.success && st2.code) {
        await handleSmsStatusPayload({
          order_id: orderId,
          code: st2.code,
          telegram_user_id: String(telegramUserId)
        });
        return { done: true, code: st2.code };
      }
    } catch (_) {}
  }

  return { done: false, scheduled: true, attempt: attempt + 1 };
}

// ---------- Vercel / local handler ----------

module.exports = async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = `${proto}://${host}`;
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
    const pathOnly = String(req.url || '').split('?')[0];

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
      return res.end('MJ SMS Bot — online');
    }

    // Paystack webhook / callback credit
    if (req.method === 'POST' && (pathOnly === '/paystack' || pathOnly.startsWith('/paystack') || pathOnly === '/api/paystack')) {
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
            session.balance = money(money(session.balance) + amountNgn);
            session.last_credited_reference = reference;
            session.pending_payment = null;
            await saveUserSession(telegramUserId, session);
            try {
              await bot.telegram.sendMessage(
                telegramUserId,
                `Payment confirmed ✅\n₦${amountNgn.toLocaleString()} don enter your wallet.\nNew balance: ₦${money(session.balance).toLocaleString()}\n\nYou fit buy number now. Just tell me country and app.`
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

    // SMS status webhook (Grizzly / SMS-Activate style callback)
    // URL: https://YOUR-BOT.vercel.app/api/status  or  /status
    if (
      req.method === 'POST' &&
      (pathOnly === '/status' ||
        pathOnly === '/api/status' ||
        pathOnly === '/sms-status' ||
        pathOnly === '/api/sms-status' ||
        pathOnly.startsWith('/status'))
    ) {
      let body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      // Also accept query-string style (some providers GET/POST form)
      try {
        const u = new URL(base + (req.url || '/'));
        for (const [k, v] of u.searchParams) {
          if (body[k] == null) body[k] = v;
        }
      } catch (_) {}
      const result = await handleSmsStatusPayload(body);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(result));
    }

    // Internal status poller (chained after purchase)
    if (
      req.method === 'POST' &&
      (pathOnly === '/poll-status' || pathOnly === '/api/poll-status')
    ) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const internal = process.env.WEBHOOK_SECRET || process.env.INTERNAL_POLL_SECRET || '';
      if (internal && req.headers['x-internal-secret'] !== internal) {
        res.statusCode = 401;
        return res.end('unauthorized');
      }
      const userId = body.telegram_user_id || body.userId;
      const orderId = body.order_id || body.orderId;
      const attempt = Number(body.attempt) || 0;
      const price = body.price || 0;
      if (!userId || !orderId) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'userId and orderId required' }));
      }
      // Space polls: each invocation does one check; chain with delay
      await sleep(Number(process.env.STATUS_POLL_MS) || 8000);
      const out = await startStatusPolling(base, userId, orderId, price, attempt);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(out));
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
