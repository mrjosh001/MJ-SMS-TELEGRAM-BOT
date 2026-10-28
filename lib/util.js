// Shared constants + tiny helpers (no I/O here)

// Grizzly / SMS-Activate style country ids. Two-letter codes are limited on purpose
// ("it", "in", "no", "id" would otherwise match normal English words).
const COUNTRY_MAP = {
  nigeria: 19, naija: 19, ng: 19,
  usa: 12, us: 12, america: 12, 'united states': 12,
  uk: 16, britain: 16, england: 16, 'united kingdom': 16,
  ghana: 38, gh: 38, kenya: 8, ke: 8, 'south africa': 31,
  india: 22, canada: 36, germany: 43, deutschland: 43, france: 78, netherlands: 48,
  indonesia: 6, philippines: 4, brazil: 73, mexico: 54, turkey: 62, egypt: 21,
  russia: 0, ukraine: 1, poland: 15, spain: 56, italy: 86, china: 3, vietnam: 10,
  thailand: 52, malaysia: 7, australia: 175, belarus: 51, japan: 182,
  'south korea': 103, korea: 103, uae: 95, dubai: 95, emirates: 95, 'united arab emirates': 95,
  portugal: 117, pakistan: 66, bangladesh: 60, morocco: 37, argentina: 39, colombia: 33,
  chile: 151, peru: 65, romania: 32, sweden: 46, norway: 174, denmark: 172, finland: 163,
  ireland: 23, 'new zealand': 67, singapore: 196, 'hong kong': 14, taiwan: 55, israel: 13,
  'saudi arabia': 53, saudi: 53, iraq: 40, serbia: 29, croatia: 45, hungary: 84,
  czech: 63, 'czech republic': 63, austria: 50, switzerland: 173, belgium: 82,
  cameroon: 41, 'ivory coast': 27, senegal: 61, uganda: 75, tanzania: 9, ethiopia: 71
};

// words people type -> Grizzly service code
const SERVICE_MAP = {
  whatsapp: 'wa', wa: 'wa', telegram: 'tg', tg: 'tg', google: 'go', gmail: 'go',
  facebook: 'fb', fb: 'fb', instagram: 'ig', ig: 'ig', twitter: 'tw',
  tiktok: 'lf', discord: 'ds', snapchat: 'fu', snap: 'fu', microsoft: 'mm',
  amazon: 'am', apple: 'wx', uber: 'ub', viber: 'vi', netflix: 'nf', paypal: 'ts',
  bumble: 'mo', tinder: 'oi', linkedin: 'tn', signal: 'aaw', wechat: 'we', imo: 'im'
};

// service word -> text used to search Server 2 project names
const SERVICE_SEARCH = {
  wa: 'whatsapp', tg: 'telegram', go: 'google', fb: 'facebook', ig: 'instagram', tw: 'twitter',
  lf: 'tiktok', ds: 'discord', fu: 'snapchat', mm: 'microsoft', am: 'amazon', wx: 'apple',
  ub: 'uber', vi: 'viber', nf: 'netflix', ts: 'paypal', mo: 'bumble', oi: 'tinder',
  tn: 'linkedin', aaw: 'signal', we: 'wechat', im: 'imo'
};

const SERVICE_NAMES = {
  aaw: 'Signal', am: 'Amazon', ds: 'Discord', fb: 'Facebook', fu: 'Snapchat', go: 'Google',
  ig: 'Instagram', im: 'Imo', lf: 'TikTok', me: 'Line', mm: 'Microsoft', mo: 'Bumble',
  nf: 'Netflix', oi: 'Tinder', ot: 'Any other', tg: 'Telegram', tn: 'LinkedIn', ts: 'PayPal',
  tw: 'X / Twitter', vi: 'Viber', wa: 'WhatsApp', we: 'WeChat', wx: 'Apple'
};

// Grizzly has two pools for some countries
const SIBLINGS = { 12: [12, 187], 187: [12, 187] };

const money = (n) => Math.max(0, Math.round(Number(n) || 0));
const ngn = (n) => `₦${money(n).toLocaleString('en-US')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function asName(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object') return String(v.eng || v.english || v.name || v.title || v.country || v.label || '').trim();
  return '';
}

function friendlyServiceName(code, raw) {
  const c = String(code || '').toLowerCase();
  const r = String(raw || '').trim();
  if (r && r.toLowerCase() !== c && !/^gr_/i.test(r)) return r.replace(/_/g, ' ');
  return SERVICE_NAMES[c] || c.toUpperCase();
}

/** 2k -> 2000, 1.5k -> 1500, 10,000 -> 10000. Returns 0 if nothing useful. */
function parseNaira(text) {
  const raw = String(text || '').toLowerCase().replace(/,/g, '');
  let m = raw.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = raw.match(/(\d+(?:\.\d+)?)\s*(?:thousand|thsd)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

function formatWait(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m <= 0) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** "USA" / "UK" / "UAE" -> the long names suppliers use */
function normCountry(name) {
  const k = String(name || '').toLowerCase().trim();
  const alias = {
    usa: 'united states', us: 'united states', america: 'united states',
    uk: 'united kingdom', britain: 'united kingdom', england: 'united kingdom',
    uae: 'united arab emirates', dubai: 'united arab emirates', emirates: 'united arab emirates',
    naija: 'nigeria', korea: 'south korea', saudi: 'saudi arabia', czech: 'czech republic'
  };
  return alias[k] || k;
}

module.exports = {
  COUNTRY_MAP, SERVICE_MAP, SERVICE_SEARCH, SERVICE_NAMES, SIBLINGS,
  money, ngn, sleep, esc, asName, friendlyServiceName, parseNaira, formatWait, normCountry
};
