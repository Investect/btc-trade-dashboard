const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB   = process.env.DB_PATH || path.join(__dirname, 'trades.json');

// ─── DATABASE ────────────────────────────────────────────────────────────────
function readDb() {
  try { if (fs.existsSync(DB)) return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
  return { trades: [], executions: [], nextId: 1 };
}
function writeDb(data) { fs.writeFileSync(DB, JSON.stringify(data, null, 2)); }
if (!fs.existsSync(DB)) writeDb({ trades: [], executions: [], nextId: 1 });

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/*' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    const { action, price, size = 1.0, ppp = 1.0, symbol = 'BTCUSD' } = payload;
    if (!action || price == null) return res.status(400).json({ error: 'Missing action, price' });
    const act = action.toLowerCase().trim();
    if (!['buy','sell'].includes(act)) return res.status(400).json({ error: 'action must be buy or sell' });
    const now = Date.now();
    const db  = readDb();
    db.executions.push({ id: db.nextId++, action: act, price: +price, size: +size, ppp: +ppp, symbol, ts: now });
    const openIdx = db.trades.findIndex(t => t.status === 'open');
    const open    = openIdx >= 0 ? db.trades[openIdx] : null;
    if (!open) {
      db.trades.push({ id: db.nextId++, direction: act==='buy'?'Long':'Short', entry_price: +price, entry_time: now, exit_price: null, exit_time: null, size: +size, ppp: +ppp, points: null, pnl: null, status: 'open' });
    } else {
      if ((open.direction==='Long'&&act==='sell')||(open.direction==='Short'&&act==='buy')) {
        const pts = open.direction==='Long' ? +price-open.entry_price : open.entry_price-+price;
        db.trades[openIdx] = { ...open, exit_price: +price, exit_time: now, points: pts, pnl: pts*open.ppp*open.size, status: 'closed' };
      } else {
        db.trades.push({ id: db.nextId++, direction: act==='buy'?'Long':'Short', entry_price: +price, entry_time: now, exit_price: null, exit_time: null, size: +size, ppp: +ppp, points: null, pnl: null, status: 'open' });
      }
    }
    writeDb(db);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET TRADES ──────────────────────────────────────────────────────────────
app.get('/api/trades', (req, res) => {
  const db = readDb();
  const allClosed = db.trades.filter(t => t.status==='closed').sort((a,b) => b.exit_time-a.exit_time);
  const closed = req.query.all==='1' ? allClosed : allClosed.slice(0,8);
  const open   = db.trades.find(t => t.status==='open') || null;
  const last8  = allClosed.slice(0,8);
  const wins   = last8.filter(t=>t.pnl>0).length, losses = last8.filter(t=>t.pnl<0).length;
  const net    = last8.reduce((s,t)=>s+(t.pnl||0),0), pnls = last8.map(t=>t.pnl).filter(v=>v!=null);
  res.json({ closed, open, stats: { total: last8.length, wins, losses, net_pnl: net, avg_pnl: pnls.length?net/pnls.length:0, best: pnls.length?Math.max(...pnls):0, worst: pnls.length?Math.min(...pnls):0 } });
});

// ─── MANUAL TRADE ────────────────────────────────────────────────────────────
app.post('/api/trade', (req, res) => {
  const { direction, entry_price, exit_price, entry_time, exit_time, size=1, ppp=1 } = req.body;
  if (!direction||!entry_price||!exit_price) return res.status(400).json({ error: 'direction, entry_price, exit_price required' });
  const pts = direction==='Long' ? +exit_price-+entry_price : +entry_price-+exit_price;
  const now = Date.now(), db = readDb();
  db.trades.push({ id: db.nextId++, direction, entry_price: +entry_price, entry_time: entry_time||now-60000, exit_price: +exit_price, exit_time: exit_time||now, size: +size, ppp: +ppp, points: pts, pnl: pts*+ppp*+size, status: 'closed' });
  writeDb(db); res.json({ ok: true });
});

// ─── EDIT TRADE ──────────────────────────────────────────────────────────────
app.patch('/api/trade/:id', (req, res) => {
  const id = parseInt(req.params.id), db = readDb();
  const idx = db.trades.findIndex(t => t.id===id);
  if (idx===-1) return res.status(404).json({ error: 'Trade not found' });
  const trade = db.trades[idx];
  const newSize = req.body.size ? +req.body.size : trade.size;
  const newDir  = req.body.direction || trade.direction;
  const pts     = newDir==='Long' ? trade.exit_price-trade.entry_price : trade.entry_price-trade.exit_price;
  const newNote = req.body.note !== undefined ? req.body.note : trade.note;
  db.trades[idx] = { ...trade, size: newSize, direction: newDir, points: pts, pnl: pts*trade.ppp*newSize, note: newNote };
  writeDb(db); res.json({ ok: true });
});

// ─── CLEAR ───────────────────────────────────────────────────────────────────
app.delete('/api/trades', (req, res) => { writeDb({ trades: [], executions: [], nextId: 1 }); res.json({ ok: true }); });

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── INDICATORS ──────────────────────────────────────────────────────────────
let latestIndicators = null;
app.post('/api/indicators', express.text({ type: '*/*' }), (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload.replace(/:\s*NaN/g,':null').replace(/:\s*Infinity/g,':null').replace(/:\s*-Infinity/g,':null')); } catch { return res.json({ ok: false }); }
    }
    if (payload && (payload.type==='indicators'||payload.ema9||payload.close)) {
      latestIndicators = { ...payload, type: 'indicators', receivedAt: Date.now() };
    }
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get('/api/indicators', (req, res) => res.json(latestIndicators || {}));

