// Mira = friendly chat layer. She can LOOK things up (prices, balance, orders, OTP status)
// but she cannot spend money: buying, cancelling and funding only happen from button taps
// or explicit commands handled in api/index.js.
const axios = require('axios');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_ROUNDS = 5;
const MAX_TURNS = 12;

const SYSTEM = `You be Mira, the MJ SMS Assistant for MJ Hub (mjhub.store).
Talk Nigerian Pidgin mixed with clear English — natural, short, friendly. No robot vibe.

Your work: help people get real SMS numbers for OTP on this Telegram bot, and answer questions about MJ SMS / MJ Hub.

STRICT RULES
- NEVER invent a price, stock, number, OTP code, balance, order status or payment status. Use tools.
- If a tool fails or returns nothing, say so plainly and suggest another country/app.
- You CANNOT buy, cancel, refund or fund. Prices come with Buy buttons that the customer taps; they fund with /fund 5000 (or "fund 5k"); they cancel with the Cancel button on the order. Tell them this when relevant.
- Never mention suppliers, API keys, Gemini, or internal systems. You are Mira.
- Bot wallet and mjhub.store wallet are separate.
- MJ Logs / MJ Boosters: only on mjhub.store, not in this bot.

Facts: two servers — Server 1 and Server 2 — different stock and prices, both real numbers. OTP usually lands within a minute. Cancel opens after ~1 min (Server 2) or ~3 min (Server 1). Fund min ₦1,000, max ₦200,000 via Paystack.
When someone types "<country> <app>" call get_prices straight away.`;

const TOOLS = [{
  functionDeclarations: [
    { name: 'get_prices', description: 'Live prices and stock for an app in a country, across both servers. Call before quoting any price.',
      parameters: { type: 'OBJECT', properties: { country: { type: 'STRING' }, service: { type: 'STRING', description: 'App name e.g. WhatsApp' } }, required: ['country', 'service'] } },
    { name: 'get_balance', description: "Customer's wallet balance in Naira.", parameters: { type: 'OBJECT', properties: {} } },
    { name: 'get_my_orders', description: 'Recent orders for this customer.', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'check_status', description: 'Check if the OTP arrived for the latest (or given) order.',
      parameters: { type: 'OBJECT', properties: { order_id: { type: 'STRING' } } } }
  ]
}];

/** exec(name, args) -> result object (provided by the bot). Returns { reply, history, quota } */
async function chat(history, userText, exec) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { reply: null };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const contents = [...(history || []), { role: 'user', parts: [{ text: userText }] }];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let res;
    try {
      res = await axios.post(url, {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents, tools: TOOLS, toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      }, { timeout: 25000, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const msg = String(e.response?.data?.error?.message || e.message || '');
      console.error('gemini', e.response?.status, msg);
      return { reply: null, failed: true };
    }
    const parts = res.data?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    contents.push({ role: 'model', parts });
    if (!calls.length) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return { reply: text || null, history: trim(contents) };
    }
    const out = [];
    for (const p of calls) {
      let result;
      try { result = await exec(p.functionCall.name, p.functionCall.args || {}); }
      catch (e) { result = { error: 'Tool failed. Tell the customer to try again.' }; }
      out.push({ functionResponse: { name: p.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: out });
  }
  return { reply: null, history: trim(contents) };
}

// keep only plain text turns in saved history (tool plumbing is not worth storing)
function trim(contents) {
  return contents
    .filter((c) => (c.role === 'user' || c.role === 'model') && c.parts?.every((p) => typeof p.text === 'string'))
    .slice(-MAX_TURNS);
}

module.exports = { chat };
