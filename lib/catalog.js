// What can be bought, and at what price, for each server.
//   Server 1 (Grizzly): live stock from the supplier, selling price from the website's
//                       number_services (source = grizzlysms), formula fallback if missing.
//   Server 2 (SMS-Bus): website number_services (source = smsbus) — same admin prices as the site.
// Every query filters by `source`, so one supplier's price can never leak into another.
const axios = require('axios');
const { grizzly, smsbus } = require('./providers');
const { COUNTRY_MAP, SERVICE_SEARCH, SIBLINGS, asName, friendlyServiceName, normCountry, money } = require('./util');

const RAW = (process.env.MJ_HUB_REST_URL || process.env.MJ_HUB_SUPABASE_URL || process.env.MJHUB_SUPABASE_URL || '').replace(/\/$/, '');
const REST = RAW && !/\/rest\/v1$/i.test(RAW) ? `${RAW}/rest/v1` : RAW;
const KEY = process.env.MJ_HUB_SERVICE_KEY || process.env.MJ_HUB_SUPABASE_SERVICE_KEY || process.env.MJHUB_SERVICE_KEY || '';
const hub = { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, timeout: 15000 };

const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1500;
const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT) || 60;   // only used when the website has no price row
const MIN_SALE = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

const fallbackPrice = (usd) =>
  Math.max(MIN_SALE, Math.ceil((Number(usd) || 0) * USD_TO_NGN * (1 + MARKUP_PERCENT / 100) / 50) * 50);

// ---------- countries ----------
const cache = {};
async function cached(key, loader) {
  const hit = cache[key];
  if (hit && Date.now() - hit.at < SIX_HOURS) return hit.list;
  try {
    const list = await loader();
    if (list.length) { cache[key] = { at: Date.now(), list }; return list; }
  } catch (e) { console.error('countries', key, e.message); }
  return hit ? hit.list : [];
}

const grizzlyCountries = () => cached('g', async () => {
  const data = await grizzly.raw({ action: 'getCountries' });
  const rows = Array.isArray(data) ? data : Object.entries(data || {}).map(([k, v]) => ({ id: v?.id ?? k, ...v }));
  return rows
    .map((c) => ({ id: String(c.id ?? c.country), name: asName(c.eng || c.english || c.name || c.title) }))
    .filter((c) => /^\d+$/.test(c.id) && c.name);
});

const busCountries = () => cached('b', async () => {
  const d = await smsbus.get('/list/countries');
  if (!smsbus.ok(d)) return [];
  return Object.values(d.data || {}).map((c) => ({ id: String(c.id), name: String(c.title || c.name || c.id) }));
});

function pickCountry(list, name) {
  const key = normCountry(name);
  if (!key) return null;
  return list.find((c) => c.name.toLowerCase() === key)
    || list.find((c) => c.name.toLowerCase().startsWith(key))
    || list.find((c) => key.length >= 4 && c.name.toLowerCase().includes(key))
    || null;
}

/** Resolve a typed country for a given server. */
async function findCountry(server, name) {
  if (server === 2) return pickCountry(await busCountries(), name);
  const live = pickCountry(await grizzlyCountries(), name);
  if (live) return live;
  const id = COUNTRY_MAP[String(name || '').toLowerCase().trim()];
  return id != null ? { id: String(id), name: String(name) } : null;
}

/** Country names we can spot inside a free-text message (live lists + aliases). */
async function knownCountryNames() {
  const [g, b] = await Promise.all([grizzlyCountries(), busCountries()]);
  return [...new Set([...g, ...b].map((c) => c.name).filter((n) => n.length >= 4))];
}

// ---------- Server 1 ----------
async function grizzlyPrices(countryId) {
  const data = await grizzly.raw({ action: 'getPricesV3', country: String(countryId) });
  const block = (data && (data[String(countryId)] || data[countryId])) || data || {};
  const out = [];
  for (const [code, info] of Object.entries(block)) {
    if (!code || !info || typeof info !== 'object') continue;
    const usd = Number(info.cost ?? info.price ?? info.rate ?? 0);
    const stock = Number(info.count ?? info.phones ?? info.qty ?? 0);
    if (usd > 0) out.push({ id: String(code), name: friendlyServiceName(code, info.name || info.service || info.eng || code), usd, stock });
  }
  return out;
}