// ─── FREE INTEL FEED ─────────────────────────────────────────────────────────
// Caches results for 30s to avoid hammering free APIs
let intelCache = null;
let intelCacheTime = 0;
const INTEL_CACHE_MS = 60000; // 60 seconds — RSS feeds don't update faster than this

// Keyword scoring rules — Claude-style analyst logic in pure JS
function scoreHeadline(title, source) {
  const t = (title || '').toLowerCase();
  let score = 1;
  const bullets = [];
  let category = 'news';

  // ── SCORE 5 triggers ──
  if (/flash.?crash|circuit.?breaker|exchange.?halt|hack|exploit|emergency|black.?swan/.test(t)) {
    score = 5; bullets.push('Extreme event — immediate price impact likely'); bullets.push('Expect high volatility and possible cascade'); category = 'news';
  }
  // ── SCORE 4 triggers ──
  else if (/liquidat/.test(t)) {
    score = 4; category = 'flow';
    const m = t.match(/\$?([\d,.]+)\s*(million|billion|m|b)?/);
    const amt = m ? m[0] : 'large';
    bullets.push(`${amt} liquidation — forced selling/buying cascade likely`);
    bullets.push('Watch for sharp wick in direction of liquidation');
    bullets.push('Momentum may accelerate then sharply reverse');
  }
  else if (/whale|large.?transfer|moved.*btc|btc.*moved/.test(t)) {
    score = 4; category = 'onchain';
    bullets.push('Large on-chain movement — potential sell/buy pressure incoming');
    bullets.push('Exchange inflow = bearish signal, outflow = bullish accumulation');
    bullets.push('Monitor order book depth for absorption or follow-through');
  }
  else if (/fed|federal.?reserve|interest.?rate|fomc|powell|inflation|cpi/.test(t)) {
    score = 4; category = 'macro';
    bullets.push('Macro event — BTC correlates strongly with risk sentiment');
    bullets.push('Hawkish tone = risk-off, bearish for BTC short-term');
    bullets.push('Dovish / rate cut language = risk-on, bullish catalyst');
  }
  else if (/etf|blackrock|fidelity|institutional|spot.?bitcoin/.test(t)) {
    score = 4; category = 'flow';
    bullets.push('Institutional flow signal — large capital movement potential');
    bullets.push('ETF inflow = sustained buy pressure, outflow = distribution');
    bullets.push('Watch for momentum continuation rather than fading moves');
  }
  // ── SCORE 3 triggers ──
  else if (/funding.?rate|open.?interest|long.?short|short.?squeeze/.test(t)) {
    score = 3; category = 'technical';
    bullets.push('Derivatives market signal — funding/OI shift affects spot price');
    bullets.push('Extreme funding rates often precede sharp reversals');
    bullets.push('Monitor for squeeze conditions building');
  }
  else if (/sec|regulat|ban|government|congress|law|legal/.test(t)) {
    score = 3; category = 'macro';
    bullets.push('Regulatory headline — uncertainty typically negative short-term');
    bullets.push('Watch for knee-jerk reaction then potential reversal');
    bullets.push('Major bans historically cause sharp drops then recovery');
  }
  else if (/options|expir|futures|derivatives|cme/.test(t)) {
    score = 3; category = 'flow';
    bullets.push('Derivatives event — price may be pinned near max pain level');
    bullets.push('Post-expiry moves can be sharp as hedges are unwound');
    bullets.push('Watch for vol expansion after expiry settles');
  }
  else if (/sentiment|fear|greed|bullish|bearish|dump|pump|surge|crash|soar|plunge/.test(t)) {
    score = 3; category = 'sentiment';
    bullets.push('Sentiment-driven headline — retail momentum signal');
    bullets.push('Extreme sentiment often contrarian — crowds are wrong at peaks');
    bullets.push('Watch for confirmation on volume before following momentum');
  }
  // ── SCORE 2 triggers ──
  else if (/adoption|partnership|upgrade|network|protocol|halving|mining/.test(t)) {
    score = 2; category = 'onchain';
    bullets.push('On-chain development — medium-term positive but limited scalp impact');
    bullets.push('May attract buy interest but unlikely to move price immediately');
  }
  else if (/analyst|predict|target|price.?model|forecast/.test(t)) {
    score = 2; category = 'sentiment';
    bullets.push('Opinion/analysis piece — directional bias signal only');
    bullets.push('Analyst targets rarely cause immediate price movement');
  }
  // ── DEFAULT ──
  else {
    score = 1; category = 'news';
    bullets.push('Background noise — monitor but unlikely to affect scalp');
  }

  // Source credibility boost
  if (/whale.?alert|cryptoquant|glassnode/.test((source||'').toLowerCase())) score = Math.min(5, score + 1);

  // Time decay — older news less impactful (will be set from pubDate)
  return { score, bullets, category };
}

