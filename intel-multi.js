// intel-multi.js — multi-asset intel for the scalp journal
//
// The existing /api/intel in server.js is crypto-only: CoinTelegraph, CoinDesk,
// Decrypt, Binance, Fear & Greed. It works, so it is not replaced.
//
// This module mounts AHEAD of it and takes over only when the request names a
// non-crypto instrument:
//
//     /api/intel                 -> falls through, unchanged BTC behaviour
//     /api/intel?symbol=BTCUSD   -> falls through, unchanged BTC behaviour
//     /api/intel?symbol=AAPL     -> handled here
//     /api/intel?symbol=XAUUSD   -> handled here
//
// Same shadowing trick as exit-fix.js: Express runs the first matching route,
// and calling next() hands control back to the original. Nothing already
// working gets touched.
//
// Mount from server.js, immediately after the exit-fix line:
//     require('./exit-fix')(app);
//     require('./intel-multi')(app);    // <- new
//     require('./analyst')(app);
//
// No API keys. Every source below is free and unauthenticated.

// ─── SYMBOL HANDLING ─────────────────────────────────────────────────────────
// Kept deliberately identical to exit-fix.js and injected.js so a ticker means
// the same thing everywhere in the system.

const FX_CCY = /^(AUD|CAD|CHF|CNH|CZK|DKK|EUR|GBP|HKD|HUF|JPY|MXN|NOK|NZD|PLN|SEK|SGD|TRY|USD|ZAR)$/;