async function hubGrizzlyPrices(countryId, ids) {
  const map = new Map();
  if (!REST || !KEY || !ids.length) return map;
  const list = ids.map((i) => `"${String(i).replace(/"/g, '')}"`).join(',');
  const url = `${REST}/number_services?select=service_id,price,is_available&source=eq.grizzlysms&country_id=eq.${encodeURIComponent(countryId)}` +
    `&service_id=in.(${list})&price=gt.0&order=price.asc&limit=200`;
  try {
    const rows = (await axios.get(url, hub)).data || [];
    for (const r of rows) {
      if (r.is_available === false) continue;
      const k = String(r.service_id).toLowerCase();
      if (!map.has(k)) map.set(k, money(r.price));
    }
  } catch (e) { console.error('hubGrizzlyPrices', e.message); }
  return map;
}

async function server1(countryId, code, onlyId) {
  const pools = SIBLINGS[Number(countryId)] || [Number(countryId)];
  const out = [];
  for (const cid of pools) {
    let live = [];
    try { live = await grizzlyPrices(cid); } catch (e) { console.error('grizzlyPrices', cid, e.message); }
    live = live.filter((s) => s.stock > 0 && (onlyId ? s.id === onlyId : s.id.toLowerCase() === code || s.id.toLowerCase().startsWith(`${code}_`)));
    if (!live.length) continue;
    const prices = await hubGrizzlyPrices(cid, live.map((s) => s.id));
    for (const s of live) {
      out.push({
        server: 1, provider: 'grizzly', countryId: String(cid),
        countryName: cid === 187 ? 'USA (2)' : (cid === 12 ? 'USA' : ''),
        serviceId: s.id, serviceName: s.name, stock: s.stock,
        price: prices.get(s.id.toLowerCase()) || fallbackPrice(s.usd)
      });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

// ---------- Server 2 ----------
async function server2(countryId, code, onlyId) {
  if (!REST || !KEY) return [];
  const term = SERVICE_SEARCH[code] || code;
  const filter = onlyId
    ? `&service_id=eq.${encodeURIComponent(onlyId)}`
    : `&service_name=ilike.*${encodeURIComponent(term)}*`;
  const url = `${REST}/number_services?select=service_id,service_name,country_id,country_name,price,available_quantity,is_available` +
    `&source=eq.smsbus&country_id=eq.${encodeURIComponent(countryId)}${filter}&price=gt.0&is_available=eq.true&available_quantity=gt.0&order=price.asc&limit=10`;
  try {
    const rows = (await axios.get(url, hub)).data || [];
    return rows.map((r) => ({
      server: 2, provider: 'smsbus', countryId: String(r.country_id), countryName: r.country_name || '',
      serviceId: String(r.service_id), serviceName: friendlyServiceName(r.service_id, r.service_name),
      stock: Number(r.available_quantity) || 0, price: money(r.price)
    }));
  } catch (e) {
    console.error('server2', e.message);
    return [];
  }
}

/**
 * Options for "<country> <app>" across both servers.
 * @param countryText what the user typed (e.g. "USA")
 * @param code Grizzly service code (e.g. "wa")
 */
async function options(countryText, code) {
  const [c1, c2] = await Promise.all([findCountry(1, countryText), findCountry(2, countryText)]);
  const [a, b] = await Promise.all([
    c1 ? server1(c1.id, code).catch(() => []) : [],
    c2 ? server2(c2.id, code).catch(() => []) : []
  ]);
  const label = c1?.name || c2?.name || countryText;
  return { country: label, list: [...a, ...b] };
}

/** Fresh price + availability for one exact option (used right before charging). */
async function quote(server, countryId, serviceId) {
  const list = server === 2 ? await server2(countryId, null, serviceId) : await server1(countryId, null, serviceId);
  return list[0] || null;
}

module.exports = { options, quote, findCountry, knownCountryNames, grizzlyCountries, busCountries };