function timeSince(dateStr) {
  if (!dateStr) return null;
  const diff = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diff < 1)  return 'just now';
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff/60)}h ${diff%60}m ago`;
}

function decayScore(score, dateStr) {
  if (!dateStr) return score;
  const mins = (Date.now() - new Date(dateStr).getTime()) / 60000;
  if (mins > 60)  return Math.max(1, score - 2);
  if (mins > 30)  return Math.max(1, score - 1);
  return score;
}

async function fetchRSS(url, sourceName) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'BTCScalpJournal/1.0' }, signal: AbortSignal.timeout(5000) });
    const xml = await r.text();
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const m of itemMatches) {
      const block = m[1];
      const title   = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim() || '';
      if (title) items.push({ title, pubDate, source: sourceName });
      if (items.length >= 8) break;
    }
    return items;
  } catch (e) {
    console.log(`RSS fetch failed for ${sourceName}:`, e.message);
    return [];
  }
}

async function fetchCryptoPanic() {
  try {
    const r = await fetch('https://cryptopanic.com/api/v1/posts/?auth_token=free&currencies=BTC&public=true&kind=news', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.results || []).slice(0, 8).map(item => ({
      title:   item.title,
      pubDate: item.published_at,
      source:  item.source?.title || 'CryptoPanic'
    }));
  } catch (e) {
    console.log('CryptoPanic fetch failed:', e.message);
    return [];
  }
}

async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const val   = parseInt(d.data?.[0]?.value || 50);
    const label = d.data?.[0]?.value_classification || 'Neutral';
    let score = 2, bullets = [];
    if      (val <= 15) { score = 5; bullets = ['Extreme Fear — panic selling, contrarian buy signal brewing', 'Capitulation events often mark local bottoms', 'Watch for exhaustion candles and volume spike reversal']; }
    else if (val <= 30) { score = 4; bullets = ['Fear zone — elevated sell pressure, risk-off sentiment', 'BTC often bounces from fear zones but can still fall further', 'Wait for volume confirmation before longing']; }
    else if (val >= 85) { score = 5; bullets = ['Extreme Greed — euphoric market, high reversal risk', 'Historically precedes sharp corrections', 'Avoid chasing longs — look for short setups on momentum fade']; }
    else if (val >= 70) { score = 4; bullets = ['Greed zone — crowd is overextended', 'Momentum may continue short-term but risk is elevated', 'Tighten stops on longs, watch for exhaustion signals']; }
    else                { score = 2; bullets = ['Neutral sentiment — no extreme crowd positioning', 'Price likely driven by technicals and order flow', 'Less risk of sentiment-driven flash moves']; }
    return { title: `Fear & Greed Index: ${val} — ${label}`, pubDate: new Date().toISOString(), source: 'Alternative.me', score, bullets, category: 'sentiment', isProcessed: true };
  } catch (e) {
    console.log('Fear/Greed fetch failed:', e.message);
    return null;
  }
}

async function fetchBinanceData() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const price     = parseFloat(d.lastPrice);
    const change    = parseFloat(d.priceChangePercent);
    const volume    = parseFloat(d.quoteVolume) / 1e9; // billions
    const high      = parseFloat(d.highPrice);
    const low       = parseFloat(d.lowPrice);
    const range     = ((high - low) / low * 100).toFixed(2);
    let score = 2, bullets = [];
    if      (Math.abs(change) > 5) { score = 4; bullets = [`${change>0?'+':''}${change.toFixed(2)}% 24h move — strong directional momentum active`, `24h range: ${range}% — high volatility environment`, `Volume: $${volume.toFixed(1)}B — ${volume>20?'elevated, expect continuation':'moderate, watch for reversal'}`]; }
    else if (Math.abs(change) > 3) { score = 3; bullets = [`${change>0?'+':''}${change.toFixed(2)}% 24h — moderate trend in play`, `Price range: $${low.toLocaleString()} – $${high.toLocaleString()}`, `Volume: $${volume.toFixed(1)}B`]; }
    else                            { score = 2; bullets = [`BTC relatively flat: ${change>0?'+':''}${change.toFixed(2)}% 24h`, `Range: $${low.toLocaleString()} – $${high.toLocaleString()} (${range}%)`, `Volume: $${volume.toFixed(1)}B — normal conditions`]; }
    return { title: `BTC $${price.toLocaleString()} · ${change>0?'+':''}${change.toFixed(2)}% · Vol $${volume.toFixed(1)}B`, pubDate: new Date().toISOString(), source: 'Binance', score, bullets, category: 'technical', isProcessed: true };
  } catch (e) {
    console.log('Binance fetch failed:', e.message);
    return null;
  }
}

async function buildIntelFeed() {
  // Fetch all sources in parallel
  const [cpItems, cointelegraph, coindesk, fng, binance] = await Promise.all([
    fetchCryptoPanic(),
    fetchRSS('https://cointelegraph.com/rss', 'CoinTelegraph'),
    fetchRSS('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'),
    fetchFearGreed(),
    fetchBinanceData(),
  ]);

  // Process raw RSS/API items through scoring engine
  const rawItems = [...cpItems, ...cointelegraph, ...coindesk];
  const scoredItems = rawItems.map(item => {
    const { score, bullets, category } = scoreHeadline(item.title, item.source);
    const finalScore = decayScore(score, item.pubDate);
    return {
      headline:  item.title.length > 80 ? item.title.slice(0,77)+'…' : item.title,
      source:    item.source,
      category,
      score:     finalScore,
      pubDate:   item.pubDate || new Date().toISOString(), // raw timestamp for live client timer
      bullets,
    };
  });

  // Add pre-processed special items
  const specials = [fng, binance].filter(Boolean).map(item => ({
    headline: item.title,
    source:   item.source,
    category: item.category,
    score:    item.score,
    pubDate:  item.pubDate || new Date().toISOString(),
    bullets:  item.bullets,
  }));

  // Merge, deduplicate, sort by score then recency, take top 8
  const all = [...specials, ...scoredItems];
  const seen = new Set();
  const deduped = all.filter(item => {
    const key = item.headline.slice(0,40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  deduped.sort((a, b) => b.score - a.score);
  return deduped.slice(0, 8);
}

app.get('/api/intel', async (req, res) => {
  try {
    const now = Date.now();
    if (intelCache && (now - intelCacheTime) < INTEL_CACHE_MS) {
      return res.json({ ok: true, items: intelCache, cached: true });
    }
    const items = await buildIntelFeed();
    intelCache     = items;
    intelCacheTime = now;
    res.json({ ok: true, items });
  } catch (err) {
    console.error('Intel error:', err.message);
    // Return cache if available even if stale
    if (intelCache) return res.json({ ok: true, items: intelCache, cached: true });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AUTO ANALYSIS ────────────────────────────────────────────────────────────
function generateAutoAnalysis(trade, allTrades, indicators) {
  const entry       = parseFloat(trade.entry_price);
  const exit        = parseFloat(trade.exit_price);
  const direction   = trade.direction;
  const entryTime   = new Date(trade.entry_time);
  const points      = parseFloat(trade.points);
  const pnl         = parseFloat(trade.pnl);
  const size        = parseFloat(trade.size);
  const won         = pnl > 0;
  const durationSec = Math.round((trade.exit_time - trade.entry_time) / 1000);
  const durStr      = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec/60)}m ${durationSec%60}s`;
  const sections    = [];
  const hour = entryTime.getUTCHours(), min = entryTime.getUTCMinutes(), t = hour + min/60;
  let session, sessionRisk;
  if      (t>=12&&t<16) { session='London/NY Overlap'; sessionRisk='HIGH VOLUME — best session for BTC scalping'; }
  else if (t>=7 &&t<12) { session='London Session';    sessionRisk='Good liquidity — strong directional moves'; }
  else if (t>=16&&t<21) { session='New York Session';  sessionRisk='Good liquidity — US news can spike volatility'; }
  else if (t>=23||t<7)  { session='Asian Session';     sessionRisk='LOW VOLATILITY — choppy, low follow-through on BTC'; }
  else                   { session='Off-Hours';         sessionRisk='LOW LIQUIDITY — wider spreads, unpredictable moves'; }
  sections.push(`━━━ TRADE SUMMARY ━━━\n${won?'✅ WIN':'❌ LOSS'}  ${direction.toUpperCase()}  ${size} lots\nEntry: ${entry.toFixed(2)}  →  Exit: ${exit.toFixed(2)}\nPoints: ${points>=0?'+':''}${points.toFixed(2)}  |  P&L: ${pnl>=0?'+$':'-$'}${Math.abs(pnl).toFixed(2)}\nHold time: ${durStr}  |  Entry: ${entryTime.toUTCString().slice(17,25)} UTC`);
  sections.push(`━━━ SESSION ━━━\n📍 ${session}\n${sessionRisk}${session==='Asian Session'&&!won?'\n⚠️ Asian session chop likely contributed to this loss.':''}${session==='Off-Hours'&&!won?'\n⚠️ Low liquidity off-hours — poor trading environment.':''}`);
  const priceMove = Math.abs(exit-entry), movePct = (priceMove/entry*100).toFixed(3);
  sections.push(`━━━ PRICE ACTION ━━━\n${!won?`Price moved ${priceMove.toFixed(1)} pts (${movePct}%) AGAINST your ${direction}.\n${direction==='Long'?'Possible reasons:\n  • Entry at local resistance\n  • Bearish momentum already in control\n  • Counter-trend trade':'Possible reasons:\n  • Entry at local support\n  • Bullish momentum already in control\n  • Counter-trend trade'}`:`Price moved ${priceMove.toFixed(1)} pts (${movePct}%) IN FAVOUR. ✓ Good ${direction} entry.`}`);
  let hold=`━━━ HOLD TIME ━━━\n`;
  if      (durationSec<10)  hold+=`⚡ ${durStr} — Very fast. ${won?'Good quick scalp.':'Stopped immediately — check entry timing.'}`;
  else if (durationSec<30)  hold+=`⚡ ${durStr} — Fast scalp. ${won?'Clean execution.':'Fast loss — possible false signal.'}`;
  else if (durationSec<120) hold+=`⏱ ${durStr} — Standard. ${won?'Played out as expected.':'Did not respect level in time.'}`;
  else                       hold+=`⏳ ${durStr} — Long hold. ${won?'Patience paid off.':'Extended losing trade — tighten stops.'}`;
  sections.push(hold);
  const hasIndicators = indicators && (Date.now()-indicators.receivedAt)<300000;
  if (hasIndicators) {
    const { ema9, ema20, ema50, ema200, rsi, vol_ratio, atr } = indicators;
    let ind=`━━━ INDICATORS ━━━\n`;
    if (ema9&&ema20&&ema50) {
      const bull=ema9>ema20&&ema20>ema50, bear=ema9<ema20&&ema20<ema50;
      ind+=`EMAs: ${ema9.toFixed(1)} / ${ema20.toFixed(1)} / ${ema50.toFixed(1)} / ${(ema200||0).toFixed(1)}\n`;
      if      (bull&&direction==='Short'&&!won) ind+=`⚠️ KEY: Shorted bullish EMA stack — high risk.\n`;
      else if (bear&&direction==='Long' &&!won) ind+=`⚠️ KEY: Longed bearish EMA stack — high risk.\n`;
      else if (bull&&direction==='Long')        ind+=`✓ Trading WITH bullish alignment.\n`;
      else if (bear&&direction==='Short')       ind+=`✓ Trading WITH bearish alignment.\n`;
      else                                       ind+=`Mixed EMA alignment — choppy conditions.\n`;
    }
    if (rsi) ind+=`RSI: ${rsi.toFixed(1)}${rsi>70&&direction==='Long'&&!won?' ⚠️ Bought overbought':rsi<30&&direction==='Short'&&!won?' ⚠️ Shorted oversold':''}\n`;
    if (vol_ratio) ind+=`Volume: ${vol_ratio.toFixed(2)}x avg${vol_ratio<0.7&&!won?' ⚠️ Low volume — weak breakout':''}\n`;
    if (atr) ind+=`ATR: ${atr.toFixed(1)} pts — suggested stop: ${(atr*1.5).toFixed(0)} pts`;
    sections.push(ind.trimEnd());
  } else {
    sections.push(`━━━ INDICATORS ━━━\n⏳ Waiting for Pine Script data…`);
  }
  const sorted=([...allTrades]).sort((a,b)=>b.exit_time-a.exit_time);
  const before=sorted.slice(sorted.findIndex(t=>t.id===trade.id)+1,sorted.findIndex(t=>t.id===trade.id)+6);
  const todayTrades=allTrades.filter(t=>{const d=new Date(t.exit_time),e=new Date(trade.exit_time);return d.toDateString()===e.toDateString();});
  const todayPnl=todayTrades.reduce((s,t)=>s+(t.pnl||0),0), todayLosses=todayTrades.filter(t=>t.pnl<0).length;
  let risk=`━━━ RISK & PSYCHOLOGY ━━━\n`;
  const results=before.map(t=>t.pnl>0?'W':'L');
  if (results.slice(0,3).every(r=>r==='L')&&!won) risk+=`⚠️ REVENGE RISK: ${results.filter(r=>r==='L').length+1} consecutive losses. Step back.\n`;
  else if (results.slice(0,3).every(r=>r==='W')&&won) risk+=`🔥 ${results.filter(r=>r==='W').length+1} wins in a row — stay disciplined.\n`;
  risk+=`\nToday: ${todayTrades.length} trades · ${todayPnl>=0?'+$':'-$'}${Math.abs(todayPnl).toFixed(2)} · ${todayLosses} losses`;
  if (todayLosses>=3) risk+=`\n⚠️ ${todayLosses} losses today — review your bias before continuing.`;
  sections.push(risk.trimEnd());
  const warnings=[];
  if (session==='Asian Session') warnings.push('Avoid scalping BTC in Asian session');
  if (durationSec<10&&!won)     warnings.push('Entry timing off — price moved against immediately');
  if (durationSec>120&&!won)    warnings.push('Held losing trade too long — tighter stop needed');
  sections.push(`━━━ KEY TAKEAWAYS ━━━\n${warnings.length?warnings.map((w,i)=>`${i+1}. ${w}`).join('\n'):won?'✓ Good execution. Identify what worked and repeat it.':'Review entry criteria — did all conditions align?'}`);
  return sections.join('\n\n');
}

app.get('/api/analyse/:id', (req, res) => {
  const id=parseInt(req.params.id), db=readDb();
  const trade=db.trades.find(t=>t.id===id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const analysis=generateAutoAnalysis(trade, db.trades, latestIndicators);
  const idx=db.trades.findIndex(t=>t.id===id);
  db.trades[idx].auto_analysis=analysis;
  writeDb(db);
  res.json({ ok: true, analysis });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`BTC Trade Dashboard → http://localhost:${PORT}`));
