import ICAL from "ical.js";

// MyEverythingApp relay (Cloudflare Worker): prices, news headlines and today's calendar.
// Fetches Yahoo Finance chart data server-side and returns it with CORS for the GitHub Pages site.
// Response shapes match ThePekFinance's /api so the app can use either:
//   GET /api/quotes?symbols=AAPL,MSFT        -> [{symbol, name, price, change, changePercent, previousClose, currency, marketState, timestamp}]
//   GET /api/histories?symbols=AAPL&range=6M -> { AAPL: [{time, close}], ... }   (time in seconds)
//   GET /api/fx                              -> { USD: 1, AUD: <US$ per A$>, EUR, SGD }
//   GET /api/news?feeds=world,au,hu,finance,tech&n=3 -> { world: [{title, url, source, published}], ... }
//   GET /api/calendar?url=<Google Calendar secret iCal address>&from=<ms>&to=<ms>&day=YYYY-MM-DD
//        -> [{title, start, end, allDay, location}] for that day (recurring events expanded)

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
      else if (url.pathname === "/api/news") res = await news(url);
      else if (url.pathname === "/api/calendar") { res = await calendar(url); return withCors(res, cors); } // private: never edge-cached
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

/* ---------- news: Google News RSS ---------- */
// Each section tries Google News first, then a direct publisher feed (Google can refuse requests from Cloudflare).
const FEEDS = {
  world:   ["https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-AU&gl=AU&ceid=AU:en", "https://feeds.bbci.co.uk/news/world/rss.xml|BBC News"],
  au:      ["https://news.google.com/rss?hl=en-AU&gl=AU&ceid=AU:en", "https://www.abc.net.au/news/feed/45910/rss.xml|ABC News"],
  hu:      ["https://news.google.com/rss?hl=hu&gl=HU&ceid=HU:hu", "https://telex.hu/rss|Telex"],
  finance: ["https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-AU&gl=AU&ceid=AU:en", "https://feeds.bbci.co.uk/news/business/rss.xml|BBC Business"],
  tech:    ["https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-AU&gl=AU&ceid=AU:en", "https://techcrunch.com/feed/|TechCrunch"]
};
const NEWS_TTL = 600;
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
function parseRss(xml, n) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1], tag = t => { const x = it.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">")); return x ? decode(x[1]) : ""; };
    const source = tag("source");
    let title = tag("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const published = Date.parse(tag("pubDate")) || null;
    if (title) out.push({ title, url: tag("link"), source, published });
    if (out.length >= n) break;
  }
  return out;
}
async function news(url) {
  const keys = (url.searchParams.get("feeds") || Object.keys(FEEDS).join(",")).split(",").filter(k => FEEDS[k]);
  if (!keys.length) bad("Unknown feed");
  const n = Math.min(10, Math.max(1, +url.searchParams.get("n") || 3));
  const status = {};
  const res = await pool(keys, 5, async k => {
    const tried = [];
    for (const entry of FEEDS[k]) {
      const [feedUrl, name] = entry.split("|");
      const host = new URL(feedUrl).hostname;
      try {
        const r = await fetch(feedUrl, { headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml" }, redirect: "follow" });
        if (!r.ok) { tried.push(host + " " + r.status); continue; }
        const items = parseRss(await r.text(), n).map(it => ({ ...it, source: it.source || name || host }));
        if (items.length) { status[k] = host + (tried.length ? " (after " + tried.join(", ") + ")" : ""); return items; }
        tried.push(host + " no items");
      } catch (e) { tried.push(host + " " + (e.message || "failed")); }
    }
    status[k] = "failed: " + tried.join(", ");
    return [];
  });
  const out = {};
  keys.forEach((k, i) => { out[k] = res[i] || []; });
  out._status = status;
  // Cache a full answer for 10 minutes; a partial one only briefly so a hiccup doesn't stick.
  out.__ttl = keys.every(k => out[k].length) ? NEWS_TTL : 60;
  return json(out, 200);
}

/* ---------- calendar: Google Calendar secret iCal address, expanded for one day ---------- */
const CAL_HOST = "calendar.google.com";
const ymd = s => s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
async function calendar(url) {
  let src;
  try { src = new URL(url.searchParams.get("url") || ""); } catch { bad("Add your Google Calendar secret address in Settings"); }
  if (src.protocol !== "https:" || src.hostname !== CAL_HOST || !/^\/calendar\/ical\/.+\.ics$/.test(src.pathname)) bad("Only Google Calendar iCal addresses (calendar.google.com/calendar/ical/…/basic.ics) are accepted");
  const from = +url.searchParams.get("from"), to = +url.searchParams.get("to"), day = url.searchParams.get("day") || "";
  if (!(from > 0 && to > from && to - from <= 3 * 86400e3) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) bad("Pass from, to (ms) and day");
  const r = await fetch(src.toString(), { headers: { "User-Agent": UA } });
  if (r.status === 404 || r.status === 403) bad("Google Calendar didn’t accept that address. Copy the secret address again from Google Calendar settings");
  if (!r.ok) throw Object.assign(new Error("Google Calendar answered " + r.status), { status: 502 });
  const text = (await r.text()).replace(/\r?\n[ \t]/g, "");
  const out = eventsForDay(text, from, to, day);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

export function eventsForDay(text, from, to, day) {
  // Register the calendar's time zones (small blocks) so local times convert correctly.
  for (const m of text.matchAll(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g)) {
    try { const tz = new ICAL.Component(ICAL.parse("BEGIN:VCALENDAR\r\n" + m[0] + "\r\nEND:VCALENDAR")).getFirstSubcomponent("vtimezone"); ICAL.TimezoneService.register(tz); } catch {}
  }
  // Only build full events for blocks that can touch the window (big calendars stay cheap).
  const lo = day.replace(/-/g, ""), d0 = new Date(Date.parse(day + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10).replace(/-/g, ""), d1 = new Date(Date.parse(day + "T00:00:00Z") + 2 * 86400e3).toISOString().slice(0, 10).replace(/-/g, "");
  const masters = new Map(), exceptions = [];
  for (const m of text.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)) {
    const b = m[0];
    const ds = (b.match(/^DTSTART[^:\r\n]*:(\d{8})/m) || [])[1]; if (!ds) continue;
    const de = (b.match(/^DTEND[^:\r\n]*:(\d{8})/m) || [])[1] || ds;
    const rrule = b.match(/^RRULE:(.*)$/m), recId = /^RECURRENCE-ID/m.test(b);
    if (/^STATUS:CANCELLED/m.test(b) && !recId) continue;
    if (rrule) { const until = (rrule[1].match(/UNTIL=(\d{8})/) || [])[1]; if (until && until < d0) continue; if (ds > d1) continue; }
    else if (!recId && (ds > d1 || de < d0)) continue;
    let ev;
    try { ev = new ICAL.Event(new ICAL.Component(ICAL.parse("BEGIN:VCALENDAR\r\n" + b + "\r\nEND:VCALENDAR")).getFirstSubcomponent("vevent")); } catch { continue; }
    if (recId) exceptions.push(ev); else masters.set(ev.uid + "|" + masters.size, ev);
  }
  const byUid = new Map(); for (const ev of masters.values()) if (ev.isRecurring()) byUid.set(ev.uid, ev);
  const loneExceptions = [];
  for (const ex of exceptions) { const ms = byUid.get(ex.uid); if (ms) ms.relateException(ex); else loneExceptions.push(ex); }

  const out = [];
  const push = (item, s, e) => {
    if (item.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const allDay = s.isDate;
    if (allDay) { const sd = s.toString(), ed = e ? e.toString() : sd; if (!(sd <= day && (ed > day || (ed === sd && sd === day)))) return; }
    else { const a = s.toJSDate().getTime(), z = (e || s).toJSDate().getTime(); if (!(z > from && a < to)) return; }
    out.push({ title: item.summary || "(No title)", start: allDay ? null : s.toJSDate().getTime(), end: allDay || !e ? null : e.toJSDate().getTime(), allDay, location: item.location || "" });
  };
  for (const ev of [...masters.values(), ...loneExceptions]) {
    if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate); continue; }
    const dur = ev.endDate ? Math.max(0, ev.endDate.toJSDate().getTime() - ev.startDate.toJSDate().getTime()) : 0;
    const it = ev.iterator(startNear(ev, from) || undefined); let next, guard = 0;
    while ((next = it.next()) && guard++ < 20000) {
      const t = next.toJSDate().getTime();
      if (next.isDate ? next.toString() > day : t >= to) break;
      if (t + dur + 2 * 86400e3 < from) continue; // far before the day: skip the costly details
      const det = ev.getOccurrenceDetails(next);
      push(det.item, det.startDate, det.endDate);
    }
    // Occurrences moved into today from another date.
    for (const ex of Object.values(ev.exceptions || {})) push(ex, ex.startDate, ex.endDate);
  }
  const seen = new Set();
  return out.filter(e => { const k = e.title + "|" + e.start + "|" + e.allDay; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.allDay - a.allDay) || ((a.start || 0) - (b.start || 0)));
}

// Start a long-running repeating event a few periods before the window instead of at its first
// occurrence years ago. Shifts by whole periods so the pattern stays aligned; rules with COUNT
// (which must be counted from the start) or unusual frequencies keep the full walk.
function startNear(ev, from) {
  const rrules = ev.component.getAllProperties("rrule");
  if (rrules.length !== 1) return null;
  const rule = rrules[0].getFirstValue();
  if (!rule || rule.count) return null;
  const s = ev.startDate, gapDays = (from - s.toJSDate().getTime()) / 86400e3;
  if (gapDays < 60) return null;
  const interval = rule.interval || 1;
  if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    const step = (rule.freq === "DAILY" ? 1 : 7) * interval, n = Math.floor((gapDays - 21) / step);
    if (n <= 0) return null;
    const t = s.clone(); t.adjust(n * step, 0, 0, 0); return t;
  }
  if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    if (s.day > 28) return null;
    const step = (rule.freq === "MONTHLY" ? 1 : 12) * interval, n = Math.floor((gapDays / 31 - 2) / step);
    if (n <= 0) return null;
    const total = s.year * 12 + (s.month - 1) + n * step;
    return new ICAL.Time({ year: Math.floor(total / 12), month: total % 12 + 1, day: s.day, hour: s.hour, minute: s.minute, second: s.second, isDate: s.isDate }, s.zone);
  }
  return null;
}