function normSymbol(raw) {
  return String(raw || '').trim().toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[._\-#][A-Z0-9]{1,5}$/, '');
}

function classify(key) {
  if (/^(XAU|GOLD)/.test(key))   return 'metal_gold';
  if (/^(XAG|SILVER)/.test(key)) return 'metal_silver';
  if (/^(XPT|XPD)/.test(key))    return 'metal_other';
  if (/^(BTC|ETH|XRP|LTC|SOL|ADA|DOGE|BCH|DOT|AVAX|LINK)/.test(key)) return 'crypto';
  if (key.length === 6 && FX_CCY.test(key.slice(0, 3)) && FX_CCY.test(key.slice(3))) return 'fx';
  if (/^(US30|US500|USTEC|NAS100|SPX500|GER40|DE40|UK100|JP225|AUS200|FRA40|EU50|HK50)/.test(key)) return 'index';
  if (/^(WTI|BRENT|UKOIL|USOIL|NGAS|XTI|XBR)/.test(key)) return 'energy';
  return 'stock';
}

const CCY_NAME = {
  USD: 'dollar', EUR: 'euro', GBP: 'pound sterling', JPY: 'yen', AUD: 'Australian dollar',
  NZD: 'New Zealand dollar', CAD: 'Canadian dollar', CHF: 'Swiss franc', ZAR: 'rand',
  MXN: 'peso', SEK: 'krona', NOK: 'krone', TRY: 'lira', SGD: 'Singapore dollar',
  HKD: 'Hong Kong dollar', CNH: 'yuan'
};

const INDEX_NAME = {
  US30: 'Dow Jones', US500: 'S&P 500', SPX500: 'S&P 500', USTEC: 'Nasdaq 100',
  NAS100: 'Nasdaq 100', GER40: 'DAX', DE40: 'DAX', UK100: 'FTSE 100',
  JP225: 'Nikkei 225', AUS200: 'ASX 200', FRA40: 'CAC 40', EU50: 'Euro Stoxx 50',
  HK50: 'Hang Seng'
};

// Stooq is the price source: free, no key, and it covers shares, FX, indices
// and metals from a single CSV endpoint.
function stooqCode(key, cls) {
  if (cls === 'stock')        return `${key.toLowerCase()}.us`;
  if (cls === 'fx')           return key.toLowerCase();
  if (cls === 'metal_gold')   return 'xauusd';
  if (cls === 'metal_silver') return 'xagusd';
  if (cls === 'energy')       return /BRENT|UKOIL|XBR/.test(key) ? 'cb.f' : 'cl.f';
  if (cls === 'index') return ({
    US30: '^dji', US500: '^spx', SPX500: '^spx', USTEC: '^ndq', NAS100: '^ndq',
    GER40: '^dax', DE40: '^dax', UK100: '^ukx', JP225: '^nkx', HK50: '^hsi'
  })[key] || null;
  return null;
}

// What to ask the news feeds for. A ticker alone is a bad search term — "gold"
// finds nothing under XAUUSD, and bare "AAPL" pulls in unrelated noise.
function newsQueryFor(key, cls) {
  switch (cls) {
    case 'metal_gold':   return 'gold price XAU';
    case 'metal_silver': return 'silver price XAG';
    case 'metal_other':  return 'platinum palladium price';
    case 'energy':       return /BRENT|UKOIL|XBR/.test(key) ? 'Brent crude oil price' : 'WTI crude oil price';
    case 'index':        return `${INDEX_NAME[key] || key} index`;
    case 'fx': {
      const a = CCY_NAME[key.slice(0, 3)] || key.slice(0, 3);
      const b = CCY_NAME[key.slice(3)]    || key.slice(3);
      return `${a} ${b} exchange rate forex`;
    }
    default: return `${key} stock`;
  }
}

// ─── FEEDS ───────────────────────────────────────────────────────────────────
// Google News search is the workhorse: it accepts an arbitrary query, so a
// ticker you have never traded before still returns something without needing
// a new integration. The named feeds add depth for the asset classes where a
// dedicated newsroom is meaningfully better than a search result.

const GNEWS = q =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const MARKET_WIDE = [
  { name: 'CNBC Markets',  url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'CNBC Business', url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html' },
  { name: 'MarketWatch',   url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
];

function feedsFor(key, cls) {
  const q     = newsQueryFor(key, cls);
  const feeds = [{ name: 'Google News', url: GNEWS(q) }];

  if (cls === 'stock') {
    feeds.push({
      name: 'Yahoo Finance',
      url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(key)}&region=US&lang=en-US`
    });
    feeds.push({ name: 'Google News', url: GNEWS(`${key} earnings OR guidance OR analyst`) });
  }
  if (cls === 'fx') {
    feeds.push({ name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' });
    feeds.push({ name: 'Google News', url: GNEWS('central bank rate decision inflation') });
  }
  if (cls === 'metal_gold' || cls === 'metal_silver' || cls === 'metal_other') {
    feeds.push({ name: 'Kitco', url: 'https://www.kitco.com/rss/news.xml' });
    feeds.push({ name: 'Google News', url: GNEWS('Fed real yields dollar gold outlook') });
  }
  if (cls === 'index') {
    feeds.push(...MARKET_WIDE.slice(0, 2));
  }
  return feeds;
}

// ─── MINIMAL RSS PARSER ──────────────────────────────────────────────────────
// No dependency, because adding one to package.json means a deploy, and a
// deploy wipes the journal on Render's free plan.

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseRSS(xml, sourceName, limit) {
  const out    = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1)
    .concat(xml.split(/<entry[\s>]/i).slice(1));

  for (const raw of blocks) {
    const block = raw.split(/<\/(item|entry)>/i)[0];
    const title = tag(block, 'title');
    if (!title) continue;

    // Aggregators append " - Publisher" to the headline. Two things follow:
    // the publisher is more informative than "Google News", and leaving the
    // suffix attached breaks deduplication — the same story arriving from
    // Google News and from Yahoo would no longer look identical, so both
    // copies would survive. Strip it whatever the source.
    let source = sourceName;
    let clean  = title;
    const dash = title.lastIndexOf(' - ');
    if (dash > 20) {
      const tail = title.slice(dash + 3);
      // Conservative: a real headline can contain " - ", a publisher name is
      // short and wordless by comparison.
      if (tail.length <= 30 && tail.split(' ').length <= 5) {
        clean = title.slice(0, dash);
        if (sourceName === 'Google News') source = tail;
      }
    }

    const linkTag  = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const pubDate  = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');

    out.push({
      headline: clean,
      source,
      url:      linkTag ? linkTag[1] : tag(block, 'link'),
      pubDate:  pubDate || new Date().toISOString(),
      ts:       Date.parse(pubDate) || Date.now()
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── CACHING ─────────────────────────────────────────────────────────────────
// Free feeds rate-limit and occasionally fall over. Every fetch is cached, and
// a failed refresh serves the last good copy rather than an empty panel.

const cache = new Map();   // url -> { at, data, error }
const FEED_TTL   = 120000;
const INTEL_TTL  = 60000;
const QUOTE_TTL  = 20000;

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl && hit.data != null) return hit.data;
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data, error: null });
    return data;
  } catch (err) {
    if (hit && hit.data != null) {
      cache.set(key, { ...hit, error: err.message });
      return hit.data;                      // stale beats blank
    }
    cache.set(key, { at: Date.now(), data: null, error: err.message });
    throw err;
  }
}

async function getText(url, ms = 9000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpJournal/1.0)' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function fetchFeed(feed, limit = 12) {
  return cached(`feed:${feed.url}`, FEED_TTL, async () => {
    const xml = await getText(feed.url);
    return parseRSS(xml, feed.name, limit);
  });
}

// ─── PRICE SNAPSHOT ──────────────────────────────────────────────────────────
async function fetchQuote(key, cls) {
  const code = stooqCode(key, cls);
  if (!code) return null;
  return cached(`quote:${code}`, QUOTE_TTL, async () => {
    const csv  = await getText(`https://stooq.com/q/l/?s=${code}&f=sd2t2ohlcv&h&e=csv`, 8000);
    const line = csv.trim().split('\n')[1];
    if (!line) throw new Error('no data row');
    const [sym, date, time, o, h, l, c, v] = line.split(',');
    const open = parseFloat(o), close = parseFloat(c);
    if (!(close > 0)) throw new Error('no price');
    return {
      symbol: key, stooq: sym, date, time,
      open, high: parseFloat(h), low: parseFloat(l), close,
      volume: parseFloat(v) || null,
      change:     +(close - open).toFixed(5),
      change_pct: open ? +(100 * (close - open) / open).toFixed(2) : null,
      range_pct:  open ? +(100 * (parseFloat(h) - parseFloat(l)) / open).toFixed(2) : null
    };
  });
}

// ─── SCORING ─────────────────────────────────────────────────────────────────
// Same idea as the crypto scorer: rank by how likely a headline is to move
// price in the next few minutes, and say why. Scalping means most news is
// noise; the job is finding the exceptions.

function scoreHeadline(title, cls, key) {
  const t = String(title).toLowerCase();
  let score = 1, category = 'news', bullets = [];

  const push = (s, c, ...b) => { score = s; category = c; bullets = b; };

  if (/halt(ed)?\s+(trading|on)|circuit.?breaker|flash.?crash|limit.?down/.test(t)) {
    push(5, 'event',
      'Trading disruption — expect gaps and vicious spreads',
      'Widen stops or stand aside until the book normalises');
  }
  else if (/beats|misses|earnings|eps|revenue|guidance|outlook (raised|cut)|profit warning/.test(t)) {
    push(5, 'earnings',
      'Earnings-driven — the single biggest single-stock gap risk',
      'Direction is set at the open; the first 15 minutes are pure noise',
      'Scalping into a print is a coin flip — size down or wait it out');
  }
  else if (/upgrade[sd]?|downgrade[sd]?|price target|initiat(e|ed) coverage|overweight|underweight/.test(t)) {
    push(3, 'analyst',
      'Broker action — usually a sharp open then fade',
      'Strongest effect on smaller caps and thin books');
  }
  else if (/acquisition|acquire|merger|takeover|buyout|stake in|bid for/.test(t)) {
    push(4, 'corporate',
      'M&A — target gaps to the offer, acquirer usually sells off',
      'Post-announcement drift is small; the move is the gap');
  }
  else if (/fed|fomc|powell|rate (cut|hike|decision)|cpi|inflation|nfp|payrolls|jobs report|pce|ecb|boe|boj/.test(t)) {
    push(5, 'macro',
      'Scheduled macro — moves every asset class at once, not just this one',
      'Spreads widen hard into the release; liquidity vanishes',
      cls === 'fx' || cls === 'metal_gold'
        ? 'This is the dominant driver for your instrument — do not scalp through it'
        : 'Indices and rate-sensitive names react first, single stocks follow');
  }
  else if (/tariff|sanction|export control|antitrust|lawsuit|sec (probe|investigat)|regulat/.test(t)) {
    push(3, 'regulatory',
      'Regulatory headline — uncertainty, typically negative short-term',
      'Knee-jerk down then partial recovery is the common pattern');
  }
  else if (/dividend|buyback|split|offering|dilut/.test(t)) {
    push(2, 'corporate', 'Capital action — buybacks support, offerings dilute');
  }
  else if (/short seller|fraud|accounting|resign|steps down|ceo|cfo/.test(t)) {
    push(4, 'governance',
      'Governance shock — sentiment-driven and slow to mean-revert',
      'Trend days are common; fading these is expensive');
  }
  else if (/opec|supply cut|production|inventor(y|ies)|stockpile/.test(t) && (cls === 'energy' || cls === 'metal_gold')) {
    push(4, 'supply', 'Supply-side event — direct, immediate price impact');
  }
  else if (/record high|all.?time high|surge[sd]?|plunge[sd]?|slump|soar|tumble|rally|selloff/.test(t)) {
    push(2, 'momentum',
      'Momentum language — describes a move already underway',
      'By the time this is written the easy part is usually done');
  }
  else if (/dollar|yields|treasury|bond/.test(t) && (cls === 'metal_gold' || cls === 'fx')) {
    push(3, 'macro', 'Dollar and yields are the primary driver here — watch DXY alongside');
  }
  else {
    bullets = ['Background — monitor, unlikely to move a scalp'];
  }

  // A headline naming your exact ticker matters more than a sector piece.
  if (cls === 'stock' && new RegExp(`\\b${key}\\b`, 'i').test(title) && score < 5) {
    score += 1;
    bullets = [...bullets, `Names ${key} directly — single-stock impact, not sector drift`];
  }

  return { score: Math.min(score, 5), category, bullets };
}

function quoteHeadline(q, key, cls) {
  if (!q) return null;
  const up  = (q.change_pct ?? 0) >= 0;
  const dp  = cls === 'fx' ? 5 : 2;
  const b   = [
    `${up ? 'Up' : 'Down'} ${Math.abs(q.change_pct ?? 0).toFixed(2)}% on the session`,
    `Range ${q.low.toFixed(dp)}–${q.high.toFixed(dp)} (${q.range_pct ?? '?'}%)`
  ];
  if (q.range_pct != null) {
    b.push(q.range_pct > 2 ? 'Wide range — trend conditions, let winners run'
                           : 'Tight range — mean reversion, take profit quickly');
  }
  return {
    headline: `📊 ${key} ${q.close.toFixed(dp)} · ${up ? '+' : ''}${q.change_pct ?? '?'}%`,
    source: 'Stooq', category: 'technical', score: 2,
    pubDate: new Date().toISOString(), bullets: b
  };
}

// ─── BUILD ───────────────────────────────────────────────────────────────────
async function buildIntel(key, cls) {
  const feeds = feedsFor(key, cls);

  // Market-wide news rides along with every instrument. A Fed headline moves
  // your gold trade and your Apple trade at the same time, and the old panel
  // could not see it at all.
  const wide = MARKET_WIDE.slice(0, 2);
  const all  = [...feeds, ...wide.filter(w => !feeds.some(f => f.url === w.url))];

  const settled = await Promise.allSettled([
    ...all.map(f => fetchFeed(f)),
    fetchQuote(key, cls)
  ]);

  const quote = settled[settled.length - 1];
  const q     = quote.status === 'fulfilled' ? quote.value : null;

  const sources = [];
  let items = [];

  settled.slice(0, all.length).forEach((r, i) => {
    const feed = all[i];
    const wideOnly = i >= feeds.length;
    if (r.status === 'fulfilled') {
      sources.push({ name: feed.name, ok: true, items: r.value.length, scope: wideOnly ? 'market' : 'symbol' });
      items.push(...r.value.map(x => ({ ...x, scope: wideOnly ? 'market' : 'symbol' })));
    } else {
      sources.push({ name: feed.name, ok: false, error: String(r.reason && r.reason.message || r.reason) });
    }
  });

  // Dedupe on the first eight words — the same story syndicates everywhere.
  const seen = new Set();
  items = items.filter(x => {
    const sig = x.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 8).join(' ');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  items = items.map(x => {
    const s = scoreHeadline(x.headline, cls, key);
    // A market-wide story is real but less specific than one about your
    // instrument, so it ranks below an equally urgent symbol story.
    const score = x.scope === 'market' ? Math.max(1, s.score - 1) : s.score;
    return { ...x, ...s, score };
  });

  // Rank by urgency, then recency. Anything over three hours old is history.
  const cutoff = Date.now() - 3 * 3600 * 1000;
  items.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  items = items.filter(x => x.score >= 3 || x.ts > cutoff).slice(0, 18);

  const head = quoteHeadline(q, key, cls);
  return {
    ok: true,
    symbol: key,
    asset_class: cls,
    quote: q,
    items: head ? [head, ...items] : items,
    sources,
    generated: new Date().toISOString()
  };
}

// ─── MODULE ──────────────────────────────────────────────────────────────────
module.exports = function(app) {

  // Shadows /api/intel. Crypto and bare requests fall straight through to the
  // original handler in server.js, which is left completely alone.
  app.get('/api/intel', async (req, res, next) => {
    const key = normSymbol(req.query.symbol || '');
    if (!key) return next();
    const cls = classify(key);
    if (cls === 'crypto') return next();

    try {
      const data = await cached(`intel:${key}`, INTEL_TTL, () => buildIntel(key, cls));
      res.json(data);
    } catch (err) {
      console.error(`[Intel] ${key} failed:`, err.message);
      res.status(502).json({ ok: false, symbol: key, error: err.message, items: [] });
    }
  });

  // Which feeds are actually alive. Free sources rot without warning, so this
  // is the first thing to check when a panel looks thin.
  app.get('/api/intel/sources', async (req, res) => {
    const key = normSymbol(req.query.symbol || 'AAPL');
    const cls = classify(key);
    if (cls === 'crypto') {
      return res.json({ ok: true, symbol: key, note: 'crypto is served by the original /api/intel in server.js' });
    }
    try {
      const data = await buildIntel(key, cls);   // deliberately uncached
      res.json({
        ok: true, symbol: key, asset_class: cls,
        quote_ok: !!data.quote,
        sources: data.sources,
        healthy: data.sources.filter(s => s.ok).length,
        total:   data.sources.length,
        sample:  data.items.slice(0, 3).map(i => `[${i.score}] ${i.headline}`)
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // Price snapshot on its own, for any instrument.
  app.get('/api/quote', async (req, res) => {
    const key = normSymbol(req.query.symbol || '');
    if (!key) return res.status(400).json({ error: 'symbol required' });
    try {
      const q = await fetchQuote(key, classify(key));
      if (!q) return res.status(404).json({ error: `no price mapping for ${key}` });
      res.json({ ok: true, ...q });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // Instruments the picker offers even before you have traded them.
  app.get('/api/intel/universe', (req, res) => {
    res.json({
      ok: true,
      groups: [
        { label: 'Crypto',   symbols: ['BTCUSD', 'ETHUSD'] },
        { label: 'Metals',   symbols: ['XAUUSD', 'XAGUSD'] },
        { label: 'Forex',    symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'USDCHF'] },
        { label: 'Indices',  symbols: ['US30', 'US500', 'USTEC', 'GER40', 'UK100'] },
        { label: 'Energy',   symbols: ['USOIL', 'UKOIL'] },
        { label: 'Stocks',   symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'JPM'] }
      ]
    });
  });

  console.log('IntelMulti loaded — /api/intel?symbol=, /api/intel/sources, /api/quote, /api/intel/universe');
};
