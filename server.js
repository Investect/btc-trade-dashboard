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
  const db = readDb();

  const closed = db.trades
    .filter(t => t.status === 'closed')
    .sort((a, b) => b.exit_time - a.exit_time)
    .slice(0, 8);

  const open = db.trades.find(t => t.status === 'open') || null;

  const wins   = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl < 0).length;
  const net    = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnls   = closed.map(t => t.pnl).filter(v => v != null);

  const stats = {
    total:   closed.length,
    wins,
    losses,
    net_pnl: net,
    avg_pnl: pnls.length ? net / pnls.length : 0,
    best:    pnls.length ? Math.max(...pnls) : 0,
    worst:   pnls.length ? Math.min(...pnls) : 0
  };

  res.json({ closed, open, stats });
});

// ─── MANUAL TRADE ────────────────────────────────────────────────────────────
app.post('/api/trade', (req, res) => {
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
