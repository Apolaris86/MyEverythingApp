// MyEverythingApp price relay (Cloudflare Worker).
// Fetches Yahoo Finance chart data server-side and returns it with CORS for the GitHub Pages site.
// Response shapes match ThePekFinance's /api so the app can use either:
//   GET /api/quotes?symbols=AAPL,MSFT        -> [{symbol, name, price, change, changePercent, previousClose, currency, marketState, timestamp}]
//   GET /api/histories?symbols=AAPL&range=6M -> { AAPL: [{time, close}], ... }   (time in seconds)
//   GET /api/fx                              -> { USD: 1, AUD: <US$ per A$>, EUR, SGD }

const ALLOWED_ORIGINS = ["https://apolaris86.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];
const MAX_SYMBOLS = 45; // free Workers allow 50 outbound requests per call
const SYMBOL_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;
const RANGES = {
  "1D": ["1d", "5m"], "5D": ["5d", "1d"], "1M": ["1mo", "1d"], "6M": ["6mo", "1d"],
  "YTD": ["ytd", "1d"], "1Y": ["1y", "1d"], "2Y": ["2y", "1d"], "5Y": ["5y", "1wk"], "MAX": ["max", "1mo"]
};
const QUOTE_TTL = 15, HISTORY_TTL = 3600, FX_TTL = 300; // seconds
const UA = "Mozilla/5.0 (compatible; MyEverythingApp price relay)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, cors);

    // Edge cache per full URL, so many tabs share one Yahoo call.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);

    let res;
    try {
      if (url.pathname === "/api/quotes") res = await quotes(url);
      else if (url.pathname === "/api/histories") res = await histories(url);
      else if (url.pathname === "/api/fx") res = await fx();
      else if (url.pathname === "/" || url.pathname === "/health") res = json({ ok: true, service: "MyEverythingApp price relay" }, 200);
      else res = json({ error: "Not found" }, 404);
    } catch (e) {
      res = json({ error: e.message || "Market data unavailable" }, e.status || 502);
    }
    if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return withCors(res, cors);
  }
};

function corsHeaders(origin) {
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function withCors(res, cors) {
  const r = new Response(res.body, res);
  Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}
function json(body, status, extra) {
  const ttl = status === 200 ? (body && body.__ttl) || 0 : 0;
  if (body && body.__ttl) delete body.__ttl;
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": ttl ? `public, max-age=${ttl}` : "no-store", ...(extra || {}) }
  });
}
function bad(message) { const e = new Error(message); e.status = 400; throw e; }

function parseSymbols(url) {
  const raw = (url.searchParams.get("symbols") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const syms = [...new Set(raw)];
  if (!syms.length || syms.length > MAX_SYMBOLS) bad(`Pass 1-${MAX_SYMBOLS} comma-separated symbols`);
  if (syms.some(s => !SYMBOL_RE.test(s))) bad("Invalid symbol");
  return syms;
}

async function chart(symbol, range, interval) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error(`Yahoo answered ${r.status}`), { status: 502 });
  const data = await r.json();
  return data && data.chart && data.chart.result && data.chart.result[0] || null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
  }));
  return out;
}

async function quotes(url) {
  const syms = parseSymbols(url);
  const results = await pool(syms, 10, s => chart(s, "1d", "5m"));
  const out = [];
  results.forEach((c, k) => {
    const m = c && c.meta; if (!m || m.regularMarketPrice == null) return;
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    const change = prev != null ? price - prev : 0;
    out.push({
      symbol: syms[k], name: m.longName || m.shortName || undefined, currency: m.currency,
      price, change, changePercent: prev ? change / prev * 100 : 0, previousClose: prev,
      marketState: marketState(m), timestamp: (m.regularMarketTime || 0) * 1000, quoteType: m.instrumentType
    });
  });
  if (!out.length) throw Object.assign(new Error("Market data unavailable"), { status: 502 });
  out.__ttl = QUOTE_TTL;
  return json(Object.assign(out, {}), 200);
}
function marketState(m) {
  const now = Date.now() / 1000, p = m.currentTradingPeriod;
  if (!p) return undefined;
  if (now >= p.regular.start && now < p.regular.end) return "REGULAR";
  if (p.pre && now >= p.pre.start && now < p.pre.end) return "PRE";
  if (p.post && now >= p.post.start && now < p.post.end) return "POST";
  return "CLOSED";
}

async function histories(url) {
  const syms = parseSymbols(url);
  const key = (url.searchParams.get("range") || "1M").toUpperCase();
  const r = RANGES[key]; if (!r) bad("Invalid range");
  const results = await pool(syms, 10, s => chart(s, r[0], r[1]));
  const out = {};
  results.forEach((c, k) => {
    const t = (c && c.timestamp) || [], q = c && c.indicators && c.indicators.quote && c.indicators.quote[0];
    const closes = (q && q.close) || [];
    out[syms[k]] = t.map((time, i) => ({ time, close: closes[i] })).filter(p => p.close != null);
  });
  out.__ttl = HISTORY_TTL;
  return json(out, 200);
}

async function fx() {
  const pairs = { AUD: "AUDUSD=X", EUR: "EURUSD=X", SGD: "SGDUSD=X" };
  const keys = Object.keys(pairs);
  const res = await pool(keys, 3, k => chart(pairs[k], "1d", "5m"));
  const out = { USD: 1 };
  res.forEach((c, i) => { const p = c && c.meta && c.meta.regularMarketPrice; if (p) out[keys[i]] = p; });
  if (!out.AUD) throw Object.assign(new Error("FX unavailable"), { status: 502 });
  out.__ttl = FX_TTL;
  return json(out, 200);
}
