const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB   = process.env.DB_PATH || path.join(__dirname, 'trades.json');

// ─── SIMPLE JSON FILE DATABASE ───────────────────────────────────────────────
function readDb() {
  try {
    if (fs.existsSync(DB)) return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {}
  return { trades: [], executions: [], nextId: 1 };
}

function writeDb(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

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
      try { payload = JSON.parse(payload); }
      catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
    }

    const { action, price, size = 1.0, ppp = 1.0, symbol = 'BTCUSD' } = payload;
    if (!action || price == null) return res.status(400).json({ error: 'Missing required: action, price' });

    const act = action.toLowerCase().trim();
    if (!['buy','sell'].includes(act)) return res.status(400).json({ error: 'action must be "buy" or "sell"' });

    const now = Date.now();
    const db  = readDb();

    db.executions.push({ id: db.nextId++, action: act, price: +price, size: +size, ppp: +ppp, symbol, ts: now });

    const openIdx = db.trades.findIndex(t => t.status === 'open');
    const open    = openIdx >= 0 ? db.trades[openIdx] : null;

    if (!open) {
      db.trades.push({ id: db.nextId++, direction: act === 'buy' ? 'Long' : 'Short', entry_price: +price, entry_time: now, exit_price: null, exit_time: null, size: +size, ppp: +ppp, points: null, pnl: null, status: 'open' });
      console.log(`Opened ${act === 'buy' ? 'Long' : 'Short'} @ ${price}`);
    } else {
      const closingLong  = open.direction === 'Long'  && act === 'sell';
      const closingShort = open.direction === 'Short' && act === 'buy';
      if (closingLong || closingShort) {
        const pts    = open.direction === 'Long' ? +price - open.entry_price : open.entry_price - +price;
        const pnlVal = pts * open.ppp * open.size;
        db.trades[openIdx] = { ...open, exit_price: +price, exit_time: now, points: pts, pnl: pnlVal, status: 'closed' };
        console.log(`Closed ${open.direction} @ ${price} | pts: ${pts.toFixed(2)} | pnl: $${pnlVal.toFixed(2)}`);
      } else {
        db.trades.push({ id: db.nextId++, direction: act === 'buy' ? 'Long' : 'Short', entry_price: +price, entry_time: now, exit_price: null, exit_time: null, size: +size, ppp: +ppp, points: null, pnl: null, status: 'open' });
      }
    }

    writeDb(db);
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET TRADES ──────────────────────────────────────────────────────────────
app.get('/api/trades', (req, res) => {
  const db      = readDb();
  const getAll  = req.query.all === '1';
  const allClosed = db.trades.filter(t => t.status === 'closed').sort((a, b) => b.exit_time - a.exit_time);
  const closed  = getAll ? allClosed : allClosed.slice(0, 8);
  const open    = db.trades.find(t => t.status === 'open') || null;
  const last8   = allClosed.slice(0, 8);
  const wins    = last8.filter(t => t.pnl > 0).length;
  const losses  = last8.filter(t => t.pnl < 0).length;
  const net     = last8.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnls    = last8.map(t => t.pnl).filter(v => v != null);
  const stats   = { total: last8.length, wins, losses, net_pnl: net, avg_pnl: pnls.length ? net / pnls.length : 0, best: pnls.length ? Math.max(...pnls) : 0, worst: pnls.length ? Math.min(...pnls) : 0 };
  res.json({ closed, open, stats });
});

// ─── MANUAL TRADE ────────────────────────────────────────────────────────────
app.post('/api/trade', (req, res) => {
  const { direction, entry_price, exit_price, entry_time, exit_time, size = 1, ppp = 1 } = req.body;
  if (!direction || !entry_price || !exit_price) return res.status(400).json({ error: 'direction, entry_price, exit_price required' });
  const pts = direction === 'Long' ? +exit_price - +entry_price : +entry_price - +exit_price;
  const pnl = pts * +ppp * +size;
  const now = Date.now();
  const db  = readDb();
  db.trades.push({ id: db.nextId++, direction, entry_price: +entry_price, entry_time: entry_time || now - 60000, exit_price: +exit_price, exit_time: exit_time || now, size: +size, ppp: +ppp, points: pts, pnl, status: 'closed' });
  writeDb(db);
  res.json({ ok: true });
});

// ─── EDIT TRADE ──────────────────────────────────────────────────────────────
app.patch('/api/trade/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const db  = readDb();
  const idx = db.trades.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });

  const trade   = db.trades[idx];
  const newSize = req.body.size      ? +req.body.size      : trade.size;
  const newDir  = req.body.direction || trade.direction;
  const pts     = newDir === 'Long' ? trade.exit_price - trade.entry_price : trade.entry_price - trade.exit_price;
  const pnl     = pts * trade.ppp * newSize;
  const newNote = req.body.note !== undefined ? req.body.note : trade.note;

  db.trades[idx] = { ...trade, size: newSize, direction: newDir, points: pts, pnl, note: newNote };
  writeDb(db);
  res.json({ ok: true });
});

