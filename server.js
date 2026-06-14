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

// Init if missing
if (!fs.existsSync(DB)) writeDb({ trades: [], executions: [], nextId: 1 });

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/*' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
// TradingView alert JSON body:
// { "action": "buy", "price": 67450.00, "size": 2, "ppp": 1.0 }
app.post('/webhook', (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); }
      catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
    }

    const { action, price, size = 1.0, ppp = 1.0, symbol = 'BTCUSD' } = payload;

    if (!action || price == null) {
      return res.status(400).json({ error: 'Missing required: action, price' });
    }

    const act  = action.toLowerCase().trim();
    if (!['buy','sell'].includes(act)) {
      return res.status(400).json({ error: 'action must be "buy" or "sell"' });
    }

    const now = Date.now();
    const db  = readDb();

    // Store raw execution
    db.executions.push({ id: db.nextId++, action: act, price: +price, size: +size, ppp: +ppp, symbol, ts: now });

    // Find any open trade
    const openIdx = db.trades.findIndex(t => t.status === 'open');
    const open    = openIdx >= 0 ? db.trades[openIdx] : null;

    if (!open) {
      // Open new trade
      db.trades.push({
        id:          db.nextId++,
        direction:   act === 'buy' ? 'Long' : 'Short',
        entry_price: +price,
        entry_time:  now,
        exit_price:  null,
        exit_time:   null,
        size:        +size,
        ppp:         +ppp,
        points:      null,
        pnl:         null,
        status:      'open'
      });
      console.log(`Opened ${act === 'buy' ? 'Long' : 'Short'} @ ${price}`);
    } else {
      const closingLong  = open.direction === 'Long'  && act === 'sell';
      const closingShort = open.direction === 'Short' && act === 'buy';

      if (closingLong || closingShort) {
        const pts = open.direction === 'Long'
          ? +price - open.entry_price
          : open.entry_price - +price;
        const pnlVal = pts * open.ppp * open.size;

        db.trades[openIdx] = {
          ...open,
          exit_price: +price,
          exit_time:  now,
          points:     pts,
          pnl:        pnlVal,
          status:     'closed'
        };
        console.log(`Closed ${open.direction} @ ${price} | pts: ${pts.toFixed(2)} | pnl: $${pnlVal.toFixed(2)}`);
      } else {
        // Scale-in / same direction — open another
        db.trades.push({
          id:          db.nextId++,
          direction:   act === 'buy' ? 'Long' : 'Short',
          entry_price: +price,
          entry_time:  now,
          exit_price:  null,
          exit_time:   null,
          size:        +size,
          ppp:         +ppp,
          points:      null,
          pnl:         null,
          status:      'open'
        });
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
  const db     = readDb();
  const getAll = req.query.all === '1';

  const allClosed = db.trades
    .filter(t => t.status === 'closed')
    .sort((a, b) => b.exit_time - a.exit_time);

  const closed = getAll ? allClosed : allClosed.slice(0, 8);
  const open   = db.trades.find(t => t.status === 'open') || null;

  // Stats always based on last 8 for live view consistency
  const last8  = allClosed.slice(0, 8);
  const wins   = last8.filter(t => t.pnl > 0).length;
  const losses = last8.filter(t => t.pnl < 0).length;
  const net    = last8.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnls   = last8.map(t => t.pnl).filter(v => v != null);

  const stats = {
    total:   last8.length,
    wins, losses,
    net_pnl: net,
    avg_pnl: pnls.length ? net / pnls.length : 0,
    best:    pnls.length ? Math.max(...pnls) : 0,
    worst:   pnls.length ? Math.min(...pnls) : 0
  };

  res.json({ closed, open, stats });
});

// ─── MANUAL TRADE ────────────────────────────────────────────────────────────
app.post("/api/trade", (req, res) => {
  const { direction, entry_price, exit_price, size = 1, ppp = 1 } = req.body;
  if (!direction || !entry_price || !exit_price) {
    return res.status(400).json({ error: 'direction, entry_price, exit_price required' });
  }
  const pts = direction === 'Long'
    ? +exit_price - +entry_price
    : +entry_price - +exit_price;
  const pnl = pts * +ppp * +size;
  const now = Date.now();
  const db  = readDb();
  db.trades.push({
    id: db.nextId++, direction, entry_price: +entry_price,
    entry_time: now - 60000, exit_price: +exit_price, exit_time: now,
    size: +size, ppp: +ppp, points: pts, pnl, status: 'closed'
  });
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

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BTC Trade Dashboard → http://localhost:${PORT}`);
  console.log(`Webhook endpoint    → POST /webhook`);
});

// ─── EDIT TRADE (fix size / direction) ───────────────────────────────────────
app.patch('/api/trade/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const { size, direction } = req.body;
  const db  = readDb();
  const idx = db.trades.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });

  const trade   = db.trades[idx];
  const newSize = size      ? +size      : trade.size;
  const newDir  = direction || trade.direction;

  const pts = newDir === 'Long'
    ? trade.exit_price - trade.entry_price
    : trade.entry_price - trade.exit_price;
  const pnl = pts * trade.ppp * newSize;

  // Support notes update
  const newNote = req.body.note !== undefined ? req.body.note : trade.note;

  db.trades[idx] = { ...trade, size: newSize, direction: newDir, points: pts, pnl, note: newNote };
  writeDb(db);
  res.json({ ok: true });
});

// ─── INDICATOR SNAPSHOT STORE ─────────────────────────────────────────────────
let latestIndicators = null;

// Custom raw text parser for indicators only (TradingView sends NaN which breaks JSON)
app.post('/api/indicators', express.text({type: '*/*'}), (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try {
        const cleaned = payload
          .replace(/:\s*NaN/g, ':null')
          .replace(/:\s*Infinity/g, ':null')
          .replace(/:\s*-Infinity/g, ':null');
        payload = JSON.parse(cleaned);
      } catch(e) {
        console.error('Could not parse indicator payload');
        return res.json({ ok: false, error: 'parse failed' });
      }
    }
    if (payload && (payload.type === 'indicators' || payload.ema9 || payload.close)) {
      latestIndicators = { ...payload, type: 'indicators', receivedAt: Date.now() };
      console.log(`Indicators: close=${payload.close} ema9=${payload.ema9} rsi=${payload.rsi}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Indicator error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/indicators', (req, res) => {
  res.json(latestIndicators || {});
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

  // ─── 1. TRADE SUMMARY ────────────────────────────────────────────────────
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

  sections.push(
    `━━━ TRADE SUMMARY ━━━\n` +
    `${outcome}  ${direction.toUpperCase()}  ${size} lots\n` +
    `Entry: ${entry.toFixed(2)}  →  Exit: ${exit.toFixed(2)}\n` +
    `Points: ${points >= 0 ? '+' : ''}${points.toFixed(2)}  |  P&L: ${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)}\n` +
    `Hold time: ${durStr}  |  Entry: ${entryTime.toUTCString().slice(17, 25)} UTC`
  );

  // ─── 2. SESSION ANALYSIS ─────────────────────────────────────────────────
  let sessionAnalysis = `━━━ SESSION ANALYSIS ━━━\n📍 ${session}\n${sessionRisk}`;
  if (session === 'Asian Session' && !won) {
    sessionAnalysis += '\n⚠️ LIKELY FACTOR: Asian session chop is a common cause of false breakouts on BTC. Price often reverses quickly with no follow-through.';
  }
  if (session === 'Off-Hours' && !won) {
    sessionAnalysis += '\n⚠️ LIKELY FACTOR: Low liquidity periods have manipulative wicks and poor spread — high risk environment for scalping.';
  }
  sections.push(sessionAnalysis);

  // ─── 3. PRICE ACTION ANALYSIS ────────────────────────────────────────────
  const priceMove  = Math.abs(exit - entry);
  const movePct    = (priceMove / entry * 100).toFixed(3);
  let priceAnalysis = `━━━ PRICE ACTION ━━━\n`;

  if (!won) {
    priceAnalysis += `Price moved ${priceMove.toFixed(1)} pts (${movePct}%) AGAINST your ${direction} position.\n`;
    if (direction === 'Long') {
      priceAnalysis += `You bought at ${entry.toFixed(2)} but price fell to ${exit.toFixed(2)}.\n`;
      priceAnalysis += `Possible reasons:\n`;
      priceAnalysis += `  • Entry was at local resistance / swing high\n`;
      priceAnalysis += `  • Bearish momentum was already in control\n`;
      priceAnalysis += `  • No confirmation of support before entry\n`;
      priceAnalysis += `  • Counter-trend trade against prevailing direction`;
    } else {
      priceAnalysis += `You sold at ${entry.toFixed(2)} but price rose to ${exit.toFixed(2)}.\n`;
      priceAnalysis += `Possible reasons:\n`;
      priceAnalysis += `  • Entry was at local support / swing low\n`;
      priceAnalysis += `  • Bullish momentum was already in control\n`;
      priceAnalysis += `  • No confirmation of resistance before entry\n`;
      priceAnalysis += `  • Counter-trend trade against prevailing direction`;
    }
  } else {
    priceAnalysis += `Price moved ${priceMove.toFixed(1)} pts (${movePct}%) IN FAVOUR of your ${direction} position.\n`;
    if (direction === 'Long') {
      priceAnalysis += `Bought at ${entry.toFixed(2)}, price rose to ${exit.toFixed(2)}. ✓ Good long entry.`;
    } else {
      priceAnalysis += `Sold at ${entry.toFixed(2)}, price fell to ${exit.toFixed(2)}. ✓ Good short entry.`;
    }
  }
  sections.push(priceAnalysis);

  // ─── 4. HOLD TIME ANALYSIS ───────────────────────────────────────────────
  let holdAnalysis = `━━━ HOLD TIME ANALYSIS ━━━\n`;
  if (durationSec < 10) {
    holdAnalysis += `⚡ ${durStr} hold — VERY fast close.\n`;
    holdAnalysis += won
      ? `Quick scalp that worked — good discipline taking fast profits.`
      : `Stopped out almost immediately. Entry timing may have been off by one candle. Consider waiting for confirmation.`;
  } else if (durationSec < 30) {
    holdAnalysis += `⚡ ${durStr} hold — Fast scalp.\n`;
    holdAnalysis += won ? `Clean quick trade. Good execution.` : `Fast loss. Market moved against immediately — possible false signal or entry at wrong level.`;
  } else if (durationSec < 120) {
    holdAnalysis += `⏱ ${durStr} hold — Standard scalp duration.\n`;
    holdAnalysis += won ? `Trade played out as expected within normal timeframe.` : `Market did not respect your level within ${durStr}. Consider if the setup had enough confluence.`;
  } else {
    holdAnalysis += `⏳ ${durStr} hold — Longer than typical scalp.\n`;
    holdAnalysis += won ? `Patience paid off. Good hold.` : `Extended hold on a losing trade. Consider tighter stop discipline to cut losses faster.`;
  }
  sections.push(holdAnalysis);

  // ─── 5. INDICATOR ANALYSIS ───────────────────────────────────────────────
  const hasIndicators = indicators && (Date.now() - indicators.receivedAt) < 300000;

  if (hasIndicators) {
    const { ema9, ema20, ema50, ema200, rsi, vol_ratio, atr,
            macd, macd_signal, htf_ema50, swing_h, swing_l } = indicators;
    const close = parseFloat(indicators.close) || entry;

    let indAnalysis = `━━━ INDICATOR ANALYSIS ━━━\n`;

    // EMAs
    if (ema9 && ema20 && ema50 && ema200) {
      const above9   = close > ema9;
      const above20  = close > ema20;
      const above50  = close > ema50;
      const above200 = close > ema200;
      const bullAlign = ema9 > ema20 && ema20 > ema50;
      const bearAlign = ema9 < ema20 && ema20 < ema50;

      indAnalysis += `📊 EMAs at entry:\n`;
      indAnalysis += `  EMA9: ${ema9.toFixed(1)}  EMA20: ${ema20.toFixed(1)}  EMA50: ${ema50.toFixed(1)}  EMA200: ${ema200.toFixed(1)}\n`;
      indAnalysis += `  Price ${above200 ? 'ABOVE' : 'BELOW'} EMA200 · ${above50 ? 'ABOVE' : 'BELOW'} EMA50 · ${above20 ? 'ABOVE' : 'BELOW'} EMA20\n`;

      if (bullAlign) {
        indAnalysis += `  Alignment: BULLISH (EMA9 > EMA20 > EMA50)\n`;
        if (direction === 'Short' && !won) indAnalysis += `  ⚠️ KEY FACTOR: You shorted into a bullish EMA stack — high probability this was the cause of loss.\n`;
        if (direction === 'Short' && won)  indAnalysis += `  ⚠️ You won this short despite bullish EMA alignment — counter-trend trade, luck may have played a role.\n`;
        if (direction === 'Long')          indAnalysis += `  ✓ Trading WITH bullish EMA alignment — correct direction.\n`;
      } else if (bearAlign) {
        indAnalysis += `  Alignment: BEARISH (EMA9 < EMA20 < EMA50)\n`;
        if (direction === 'Long' && !won)  indAnalysis += `  ⚠️ KEY FACTOR: You longed into a bearish EMA stack — high probability this was the cause of loss.\n`;
        if (direction === 'Long' && won)   indAnalysis += `  ⚠️ You won this long despite bearish EMA alignment — counter-trend trade, luck may have played a role.\n`;
        if (direction === 'Short')         indAnalysis += `  ✓ Trading WITH bearish EMA alignment — correct direction.\n`;
      } else {
        indAnalysis += `  Alignment: MIXED — EMAs not cleanly stacked, choppy conditions.\n`;
        if (!won) indAnalysis += `  ⚠️ Mixed EMA alignment often signals consolidation — lower probability entries.\n`;
      }

      // HTF
      if (htf_ema50) {
        const htfBull = close > htf_ema50;
        indAnalysis += `  Daily EMA50: ${htf_ema50.toFixed(1)} — Price ${htfBull ? 'ABOVE (bullish bias)' : 'BELOW (bearish bias)'}\n`;
        if (htfBull && direction === 'Short' && !won) indAnalysis += `  ⚠️ KEY FACTOR: Shorting against daily bullish bias — high risk.\n`;
        if (!htfBull && direction === 'Long' && !won) indAnalysis += `  ⚠️ KEY FACTOR: Longing against daily bearish bias — high risk.\n`;
      }
    }

    // RSI
    if (rsi) {
      indAnalysis += `\n📈 RSI: ${rsi.toFixed(1)} — `;
      if (rsi > 75)      indAnalysis += `EXTREMELY OVERBOUGHT`;
      else if (rsi > 65) indAnalysis += `Overbought`;
      else if (rsi < 25) indAnalysis += `EXTREMELY OVERSOLD`;
      else if (rsi < 35) indAnalysis += `Oversold`;
      else if (rsi > 45 && rsi < 55) indAnalysis += `Neutral zone`;
      else indAnalysis += `Neutral-${rsi > 50 ? 'bullish' : 'bearish'}`;

      if (rsi > 70 && direction === 'Long' && !won)  indAnalysis += ` — ⚠️ Buying overbought conditions, reversal risk was HIGH`;
      if (rsi < 30 && direction === 'Short' && !won) indAnalysis += ` — ⚠️ Shorting oversold conditions, bounce risk was HIGH`;
      if (rsi > 70 && direction === 'Short')         indAnalysis += ` — ✓ Shorting overbought, momentum may favour`;
      if (rsi < 30 && direction === 'Long')          indAnalysis += ` — ✓ Longing oversold, bounce potential`;
      indAnalysis += '\n';
    }

    // Volume
    if (vol_ratio) {
      indAnalysis += `\n📊 Volume: ${vol_ratio.toFixed(2)}x average — `;
      if (vol_ratio > 2.0)      indAnalysis += `VERY HIGH — strong move, high conviction`;
      else if (vol_ratio > 1.3) indAnalysis += `Above average — moderate conviction`;
      else if (vol_ratio < 0.5) indAnalysis += `VERY LOW — weak move, likely false breakout`;
      else if (vol_ratio < 0.8) indAnalysis += `Below average — low conviction`;
      else                      indAnalysis += `Average`;
      if (vol_ratio < 0.7 && !won) indAnalysis += `\n  ⚠️ KEY FACTOR: Low volume at entry suggests lack of conviction — breakouts on low volume often fail.`;
      indAnalysis += '\n';
    }

    // MACD
    if (macd !== undefined && macd_signal !== undefined) {
      const macdBull = macd > macd_signal;
      const macdDiff = (macd - macd_signal).toFixed(2);
      indAnalysis += `\n📉 MACD: ${macdBull ? 'BULLISH' : 'BEARISH'} crossover (diff: ${macdDiff})\n`;
      if (macdBull && direction === 'Short' && !won) indAnalysis += `  ⚠️ KEY FACTOR: MACD showed bullish momentum — shorting against it increased risk.\n`;
      if (!macdBull && direction === 'Long' && !won) indAnalysis += `  ⚠️ KEY FACTOR: MACD showed bearish momentum — longing against it increased risk.\n`;
      if (macdBull && direction === 'Long')          indAnalysis += `  ✓ MACD momentum aligned with long trade.\n`;
      if (!macdBull && direction === 'Short')        indAnalysis += `  ✓ MACD momentum aligned with short trade.\n`;
    }

    // ATR
    if (atr) {
      const atrPct = (atr / entry * 100).toFixed(3);
      indAnalysis += `\n📏 ATR(14): ${atr.toFixed(1)} pts (${atrPct}% of price) — `;
      if (atr > 50) indAnalysis += `HIGH volatility environment`;
      else if (atr < 20) indAnalysis += `LOW volatility — tight range conditions`;
      else indAnalysis += `Normal volatility`;
      const stopSuggestion = (atr * 1.5).toFixed(0);
      indAnalysis += `\n  Suggested stop distance: ${stopSuggestion} pts (1.5x ATR)\n`;
      if (Math.abs(points) < atr * 0.5 && !won) {
        indAnalysis += `  ⚠️ Loss was within normal ATR noise — may have been stopped by random price movement.\n`;
      }
    }

    // Swing H/L
    if (swing_h && swing_l) {
      const distH = ((swing_h - entry) / entry * 100).toFixed(3);
      const distL = ((entry - swing_l) / entry * 100).toFixed(3);
      indAnalysis += `\n🎯 Swing levels:\n`;
      indAnalysis += `  Last swing HIGH: ${swing_h.toFixed(1)} (${distH}% above entry)\n`;
      indAnalysis += `  Last swing LOW: ${swing_l.toFixed(1)} (${distL}% below entry)\n`;
      if (direction === 'Long' && parseFloat(distH) < 0.05) {
        indAnalysis += `  ⚠️ KEY FACTOR: Entry was very close to swing HIGH — resistance directly overhead, poor long location.\n`;
      }
      if (direction === 'Short' && parseFloat(distL) < 0.05) {
        indAnalysis += `  ⚠️ KEY FACTOR: Entry was very close to swing LOW — support directly below, poor short location.\n`;
      }
    }

    sections.push(indAnalysis.trimEnd());
  } else {
    sections.push(
      `━━━ INDICATOR ANALYSIS ━━━\n` +
      `⏳ Waiting for Pine Script data...\n` +
      `Make sure the "Scalp Journal Feed" alert is active on your BTCUSD chart.\n` +
      `Once received, click ↻ Refresh to see full EMA / RSI / Volume / MACD analysis.`
    );
  }

  // ─── 6. STREAK & RISK CONTEXT ────────────────────────────────────────────
  const sorted  = [...allTrades].sort((a,b) => b.exit_time - a.exit_time);
  const idx     = sorted.findIndex(t => t.id === trade.id);
  const before  = sorted.slice(idx + 1, idx + 6);
  const results = before.map(t => t.pnl > 0 ? 'W' : 'L');
  const todayTrades = allTrades.filter(t => {
    const d = new Date(t.exit_time);
    const e = new Date(trade.exit_time);
    return d.toDateString() === e.toDateString();
  });
  const todayPnl    = todayTrades.reduce((s,t) => s + (t.pnl||0), 0);
  const todayLosses = todayTrades.filter(t => t.pnl < 0).length;

  let riskAnalysis = `━━━ RISK & PSYCHOLOGY ━━━\n`;

  // Streak
  if (results.length >= 2) {
    const lossStreak = results.filter(r => r==='L').length;
    const winStreak  = results.filter(r => r==='W').length;
    if (results.slice(0,3).every(r => r==='L') && !won) {
      riskAnalysis += `⚠️ REVENGE TRADING RISK: ${lossStreak + 1} consecutive losses.\n`;
      riskAnalysis += `  This is a common point where traders overtrade or increase size to recover losses.\n`;
      riskAnalysis += `  Consider: Step back, review your bias, reduce size or stop trading.\n`;
    } else if (results.slice(0,3).every(r => r==='W') && won) {
      riskAnalysis += `🔥 ${winStreak + 1} consecutive wins — strong momentum. Stay disciplined, don't over-leverage.\n`;
    }
  }

  // Today's performance
  riskAnalysis += `\nToday's session: ${todayTrades.length} trades · P&L: ${todayPnl >= 0 ? '+$' : '-$'}${Math.abs(todayPnl).toFixed(2)} · ${todayLosses} losses\n`;
  if (todayLosses >= 3) {
    riskAnalysis += `⚠️ ${todayLosses} losses today — consider whether to continue trading or review your bias.\n`;
  }

  // Size relative to recent
  const recentSizes = before.slice(0,3).map(t => parseFloat(t.size));
  const avgSize = recentSizes.length ? recentSizes.reduce((s,v)=>s+v,0)/recentSizes.length : size;
  if (size > avgSize * 1.5) {
    riskAnalysis += `⚠️ Size (${size} lots) was larger than your recent average (${avgSize.toFixed(2)} lots) — increased risk exposure.\n`;
  }

  sections.push(riskAnalysis.trimEnd());

  // ─── 7. KEY TAKEAWAYS ────────────────────────────────────────────────────
  let takeaways = `━━━ KEY TAKEAWAYS ━━━\n`;
  const warnings = [];

  if (session === 'Asian Session') warnings.push('Avoid scalping BTC in Asian session — choppy, low follow-through');
  if (session === 'Off-Hours')     warnings.push('Off-hours trading has poor liquidity and wider spreads');
  if (durationSec < 10 && !won)   warnings.push('Entry timing was off — price moved against immediately');
  if (durationSec > 120 && !won)  warnings.push('Held losing trade too long — tighter stop needed');
  if (hasIndicators && indicators.vol_ratio < 0.7 && !won) warnings.push('Low volume entry — breakouts need volume to follow through');

  if (warnings.length > 0) {
    warnings.forEach((w,i) => { takeaways += `${i+1}. ${w}\n`; });
  } else if (won) {
    takeaways += `✓ Good trade execution. Review what you did right and repeat it.\n`;
  } else {
    takeaways += `Review your entry criteria — did all your conditions align before taking this trade?\n`;
  }

  sections.push(takeaways.trimEnd());

  return sections.join('\n\n');
}

// Attach auto-analysis to trade endpoint — always regenerates fresh
app.get('/api/analyse/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  const trade = db.trades.find(t => t.id === id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const analysis = generateAutoAnalysis(trade, db.trades, latestIndicators);

  // Always save latest analysis
  const idx = db.trades.findIndex(t => t.id === id);
  db.trades[idx].auto_analysis = analysis;
  writeDb(db);

  res.json({ ok: true, analysis });
});
