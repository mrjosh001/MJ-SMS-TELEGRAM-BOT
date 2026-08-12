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
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_KEY) return;
  // Only columns that exist on user_sessions. conversation column is NOT in schema.
  const orders = [...(session.orders || [])].filter((o) => o && o.type !== '_meta');
  orders.push({
    type: '_meta',
    pending_payment: session.pending_payment || null,
    last_credited_reference: session.last_credited_reference || null,
    // keep short conversation in JSON orders meta (no dedicated column)
    conversation: (session.conversation || []).slice(-8)
  });
  const payload = {
    user_id: String(userId),
    balance: Number(session.balance) || 0,
    state: session.state || 'AWAITING_INPUT',
    country: session.country || null,
    country_id: session.countryId || null,
    selected_service_query: session.serviceQuery || null,
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
        const name = String(c.eng || c.english || c.name || c.country_name || c.title || '').trim();
        if (Number.isFinite(id) && id >= 0 && name) list.push({ id, name });
      }
    } else if (data && typeof data === 'object') {
      for (const [k, info] of Object.entries(data)) {
        const id = Number(info?.id ?? info?.country ?? k);
        const name = String(info?.eng || info?.english || info?.name || info?.country_name || '').trim();
        if (Number.isFinite(id) && id >= 0 && name) list.push({ id, name });
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
  if (!boughtAt) return { allowed: true, waitMs: 0, waitSec: 0 };
  const elapsed = Date.now() - new Date(boughtAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return { allowed: true, waitMs: 0, waitSec: 0 };
  if (elapsed >= MIN_CANCEL_MS) return { allowed: true, waitMs: 0, waitSec: 0 };
  const waitMs = MIN_CANCEL_MS - elapsed;
  return { allowed: false, waitMs, waitSec: Math.ceil(waitMs / 1000) };
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

const GEMINI_SYSTEM_PROMPT = `You be Mira. You work for MJ SMS under MJ HUB. You be real human support and sales for Telegram. You no be AI, robot, or system.

VOICE:
Natural Nigerian WhatsApp chat. Pidgin + simple English. Short. Fluent. Warm. Street-smart. No essays, no bullet walls, no "As an AI", no re-intro every message. Continue the same conversation.

WHAT MJ HUB IS (know this deep):
MJ HUB na digital services marketplace with one ecosystem:
1) MJ SMS — temporary real mobile numbers for SMS OTP verification
2) MJ Logs — premium verified social accounts (website)
3) MJ Boosters — social growth (Instagram, TikTok, YouTube, etc. on website)
This Telegram bot handles MJ SMS number verification only.

MJ SMS HOW E DEY WORK:
- Customer type any country + app freely (e.g. Australia WhatsApp, Portugal Telegram, Japan Google). No fixed country list for them.
- Dem pay from wallet in Naira (₦)
- System give phone number
- Customer use the number for the app to request OTP
- SMS code land → dem ask you to check → you give the code
- One number = one verification cycle. After code, dem free
- If code never come and still eligible, cancel fit refund wallet
- Numbers are real mobile routes for OTP (not random VOIP spam lines). Some countries still show more than one option for the same app (e.g. Normal vs Virtual / alternate routes). Prices and stock change live.

NORMAL VS VIRTUAL / MULTIPLE OPTIONS (VERY IMPORTANT):
- For some countries (especially USA and others), one app fit get more than one service option: Normal, Virtual, or alternate routes with different price and stock.
- ANY time get_prices or buy_number return more than one option, briefly list them AND tell the user to tap the buttons below (Normal / Virtual). Telegram will show tappable buttons. Wait for their pick before buy_number.
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
    return { id, name: hit ? hit.name : key };
  }

  // Exact match on live Grizzly country name
  let hit = live.find((c) => c.name.toLowerCase() === key);
  if (hit) return { id: hit.id, name: hit.name };

  // Starts-with / contains on live names (prefer longer names)
  const ranked = live
    .map((c) => ({ ...c, n: c.name.toLowerCase() }))
    .filter((c) => c.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);

  hit = ranked.find((c) => c.n.startsWith(key) || key.startsWith(c.n));
  if (hit) return { id: hit.id, name: hit.name };

  hit = ranked.find((c) => c.n.includes(key) || key.includes(c.n));
  if (hit) return { id: hit.id, name: hit.name };

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
      let refunded = 0;
      if (order && order.price > 0) {
        refunded = order.price;
        session.balance = (Number(session.balance) || 0) + refunded;
      }
      session.orders = (session.orders || []).map((o) =>
        String(o.orderId) === String(orderId) ? { ...o, status: 'Cancelled' } : o
      );
      return {
        success: true,
        order_id: orderId,
        refunded_ngn: refunded,
        new_balance_ngn: session.balance
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

bot.start(async (ctx) => {
  const greeting = GEMINI_API_KEY
    ? `How far 👋 Welcome to *MJ SMS*.\n\nI fit get virtual number for WhatsApp, Telegram, Google, Instagram and plenty more. Just talk normal like:\n"I need USA WhatsApp"\n"Nigeria Telegram how much?"\n\n/balance — check wallet\n/fund 2000 — top up\n/orders — your history\n\nWetin you need right now?`
    : `Welcome to *MJ SMS*\n\nType country + app, e.g.\n*USA WhatsApp*\n*Nigeria Telegram*\n*UK Google*\n\n/balance /fund /orders /status`;
  await ctx.reply(greeting, { parse_mode: 'Markdown' });
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
  if (bal == null) return ctx.reply('Supplier: OFFLINE');
  await ctx.reply(`*Supplier:* ONLINE\nBalance: \`${bal}\``, {
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
  const price = parseInt(ctx.match[3], 10) || 0;
  const userId = ctx.from.id;
  const session = await getUserSession(userId);

  if (price > 0 && session.balance < price) {
    return ctx.reply(
      `Balance no reach. You need ₦${price.toLocaleString()}.\nYour balance: ₦${Number(session.balance || 0).toLocaleString()}.\n\nType /fund ${price} to top up.`
    );
  }

  await ctx.reply('I dey grab the number… hold on.');
  const bought = await grizzlyBuy(serviceId, countryId);
  if (!bought.success) {
    return ctx.reply(/502|503|gateway|unreachable|timeout/i.test(String(bought.message || '')) ? 'Supplier temporarily unavailable. Abeg try again in a few minutes.' : `E no work: ${bought.message || 'No number available. Try another option.'}`);
  }

  if (price > 0) session.balance = Math.max(0, session.balance - price);
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
  session.last_options = null;
  await saveUserSession(userId, session);

  const phone = String(bought.number || '');
  await ctx.reply(
    `Number ready ✅\n📞 \`${phone}\`\n🆔 \`${bought.order_id}\`\n\nUse am for the app to request OTP.\nWhen you ready, tap Check.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [{ text: '📋 Copy number', copy_text: { text: phone } }],
        [Markup.button.callback('Check SMS code', `chk:${bought.order_id}:${price}`)],
        [Markup.button.callback('Cancel + refund', `can:${bought.order_id}:${price}`)]
      ])
    }
  );
});

bot.action(/^buy:(\d+):([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const countryId = ctx.match[1];
  const serviceId = ctx.match[2];
  const price = parseInt(ctx.match[3], 10) || 0;
  const session = await getUserSession(userId);

  if (price > 0 && session.balance < price) {
    return ctx.reply('Insufficient balance. Use /fund to top up your wallet.');
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

  const phone = String(bought.number || '');
  await ctx.reply(
    `Number ready ✅\n📞 \`${phone}\`\n🆔 \`${bought.order_id}\`\n\nTap below when the SMS arrives.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [{ text: '📋 Copy number', copy_text: { text: phone } }],
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
  await ctx.answerCbQuery('Cancelling…');
  const orderId = ctx.match[1];
  const price = parseInt(ctx.match[2], 10) || 0;
  const session = await getUserSession(ctx.from.id);
  const order = (session.orders || []).find((o) => String(o.orderId) === String(orderId));

  // Already cancelled locally — don't double-refund
  if (order && /cancelled/i.test(order.status || '')) {
    return ctx.reply('This order already cancelled.');
  }

  // Local timer aligned with supplier early-cancel window (default 3 minutes)
  const wait = cancelWaitInfo(order);
  if (!wait.allowed) {
    return ctx.reply(
      `Too early to cancel.\n\nSupplier needs about ${Math.round(MIN_CANCEL_MS / 60000)} minutes after purchase.\nTry again in *${formatWait(wait.waitSec)}*.`,
      { parse_mode: 'Markdown' }
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

  let refunded = 0;
  if (price > 0) {
    refunded = price;
    session.balance = (Number(session.balance) || 0) + price;
  }
  session.orders = (session.orders || []).map((o) =>
    String(o.orderId) === String(orderId) ? { ...o, status: 'Cancelled' } : o
  );
  await saveUserSession(ctx.from.id, session);
  await ctx.reply(
    refunded > 0
      ? `Cancelled ✅\n₦${refunded.toLocaleString()} refunded.\nBalance: ₦${Number(session.balance).toLocaleString()}`
      : 'Cancelled ✅'
  );
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
    const geminiResult = await callGeminiWithTools(session, userId, text);

    // Quota / model failure → fall through to classic keyword flow so bot still works
    if (!(geminiResult.quota || geminiResult.modelFail || geminiResult.reply === 'QUOTA_EXCEEDED' || geminiResult.reply === 'MODEL_UNAVAILABLE')) {
      const { reply, contents } = geminiResult;
      const slim = [];
      for (const c of (contents || []).slice(-MAX_CONVERSATION_TURNS)) {
        const texts = (c.parts || []).map((p) => p.text).filter(Boolean);
        if (!texts.length) continue;
        slim.push({ role: c.role, parts: [{ text: texts.join('\n') }] });
      }
      session.conversation = slim.slice(-MAX_CONVERSATION_TURNS);
      await saveUserSession(userId, session);

      const memPay = pendingPayments.get(String(userId)) || session.pending_payment;
      let payUrl = memPay?.authorization_url || null;
      let textOut = reply;

      if (payUrl || /checkout\.paystack\.com/i.test(textOut || '')) {
        textOut = String(textOut || '')
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

      let sendOpts = {};
      if (payUrl) {
        sendOpts = Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', payUrl)]]);
      } else if (session.last_options && session.last_options.length > 1) {
        const cid = session.last_options[0].country_id || session.countryId;
        sendOpts = optionButtons(cid, session.last_options.map((o) => ({
          service_id: o.service_code,
          service_name: o.name,
          variant: o.variant,
          price_ngn: o.price_ngn
        })));
      } else if (session.last_options && session.last_options.length === 1) {
        const o = session.last_options[0];
        const cid = o.country_id || session.countryId;
        sendOpts = Markup.inlineKeyboard([
          [Markup.button.callback(
            `✅ Buy ${o.name} · ₦${Number(o.price_ngn).toLocaleString()}`,
            `opt:${cid}:${o.service_code}:${o.price_ngn}`.slice(0, 64)
          )],
          [Markup.button.callback('⬅️ Cancel', 'opt:cancel')]
        ]);
      }
      try {
        await ctx.reply(textOut, { parse_mode: 'Markdown', ...sendOpts });
      } catch (_) {
        await ctx.reply(textOut, sendOpts);
      }
      return;
    }
  }

  // Fallback: smart manual flow (works without Gemini)
  const lower = text.toLowerCase().trim();
  const sessionState = session.state || 'AWAITING_INPUT';

  // --- Greetings / help ---
  if (/^(hi|hello|hey|yo|awfa|how far|how you dey|good morning|good evening|sup|wetin|help)\b/i.test(lower)
      || lower === 'menu' || lower === 'start') {
    return ctx.reply(
      'How far 👋 Welcome to MJ SMS.\n\nI fit get number for WhatsApp, Telegram, Google, Instagram and more.\n\nPick country or type like: USA WhatsApp',
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
        ],
        [Markup.button.callback('💳 Fund wallet', 'menu:fund')],
        [Markup.button.callback('💰 Balance', 'menu:bal')]
      ])
    );
  }

  // --- Fund intent ---
  if (/^(fund|top ?up|deposit|recharge)\b/i.test(lower) || /fund my wallet|top up/i.test(lower)) {
    const amountMatch = lower.match(/(\d[\d,]{2,}|[1-9]\d{2,})/);
    if (!amountMatch) {
      session.state = 'AWAITING_FUND_AMOUNT';
      await saveUserSession(userId, session);
      return ctx.reply('How much you wan fund?\n\nMin ₦1,000 · Max ₦200,000\n\nExample: 5000');
    }
    let amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
    if (amount < 1000) return ctx.reply('Minimum na ₦1,000.');
    if (amount > 200000) return ctx.reply('Maximum na ₦200,000.');
    const init = await paystackInitialize(amount, userId, null);
    if (!init.success) return ctx.reply(init.message || 'Paystack no gree.');
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
      `Top up ₦${init.amount_ngn.toLocaleString()}\n\nTap Pay below.\nWhen e successful, type: I don pay`,
      Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
    );
  }

  // Awaiting fund amount only
  if (sessionState === 'AWAITING_FUND_AMOUNT') {
    const amount = parseInt(lower.replace(/[^\d]/g, ''), 10) || 0;
    if (amount < 1000 || amount > 200000) {
      return ctx.reply('Enter amount between ₦1,000 and ₦200,000. Example: 5000');
    }
    const init = await paystackInitialize(amount, userId, null);
    if (!init.success) return ctx.reply(init.message || 'Paystack no gree.');
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
      `Top up ₦${init.amount_ngn.toLocaleString()}\n\nTap Pay below.\nWhen e successful, type: I don pay`,
      Markup.inlineKeyboard([[Markup.button.url('💳 Pay here', init.authorization_url)]])
    );
  }

  // --- I don pay ---
  if (/i don pay|i have paid|payment done|don pay|paid already/i.test(lower)) {
    const mem = pendingPayments.get(String(userId));
    const ref = session.pending_payment?.reference || mem?.reference;
    if (!ref) {
      return ctx.reply('I no see pending payment. Type /fund 2000 to start one.');
    }
    const verified = await paystackVerify(ref);
    if (!verified.success) {
      return ctx.reply(verified.message || 'Payment never show success yet. Wait small and try again.');
    }
    if (session.last_credited_reference === ref || creditedRefs.has(ref)) {
      return ctx.reply(`This payment already credited.\nBalance: ₦${Number(session.balance || 0).toLocaleString()}`);
    }
    session.balance = (Number(session.balance) || 0) + (Number(verified.amount_ngn) || 0);
    session.last_credited_reference = ref;
    session.pending_payment = null;
    pendingPayments.delete(String(userId));
    creditedRefs.add(ref);
    await saveUserSession(userId, session);
    return ctx.reply(
      `Payment confirmed ✅\n₦${Number(verified.amount_ngn).toLocaleString()} don enter.\nNew balance: ₦${Number(session.balance).toLocaleString()}\n\nYou fit buy number now. Type country + app e.g. USA WhatsApp`
    );
  }

  // --- Need number / buy intent without details ---
  if (/^(i need number|need number|buy number|i wan number|virtual number|otp|get number)\b/i.test(lower)
      || lower === 'number') {
    session.state = 'AWAITING_COUNTRY';
    await saveUserSession(userId, session);
    return ctx.reply(
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
          Markup.button.callback('🇮🇳 India', 'cty:22')
        ],
        [Markup.button.callback('⬅️ Main menu', 'menu:home')]
      ])
    );
  }

  // If we have country in session and user only sent app name
  const _parsedEarly = await parseCountryService(text);
  if (session.countryId && !_parsedEarly.countryId) {
    const maybeApp = parseCountryService('nigeria ' + text); // reuse app matcher
    // simpler: check SERVICE_MAP keys in text
    let appHit = null;
    for (const [name, code] of Object.entries(SERVICE_MAP)) {
      if (name.length < 2) continue;
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(lower)) {
        appHit = { name, code };
        break;
      }
    }
    if (appHit) {
      return showServiceOptions(ctx, session, userId, session.countryId, session.country || 'selected', appHit.name);
    }
  }

  // --- Country + app in one message ---
  const parsed = await parseCountryService(text);
  if (parsed.countryId && (parsed.serviceCode || parsed.serviceName)) {
    return showServiceOptions(ctx, session, userId, parsed.countryId, parsed.countryName, parsed.serviceName || parsed.serviceCode);
  }

  if (parsed.countryId && !parsed.serviceCode) {
    session.country = parsed.countryName;
    session.countryId = parsed.countryId;
    session.state = 'AWAITING_APP';
    await saveUserSession(userId, session);
    return ctx.reply(
      `Country: *${parsed.countryName}*\n\nWhich app you need number for?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('WhatsApp', `app:${parsed.countryId}:whatsapp`),
            Markup.button.callback('Telegram', `app:${parsed.countryId}:telegram`)
          ],
          [
            Markup.button.callback('Google', `app:${parsed.countryId}:google`),
            Markup.button.callback('Instagram', `app:${parsed.countryId}:instagram`)
          ],
          [
            Markup.button.callback('Facebook', `app:${parsed.countryId}:facebook`),
            Markup.button.callback('TikTok', `app:${parsed.countryId}:tiktok`)
          ],
          [Markup.button.callback('⬅️ Change country', 'menu:home')]
        ])
      }
    );
  }

  // Last attempt: free-text country resolve + optional app
  const lastTry = await resolveCountry(text.split(/\s+/)[0] || text);
  if (lastTry) {
    const appGuess = await parseCountryService(text);
    if (appGuess.serviceName || appGuess.serviceCode) {
      return showServiceOptions(
        ctx,
        session,
        userId,
        lastTry.id,
        lastTry.name,
        appGuess.serviceName || appGuess.serviceCode
      );
    }
    session.country = lastTry.name;
    session.countryId = lastTry.id;
    session.state = 'AWAITING_APP';
    await saveUserSession(userId, session);
    return ctx.reply(
      `Country: *${lastTry.name}*\n\nWhich app?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('WhatsApp', `app:${lastTry.id}:whatsapp`),
            Markup.button.callback('Telegram', `app:${lastTry.id}:telegram`)
          ],
          [
            Markup.button.callback('Google', `app:${lastTry.id}:google`),
            Markup.button.callback('Instagram', `app:${lastTry.id}:instagram`)
          ],
          [
            Markup.button.callback('Facebook', `app:${lastTry.id}:facebook`),
            Markup.button.callback('TikTok', `app:${lastTry.id}:tiktok`)
          ]
        ])
      }
    );
  }

  return ctx.reply(
    'I no catch that one clear.\n\nType like: *Australia WhatsApp* or *USA Telegram*',
    { parse_mode: 'Markdown' }
  );
});

async function showServiceOptions(ctx, session, userId, countryId, countryName, serviceQuery) {
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
      return res.end('MJ SMS Bot — online');
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