// ─── CLEAR ───────────────────────────────────────────────────────────────────
app.delete('/api/trades', (req, res) => {
  writeDb({ trades: [], executions: [], nextId: 1 });
  res.json({ ok: true });
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── INDICATOR SNAPSHOT ──────────────────────────────────────────────────────
let latestIndicators = null;

app.post('/api/indicators', express.text({ type: '*/*' }), (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try {
        const cleaned = payload.replace(/:\s*NaN/g, ':null').replace(/:\s*Infinity/g, ':null').replace(/:\s*-Infinity/g, ':null');
        payload = JSON.parse(cleaned);
      } catch(e) {
        return res.json({ ok: false, error: 'parse failed' });
      }
    }
    if (payload && (payload.type === 'indicators' || payload.ema9 || payload.close)) {
      latestIndicators = { ...payload, type: 'indicators', receivedAt: Date.now() };
      console.log(`Indicators: close=${payload.close} ema9=${payload.ema9} rsi=${payload.rsi}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/indicators', (req, res) => res.json(latestIndicators || {}));

// ─── BTC INTEL FEED ──────────────────────────────────────────────────────────
const INTEL_PROMPT = `You are a live BTC/USD scalping intelligence analyst. The trader scalps BTCUSD on a 15-second chart using EMAs (9,20,50,200) and RSI. They ONLY need signals that could affect price in the next 1-60 minutes.

Return ONLY a raw JSON array — no markdown, no preamble, no backticks. 6-8 items, newest/most urgent first:
[{"headline":"under 12 words","source":"e.g. Whale Alert / CoinTelegraph / CME / CryptoQuant / Binance Flow / On-chain / Fed / Twitter/X","category":"macro|onchain|news|sentiment|technical|flow","score":1-5,"time":"e.g. just now / 3 min ago / 12 min ago","bullets":["scalp impact point 1","point 2","point 3"]}]

Score guide — 5=act NOW (cascade/halt/flash crash), 4=high (whale >500BTC/funding flip/exchange spike), 3=moderate (mid whale/options expiry/HTF divergence), 2=low (background sentiment/slow metric), 1=noise.
Focus: whale alerts, exchange inflows/outflows, funding rates, liquidation clusters, options data, large spot flow, macro timing, momentum signals. Be realistic. Vary signals each call.`;

app.post('/api/intel', async (req, res) => {
  try {
    const utc = (req.body && req.body.utc) || new Date().toUTCString();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: INTEL_PROMPT,
        messages: [{ role: 'user', content: `Fresh BTC scalp intel now. UTC: ${utc}. Vary from previous calls.` }]
      })
    });
    const data  = await response.json();
    const text  = (data.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const items = JSON.parse(clean);
    res.json({ ok: true, items });
  } catch (err) {
    console.error('Intel error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AUTO ANALYSIS ────────────────────────────────────────────────────────────
function generateAutoAnalysis(trade, allTrades, indicators) {
  const entry       = parseFloat(trade.entry_price);
  const exit        = parseFloat(trade.exit_price);
  const direction   = trade.direction;
  const entryTime   = new Date(trade.entry_time);
  const exitTime    = new Date(trade.exit_time);
  const points      = parseFloat(trade.points);
  const pnl         = parseFloat(trade.pnl);
  const size        = parseFloat(trade.size);
  const won         = pnl > 0;
  const durationSec = Math.round((trade.exit_time - trade.entry_time) / 1000);
  const durStr      = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec/60)}m ${durationSec%60}s`;

  const sections = [];

  const outcome = won ? '✅ WIN' : '❌ LOSS';
  const hour = entryTime.getUTCHours();
  const min  = entryTime.getUTCMinutes();
  const t    = hour + min/60;

  let session, sessionRisk;
  if      (t >= 12 && t < 16) { session = 'London/NY Overlap'; sessionRisk = 'HIGH VOLUME — best session for BTC scalping'; }
  else if (t >= 7  && t < 12) { session = 'London Session';    sessionRisk = 'Good liquidity — strong directional moves'; }
  else if (t >= 16 && t < 21) { session = 'New York Session';  sessionRisk = 'Good liquidity — US news can spike volatility'; }
  else if (t >= 23 || t < 7)  { session = 'Asian Session';     sessionRisk = 'LOW VOLATILITY — choppy, low follow-through on BTC'; }
  else                         { session = 'Off-Hours';         sessionRisk = 'LOW LIQUIDITY — wider spreads, unpredictable moves'; }

  sections.push(`━━━ TRADE SUMMARY ━━━\n${outcome}  ${direction.toUpperCase()}  ${size} lots\nEntry: ${entry.toFixed(2)}  →  Exit: ${exit.toFixed(2)}\nPoints: ${points >= 0 ? '+' : ''}${points.toFixed(2)}  |  P&L: ${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)}\nHold time: ${durStr}  |  Entry: ${entryTime.toUTCString().slice(17, 25)} UTC`);
  sections.push(`━━━ SESSION ANALYSIS ━━━\n📍 ${session}\n${sessionRisk}${session === 'Asian Session' && !won ? '\n⚠️ LIKELY FACTOR: Asian session chop is a common cause of false breakouts on BTC.' : ''}${session === 'Off-Hours' && !won ? '\n⚠️ LIKELY FACTOR: Low liquidity periods have manipulative wicks and poor spread.' : ''}`);

  const priceMove = Math.abs(exit - entry);
  const movePct   = (priceMove / entry * 100).toFixed(3);
  let priceAnalysis = `━━━ PRICE ACTION ━━━\n`;
  if (!won) {
    priceAnalysis += `Price moved ${priceMove.toFixed(1)} pts (${movePct}%) AGAINST your ${direction} position.\n`;
    priceAnalysis += direction === 'Long'
      ? `You bought at ${entry.toFixed(2)} but price fell to ${exit.toFixed(2)}.\nPossible reasons:\n  • Entry was at local resistance / swing high\n  • Bearish momentum was already in control\n  • No confirmation of support before entry\n  • Counter-trend trade against prevailing direction`
      : `You sold at ${entry.toFixed(2)} but price rose to ${exit.toFixed(2)}.\nPossible reasons:\n  • Entry was at local support / swing low\n  • Bullish momentum was already in control\n  • No confirmation of resistance before entry\n  • Counter-trend trade against prevailing direction`;
  } else {
    priceAnalysis += `Price moved ${priceMove.toFixed(1)} pts (${movePct}%) IN FAVOUR of your ${direction} position.\n`;
    priceAnalysis += direction === 'Long' ? `Bought at ${entry.toFixed(2)}, price rose to ${exit.toFixed(2)}. ✓ Good long entry.` : `Sold at ${entry.toFixed(2)}, price fell to ${exit.toFixed(2)}. ✓ Good short entry.`;
  }
  sections.push(priceAnalysis);

  let holdAnalysis = `━━━ HOLD TIME ANALYSIS ━━━\n`;
  if      (durationSec < 10)  holdAnalysis += `⚡ ${durStr} hold — VERY fast close.\n${won ? 'Quick scalp that worked — good discipline.' : 'Stopped out almost immediately. Consider waiting for confirmation.'}`;
  else if (durationSec < 30)  holdAnalysis += `⚡ ${durStr} hold — Fast scalp.\n${won ? 'Clean quick trade.' : 'Fast loss. Possible false signal or wrong level.'}`;
  else if (durationSec < 120) holdAnalysis += `⏱ ${durStr} hold — Standard scalp.\n${won ? 'Trade played out as expected.' : 'Market did not respect your level within timeframe.'}`;
  else                         holdAnalysis += `⏳ ${durStr} hold — Longer than typical scalp.\n${won ? 'Patience paid off.' : 'Extended hold on a losing trade. Consider tighter stop discipline.'}`;
  sections.push(holdAnalysis);

  const hasIndicators = indicators && (Date.now() - indicators.receivedAt) < 300000;
  if (hasIndicators) {
    const { ema9, ema20, ema50, ema200, rsi, vol_ratio, atr, macd, macd_signal, htf_ema50, swing_h, swing_l } = indicators;
    const close = parseFloat(indicators.close) || entry;
    let indAnalysis = `━━━ INDICATOR ANALYSIS ━━━\n`;
    if (ema9 && ema20 && ema50 && ema200) {
      const bullAlign = ema9 > ema20 && ema20 > ema50;
      const bearAlign = ema9 < ema20 && ema20 < ema50;
      indAnalysis += `📊 EMAs: EMA9:${ema9.toFixed(1)} EMA20:${ema20.toFixed(1)} EMA50:${ema50.toFixed(1)} EMA200:${ema200.toFixed(1)}\n`;
      if      (bullAlign && direction === 'Short' && !won) indAnalysis += `⚠️ KEY: You shorted into a bullish EMA stack.\n`;
      else if (bearAlign && direction === 'Long'  && !won) indAnalysis += `⚠️ KEY: You longed into a bearish EMA stack.\n`;
      else if (bullAlign && direction === 'Long')          indAnalysis += `✓ Trading WITH bullish EMA alignment.\n`;
      else if (bearAlign && direction === 'Short')         indAnalysis += `✓ Trading WITH bearish EMA alignment.\n`;
      else                                                  indAnalysis += `Mixed EMA alignment — choppy conditions.\n`;
    }
    if (rsi) indAnalysis += `📈 RSI: ${rsi.toFixed(1)}${rsi>70&&direction==='Long'&&!won?' — ⚠️ Buying overbought':rsi<30&&direction==='Short'&&!won?' — ⚠️ Shorting oversold':''}\n`;
    if (vol_ratio) indAnalysis += `📊 Volume: ${vol_ratio.toFixed(2)}x avg${vol_ratio<0.7&&!won?' — ⚠️ Low volume entry, likely false breakout':''}\n`;
    if (atr) indAnalysis += `📏 ATR: ${atr.toFixed(1)} pts — suggested stop: ${(atr*1.5).toFixed(0)} pts\n`;
    sections.push(indAnalysis.trimEnd());
  } else {
    sections.push(`━━━ INDICATOR ANALYSIS ━━━\n⏳ Waiting for Pine Script data…\nMake sure the "Scalp Journal Feed" alert is active on your BTCUSD chart.`);
  }

  const sorted   = [...allTrades].sort((a,b) => b.exit_time - a.exit_time);
  const idx      = sorted.findIndex(t => t.id === trade.id);
  const before   = sorted.slice(idx + 1, idx + 6);
  const todayTrades = allTrades.filter(t => { const d=new Date(t.exit_time),e=new Date(trade.exit_time); return d.toDateString()===e.toDateString(); });
  const todayPnl    = todayTrades.reduce((s,t)=>s+(t.pnl||0),0);
  const todayLosses = todayTrades.filter(t=>t.pnl<0).length;
  let riskAnalysis  = `━━━ RISK & PSYCHOLOGY ━━━\n`;
  const results     = before.map(t=>t.pnl>0?'W':'L');
  if (results.slice(0,3).every(r=>r==='L') && !won) riskAnalysis += `⚠️ REVENGE TRADING RISK: ${results.filter(r=>r==='L').length+1} consecutive losses.\n  Step back, review bias, reduce size.\n`;
  else if (results.slice(0,3).every(r=>r==='W') && won) riskAnalysis += `🔥 ${results.filter(r=>r==='W').length+1} consecutive wins — stay disciplined.\n`;
  riskAnalysis += `\nToday: ${todayTrades.length} trades · P&L: ${todayPnl>=0?'+$':'-$'}${Math.abs(todayPnl).toFixed(2)} · ${todayLosses} losses`;
  if (todayLosses >= 3) riskAnalysis += `\n⚠️ ${todayLosses} losses today — consider reviewing your bias.`;
  sections.push(riskAnalysis.trimEnd());

  const warnings = [];
  if (session === 'Asian Session') warnings.push('Avoid scalping BTC in Asian session — choppy, low follow-through');
  if (session === 'Off-Hours')     warnings.push('Off-hours trading has poor liquidity and wider spreads');
  if (durationSec < 10 && !won)   warnings.push('Entry timing was off — price moved against immediately');
  if (durationSec > 120 && !won)  warnings.push('Held losing trade too long — tighter stop needed');
  let takeaways = `━━━ KEY TAKEAWAYS ━━━\n`;
  if (warnings.length > 0) warnings.forEach((w,i)=>{ takeaways+=`${i+1}. ${w}\n`; });
  else if (won) takeaways += `✓ Good execution. Review what you did right and repeat it.\n`;
  else          takeaways += `Review entry criteria — did all conditions align before this trade?\n`;
  sections.push(takeaways.trimEnd());

  return sections.join('\n\n');
}

app.get('/api/analyse/:id', (req, res) => {
  const id    = parseInt(req.params.id);
  const db    = readDb();
  const trade = db.trades.find(t => t.id === id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const analysis = generateAutoAnalysis(trade, db.trades, latestIndicators);
  const idx = db.trades.findIndex(t => t.id === id);
  db.trades[idx].auto_analysis = analysis;
  writeDb(db);
  res.json({ ok: true, analysis });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BTC Trade Dashboard → http://localhost:${PORT}`);
});
