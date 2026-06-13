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
app.use(express.text({ type: '*/*' }));
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
// Stores latest indicator snapshot from Pine Script webhook
let latestIndicators = null;

app.post('/api/indicators', (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    if (payload.type === 'indicators') {
      latestIndicators = { ...payload, receivedAt: Date.now() };
      console.log('Indicator snapshot updated:', payload.session, 'RSI:', payload.rsi?.toFixed(1));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indicators', (req, res) => {
  res.json(latestIndicators || {});
});

// ─── AUTO ANALYSIS ────────────────────────────────────────────────────────────
function generateAutoAnalysis(trade, allTrades, indicators) {
  const entry     = parseFloat(trade.entry_price);
  const exit      = parseFloat(trade.exit_price);
  const direction = trade.direction;
  const entryTime = new Date(trade.entry_time);
  const points    = parseFloat(trade.points);
  const pnl       = parseFloat(trade.pnl);
  const won       = pnl > 0;
  const durationSec = Math.round((trade.exit_time - trade.entry_time) / 1000);

  const lines = [];

  // ── SESSION ──────────────────────────────────────────────────────────────
  const hour = entryTime.getUTCHours();
  const min  = entryTime.getUTCMinutes();
  const t    = hour + min/60;
  let session = '';
  if      (t >= 12 && t < 16) session = 'London/NY Overlap 🔥';
  else if (t >= 7  && t < 12) session = 'London Session';
  else if (t >= 12 && t < 17) session = 'New York Session';
  else if (t >= 23 || t < 8)  session = 'Asian Session';
  else                         session = 'Off-Hours';

  const durStr = durationSec < 60
    ? `${durationSec}s`
    : `${Math.floor(durationSec/60)}m ${durationSec%60}s`;

  lines.push(`📍 Session: ${session} · Hold: ${durStr}`);

  // ── EMA CONTEXT (from indicators if available) ────────────────────────────
  if (indicators && (Date.now() - indicators.receivedAt) < 120000) {
    const { ema9, ema20, ema50, ema200, rsi, vol_ratio,
            above_ema9, above_ema20, above_ema50, above_ema200,
            bull_align, bear_align, htf_bull, atr,
            dist_from_high, dist_from_low, macd, macd_signal } = indicators;

    // EMA position
    const emaPos = [];
    if (above_ema200) emaPos.push('above EMA200 ✓'); else emaPos.push('below EMA200 ✗');
    if (above_ema50)  emaPos.push('above EMA50 ✓');  else emaPos.push('below EMA50 ✗');
    if (above_ema20)  emaPos.push('above EMA20 ✓');  else emaPos.push('below EMA20 ✗');
    lines.push(`📊 EMAs: ${emaPos.join(' · ')}`);

    // EMA alignment
    if (bull_align && direction === 'Short') {
      lines.push('⚠️ EMA alignment BULLISH — shorting against the trend');
    } else if (bear_align && direction === 'Long') {
      lines.push('⚠️ EMA alignment BEARISH — longing against the trend');
    } else if (bull_align && direction === 'Long') {
      lines.push('✓ Trading WITH bullish EMA alignment');
    } else if (bear_align && direction === 'Short') {
      lines.push('✓ Trading WITH bearish EMA alignment');
    }

    // HTF trend
    if (htf_bull && direction === 'Short') {
      lines.push('⚠️ Daily EMA50 trend is BULLISH — shorting against HTF bias');
    } else if (!htf_bull && direction === 'Long') {
      lines.push('⚠️ Daily EMA50 trend is BEARISH — longing against HTF bias');
    } else {
      lines.push(`✓ Trade aligns with daily EMA50 (${htf_bull ? 'bullish' : 'bearish'}) bias`);
    }

    // RSI context
    if (rsi !== undefined) {
      let rsiNote = `📈 RSI: ${rsi.toFixed(1)}`;
      if (rsi > 70 && direction === 'Long')  rsiNote += ' — overbought, risky long entry';
      if (rsi < 30 && direction === 'Short') rsiNote += ' — oversold, risky short entry';
      if (rsi > 70 && direction === 'Short') rsiNote += ' — overbought, short with momentum';
      if (rsi < 30 && direction === 'Long')  rsiNote += ' — oversold, long with momentum';
      if (rsi >= 45 && rsi <= 55)            rsiNote += ' — neutral zone';
      lines.push(rsiNote);
    }

    // Volume
    if (vol_ratio !== undefined) {
      const volNote = vol_ratio > 1.5 ? '📊 Volume: HIGH (' + vol_ratio.toFixed(1) + 'x avg) — strong conviction'
                    : vol_ratio < 0.5 ? '📊 Volume: LOW (' + vol_ratio.toFixed(1) + 'x avg) — weak conviction'
                    : '📊 Volume: Normal (' + vol_ratio.toFixed(1) + 'x avg)';
      lines.push(volNote);
    }

    // MACD
    if (macd !== undefined && macd_signal !== undefined) {
      const macdBull = macd > macd_signal;
      if (macdBull && direction === 'Short') lines.push('⚠️ MACD bullish crossover — shorting against momentum');
      if (!macdBull && direction === 'Long') lines.push('⚠️ MACD bearish crossover — longing against momentum');
      if (macdBull && direction === 'Long')  lines.push('✓ MACD confirms bullish momentum');
      if (!macdBull && direction === 'Short') lines.push('✓ MACD confirms bearish momentum');
    }

    // Distance from swing high/low
    if (dist_from_high !== undefined && dist_from_low !== undefined) {
      if (direction === 'Long' && dist_from_high < 0.05) {
        lines.push('⚠️ Entry near recent swing HIGH — resistance overhead, poor long location');
      } else if (direction === 'Short' && dist_from_low < 0.05) {
        lines.push('⚠️ Entry near recent swing LOW — support below, poor short location');
      }
    }

    // ATR context
    if (atr !== undefined) {
      const atrPct = (atr / entry * 100).toFixed(3);
      lines.push(`📏 ATR: ${atr.toFixed(0)} pts (${atrPct}% of price)`);
    }

  } else {
    lines.push('💡 Connect Pine Script indicator feed for deeper analysis');
  }

  // ── STREAK CONTEXT ────────────────────────────────────────────────────────
  const sorted  = [...allTrades].sort((a,b) => b.exit_time - a.exit_time);
  const idx     = sorted.findIndex(t => t.id === trade.id);
  const before  = sorted.slice(idx + 1, idx + 4);
  const results = before.map(t => t.pnl > 0 ? 'W' : 'L');

  if (results.length >= 2 && results.every(r => r === 'L') && !won) {
    lines.push(`⚠️ ${results.length + 1} consecutive losses — consider pausing to review`);
  } else if (results.length >= 2 && results.every(r => r === 'W') && won) {
    lines.push(`🔥 ${results.length + 1} consecutive wins — strong session`);
  }

  // ── OUTCOME SUMMARY ───────────────────────────────────────────────────────
  if (!won) {
    const moved  = Math.abs(points);
    lines.push(`\n❌ Loss of ${points.toFixed(2)} pts — price moved ${moved.toFixed(0)} pts against position`);
    if (durationSec < 15) lines.push('⚡ Very quick stop — consider if entry timing was premature');
  } else {
    lines.push(`\n✅ Win of +${points.toFixed(2)} pts`);
  }

  return lines.join('\n');
}

// Attach auto-analysis to trade endpoint — called after trade is saved
app.get('/api/analyse/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDb();
  const trade = db.trades.find(t => t.id === id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const analysis = generateAutoAnalysis(trade, db.trades, latestIndicators);

  // Save analysis to trade
  const idx = db.trades.findIndex(t => t.id === id);
  if (!db.trades[idx].auto_analysis) {
    db.trades[idx].auto_analysis = analysis;
    writeDb(db);
  }

  res.json({ ok: true, analysis });
});
