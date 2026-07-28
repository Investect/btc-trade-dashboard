// exit-fix.js — exit price integrity for the BTC scalp journal
//
// Two jobs:
//   1. /analyst-correct-exit  — overwrite an estimated exit with the exact
//                               broker fill when the extension later sees it.
//   2. /api/repair-exits      — rebuild the exit prices that the old
//                               `latestAMNData.price` fallback fabricated.
//
// Mount from server.js with:   require('./exit-fix')(app);
// IT MUST GO ABOVE require('./analyst')(app);

const fs      = require('fs');
const path    = require('path');
const express = require('express');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SPREAD      = 12;         // BTCUSD CFD spread in points
const BAD_EXIT    = 64158.08;   // the frozen price the old bug wrote
const MAX_OFFSET  = 600;        // reject calibration if CFD/spot gap exceeds this
const MAX_OPEN    = 10;         // concurrent open positions (analyst.js used 2)
const LONG_HOLD_MS = 30 * 60 * 1000;

const DB = () => process.env.DB_PATH || path.join(__dirname, 'trades.json');

function readDb() {
  return JSON.parse(fs.readFileSync(DB(), 'utf8'));
}
function writeDb(db) {
  fs.writeFileSync(DB(), JSON.stringify(db, null, 2));
}

function recompute(trade, exitPrice) {
  const pts = trade.direction === 'Long'
    ? exitPrice - trade.entry_price
    : trade.entry_price - exitPrice;
  return { points: pts, pnl: pts * (trade.ppp || 1) * (trade.size || 1) };
}

// ─── BINANCE 1-SECOND PRICE LOOKUP ───────────────────────────────────────────
// Scalps here last as little as 24 seconds, so minute candles are useless —
// entry and exit would land in the same bar and every fast trade would collapse
// to exactly -SPREAD points. 1s klines give real intrabar movement.

const secCache = new Map();   // second (ms, floored) -> close price

async function loadWindow(centreMs) {
  const start = centreMs - 90000;
  const end   = centreMs + 90000;
  const url   = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s`
              + `&startTime=${start}&endTime=${end}&limit=1000`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('Binance returned no array');
  for (const k of rows) {
    secCache.set(Math.floor(k[0] / 1000) * 1000, parseFloat(k[4]));
  }
  return rows.length;
}

async function priceAt(ts) {
  const sec = Math.floor(ts / 1000) * 1000;
  if (secCache.has(sec)) return secCache.get(sec);

  await loadWindow(ts);
  if (secCache.has(sec)) return secCache.get(sec);

  // No trade printed in that exact second — walk outward up to 2 minutes.
  for (let d = 1000; d <= 120000; d += 1000) {
    if (secCache.has(sec - d)) return secCache.get(sec - d);
    if (secCache.has(sec + d)) return secCache.get(sec + d);
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── RECONSTRUCTION ──────────────────────────────────────────────────────────
// Per-trade calibration. We know the entry price is real — it came straight off
// the broker fill. So the CFD-to-spot offset at entry is knowable exactly, and
// over a scalp lasting seconds that offset barely moves.
//
//   LONG  entered by BUYING  -> filled at ASK
//         closed  by SELLING -> fills  at BID  = spot + offset - SPREAD
//   SHORT entered by SELLING -> filled at BID
//         closed  by BUYING  -> fills  at ASK  = spot + offset + SPREAD
//
// The spread is applied once, on the closing side only, because the entry price
// already carries its own half. This is why you must not also widen the live
// quote in injected.js — bid/ask there is already the real two-sided price.

async function reconstruct(trade) {
  const spotAtEntry = await priceAt(trade.entry_time);
  const spotAtExit  = await priceAt(trade.exit_time);

  if (spotAtEntry == null || spotAtExit == null) {
    return { ok: false, reason: 'no Binance data for this timestamp' };
  }

  const offset = trade.entry_price - spotAtEntry;
  if (Math.abs(offset) > MAX_OFFSET) {
    return { ok: false, reason: `calibration offset ${offset.toFixed(1)} exceeds ${MAX_OFFSET}` };
  }

  const exitPrice = trade.direction === 'Long'
    ? spotAtExit + offset - SPREAD
    : spotAtExit + offset + SPREAD;

  const holdMs = trade.exit_time - trade.entry_time;

  return {
    ok: true,
    exitPrice: +exitPrice.toFixed(2),
    offset:    +offset.toFixed(2),
    spotAtEntry,
    spotAtExit,
    holdMs,
    confidence: holdMs > LONG_HOLD_MS ? 'low' : 'high'
  };
}

// ─── MODULE ──────────────────────────────────────────────────────────────────
module.exports = function(app) {

  // ── SAFE CLOSE — must be mounted BEFORE require('./analyst')(app) ────────
  // Express runs the first matching handler, so registering this route here
  // shadows the buggy one in analyst.js. That file needs no edits at all.
  //
  // The original read:
  //   const exitPrice = parseFloat(req.body.exit_price)
  //                  || parseFloat(latestAMNData?.price)   <- froze at 64158.08
  //                  || trade.entry_price;
  //
  // A close with no price is now refused outright. The trade stays open, which
  // is visible and fixable. A fabricated exit is neither.
  app.post('/analyst-close-trade', (req, res) => {
    try {
      const ctraderIdStr = String(req.body.id);
      const exitPrice    = parseFloat(req.body.exit_price);

      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        console.warn(`[ExitFix] REFUSED close for ${ctraderIdStr} — no valid exit_price. Trade left open.`);
        return res.status(400).json({
          error: 'exit_price is required — refusing to invent an exit price'
        });
      }

      const db = readDb();
      let idx = db.trades.findIndex(t => t.ctrader_id === ctraderIdStr && t.status === 'open');
      if (idx === -1) idx = db.trades.findIndex(t => String(t.id) === ctraderIdStr && t.status === 'open');
      if (idx === -1) return res.status(404).json({ error: 'Open trade not found' });

      const trade = db.trades[idx];

      // Sanity guard: a BTC scalp does not move 400 points. If it claims to,
      // something upstream is wrong — record it but flag it rather than let it
      // quietly wreck the stats.
      const { points, pnl } = recompute(trade, exitPrice);
      const suspicious = Math.abs(points) > 400;
      if (suspicious) {
        console.warn(`[ExitFix] Suspicious close ${ctraderIdStr}: ${points.toFixed(1)} pts — flagged`);
      }

      db.trades[idx] = {
        ...trade,
        status:      'closed',
        exit_price:  exitPrice,
        exit_time:   req.body.exit_time || Date.now(),
        exit_source: req.body.exit_source || 'quote',
        exit_bid:    req.body.bid ?? null,
        exit_ask:    req.body.ask ?? null,
        suspicious:  suspicious || undefined,
        points,
        pnl
      };
      writeDb(db);

      console.log(`[ExitFix] Closed ${ctraderIdStr} exit=$${exitPrice} pts=${points.toFixed(1)} src=${db.trades[idx].exit_source}`);
      res.json({ status: 'closed', trade: db.trades[idx] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── REGISTER OPEN POSITION — never discards a live trade ─────────────────
  // analyst.js caps open trades at 2 and silently flips the oldest to
  // 'cancelled' when a third opens. Scaling into three positions therefore
  // destroys the first one — no exit, no P&L, no record it ever happened.
  //
  // This shadows that route: a higher ceiling, and if the ceiling is ever hit
  // the NEW registration is refused rather than an existing trade being thrown
  // away. Losing a record you already have is always the worse outcome.
  app.post('/analyst-register-trade', (req, res) => {
    try {
      const incoming = req.body;
      if (!incoming || !incoming.id || !incoming.direction || !incoming.entry_price) {
        return res.status(400).json({ error: 'Missing required fields: id, direction, entry_price' });
      }

      const ctraderId = String(incoming.id);
      const db = readDb();

      // Idempotent — the extension re-registers on every reload.
      const existing = db.trades.find(t => t.ctrader_id === ctraderId && t.status === 'open');
      if (existing) return res.json({ status: 'already_registered', trade: existing });

      const openCount = db.trades.filter(t => t.status === 'open').length;
      if (openCount >= MAX_OPEN) {
        console.warn(`[ExitFix] ${openCount} trades already open — refusing ${ctraderId}. Nothing cancelled.`);
        return res.status(429).json({
          error: `open trade limit (${MAX_OPEN}) reached — refused the new one rather than discarding an existing trade`
        });
      }

      const trade = {
        id:          db.nextId++,
        ctrader_id:  ctraderId,
        direction:   incoming.direction,
        entry_price: parseFloat(incoming.entry_price),
        entry_time:  incoming.entry_time || Date.now(),
        exit_price:  null,
        exit_time:   null,
        size:        parseFloat(incoming.size) || 0.01,
        ppp:         parseFloat(incoming.ppp) || 1,
        points:      null,
        pnl:         null,
        status:      'open',
        source:      'extension_auto'
      };
      db.trades.push(trade);
      writeDb(db);

      console.log(`[ExitFix] Registered ${trade.direction} $${trade.entry_price} ctrader_id=${ctraderId} (${openCount + 1} open)`);
      res.json({ status: 'registered', trade });
    } catch (err) {
      console.error('[ExitFix] Register error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Overwrite an estimate with the exact broker fill ──────────────────────
  app.post('/analyst-correct-exit', (req, res) => {
    try {
      const ctraderId = String(req.body.id || '');
      const exitPrice = parseFloat(req.body.exit_price);
      if (!ctraderId || !Number.isFinite(exitPrice) || exitPrice <= 0) {
        return res.status(400).json({ error: 'id and a valid exit_price are required' });
      }

      const db  = readDb();
      const idx = db.trades.findIndex(t => t.ctrader_id === ctraderId);
      if (idx === -1) return res.status(404).json({ error: 'Trade not found' });

      const trade = db.trades[idx];

      // Already exact — nothing to do.
      if (trade.exit_source === 'execution' && trade.exit_price === exitPrice) {
        return res.json({ status: 'already_exact' });
      }

      const before = trade.exit_price;
      const { points, pnl } = recompute(trade, exitPrice);

      db.trades[idx] = {
        ...trade,
        status:              'closed',
        exit_price:          exitPrice,
        exit_time:           req.body.exit_time || trade.exit_time || Date.now(),
        exit_source:         'execution',
        exit_price_estimate: before,
        points,
        pnl
      };
      writeDb(db);

      const drift = before ? +(exitPrice - before).toFixed(2) : null;
      console.log(`[ExitFix] Exact fill applied ${ctraderId}: ${before} -> ${exitPrice} (drift ${drift})`);
      res.json({ status: 'corrected', from: before, to: exitPrice, drift, trade: db.trades[idx] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── What is actually broken ──────────────────────────────────────────────
  app.get('/api/audit-exits', (req, res) => {
    try {
      const db     = readDb();
      const closed = db.trades.filter(t => t.status === 'closed');
      const bad    = closed.filter(t => t.exit_price === BAD_EXIT);
      const counts = {};
      for (const t of closed) {
        const k = String(t.exit_price);
        counts[k] = (counts[k] || 0) + 1;
      }
      const repeated = Object.entries(counts)
        .filter(([, n]) => n > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([price, n]) => ({ price: +price, count: n }));

      res.json({
        closed_trades:   closed.length,
        corrupted:       bad.length,
        corrupted_price: BAD_EXIT,
        fake_pnl:        +bad.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
        repeated_exit_prices: repeated,
        already_repaired: closed.filter(t => t.exit_source === 'reconstructed').length,
        exact:            closed.filter(t => t.exit_source === 'execution').length
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Rebuild the fabricated exits ─────────────────────────────────────────
  // Dry run by default. Add ?apply=1 to actually write.
  app.post('/api/repair-exits', async (req, res) => {
    const apply = req.query.apply === '1';
    try {
      const db      = readDb();
      const targets = db.trades.filter(t =>
        t.status === 'closed' &&
        t.exit_price === BAD_EXIT &&
        t.exit_source !== 'execution'
      );

      if (!targets.length) return res.json({ ok: true, message: 'Nothing to repair', repaired: 0 });

      const results = [];
      let netBefore = 0, netAfter = 0, failed = 0;

      for (const trade of targets) {
        const r = await reconstruct(trade);
        netBefore += trade.pnl || 0;

        if (!r.ok) {
          failed++;
          results.push({ id: trade.id, ok: false, reason: r.reason });
          continue;
        }

        const { points, pnl } = recompute(trade, r.exitPrice);
        netAfter += pnl;

        results.push({
          id:         trade.id,
          ctrader_id: trade.ctrader_id,
          direction:  trade.direction,
          size:       trade.size,
          entry:      trade.entry_price,
          old_exit:   trade.exit_price,
          new_exit:   r.exitPrice,
          old_points: +(trade.points || 0).toFixed(2),
          new_points: +points.toFixed(2),
          old_pnl:    +(trade.pnl || 0).toFixed(2),
          new_pnl:    +pnl.toFixed(2),
          offset:     r.offset,
          hold_s:     Math.round(r.holdMs / 1000),
          confidence: r.confidence,
          ok:         true
        });

        if (apply) {
          const idx = db.trades.findIndex(t => t.id === trade.id);
          db.trades[idx] = {
            ...trade,
            exit_price:          r.exitPrice,
            exit_price_original: trade.exit_price,
            exit_source:         'reconstructed',
            exit_confidence:     r.confidence,
            calibration_offset:  r.offset,
            repaired_at:         Date.now(),
            points,
            pnl
          };
        }

        await sleep(120);   // stay well inside Binance rate limits
      }

      if (apply) {
        const backup = DB().replace(/\.json$/, `.backup-${Date.now()}.json`);
        fs.copyFileSync(DB(), backup);
        writeDb(db);
        console.log(`[ExitFix] Repaired ${results.filter(r => r.ok).length} trades. Backup: ${backup}`);
      }

      res.json({
        ok:        true,
        mode:      apply ? 'APPLIED' : 'DRY RUN — add ?apply=1 to write',
        examined:  targets.length,
        repaired:  results.filter(r => r.ok).length,
        failed,
        net_pnl_before: +netBefore.toFixed(2),
        net_pnl_after:  +netAfter.toFixed(2),
        results
      });
    } catch (err) {
      console.error('[ExitFix] Repair error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Validate the method before trusting it ───────────────────────────────
  // Runs the exact same reconstruction against trades whose real exit price we
  // already know (the ones logged correctly before the bug), and reports how
  // far off it lands. Run this FIRST. If the errors here are large, do not
  // apply the repair.
  app.get('/api/repair-exits/validate', async (req, res) => {
    try {
      const db    = readDb();
      const known = db.trades.filter(t =>
        t.status === 'closed' &&
        t.exit_price != null &&
        t.exit_price !== BAD_EXIT &&
        t.exit_source !== 'reconstructed'
      );

      if (!known.length) {
        return res.json({ ok: false, message: 'No known-good trades to validate against' });
      }

      const rows = [];
      for (const trade of known) {
        const r = await reconstruct(trade);
        if (!r.ok) { rows.push({ id: trade.id, ok: false, reason: r.reason }); continue; }
        const errPts = r.exitPrice - trade.exit_price;
        rows.push({
          id:         trade.id,
          direction:  trade.direction,
          entry:      trade.entry_price,
          actual_exit:      trade.exit_price,
          reconstructed:    r.exitPrice,
          error_points:     +errPts.toFixed(2),
          error_dollars:    +(errPts * (trade.ppp||1) * (trade.size||1)).toFixed(2),
          hold_s:           Math.round(r.holdMs / 1000),
          offset:           r.offset
        });
        await sleep(120);
      }

      const errs = rows.filter(r => r.ok !== false).map(r => Math.abs(r.error_points));
      res.json({
        ok: true,
        note: 'error_points = reconstructed minus actual. Smaller is better.',
        sample_size:   errs.length,
        mean_abs_error_points:   errs.length ? +(errs.reduce((a,b)=>a+b,0)/errs.length).toFixed(2) : null,
        worst_abs_error_points:  errs.length ? +Math.max(...errs).toFixed(2) : null,
        verdict: !errs.length ? 'no data'
               : Math.max(...errs) < 40 ? 'GOOD — safe to apply the repair'
               : Math.max(...errs) < 100 ? 'ACCEPTABLE — directionally right, treat P&L as approximate'
               : 'POOR — do not apply, the CFD/spot offset is not stable enough',
        rows
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Undo, if the reconstruction looks wrong ──────────────────────────────
  app.post('/api/repair-exits/revert', (req, res) => {
    try {
      const db = readDb();
      let n = 0;
      db.trades = db.trades.map(t => {
        if (t.exit_source !== 'reconstructed' || t.exit_price_original == null) return t;
        n++;
        const { points, pnl } = recompute(t, t.exit_price_original);
        const { exit_price_original, exit_confidence, calibration_offset, repaired_at, ...rest } = t;
        return { ...rest, exit_price: exit_price_original, exit_source: 'fabricated', points, pnl };
      });
      writeDb(db);
      res.json({ ok: true, reverted: n });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── BACKUP / RESTORE ─────────────────────────────────────────────────────
  // Render's free plan ignores the `disk:` block in render.yaml, so trades.json
  // lives on the container's ephemeral filesystem. It survives restarts but a
  // DEPLOY builds a fresh container and starts empty. Take a backup before you
  // deploy anything, ever.

  // Download the whole journal. Opening this URL in a browser saves a file.
  app.get('/api/backup', (req, res) => {
    try {
      const db    = readDb();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Disposition', `attachment; filename="trades-backup-${stamp}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(db, null, 2));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Put a backup back. Needs ?confirm=1 so it can't fire by accident.
  // Own body parser — server.js uses the 100kb express.json() default, which a
  // full journal will exceed once auto_analysis text builds up.
  app.post('/api/restore', express.json({ limit: '25mb' }), (req, res) => {
    try {
      if (req.query.confirm !== '1') {
        return res.status(400).json({ error: 'add ?confirm=1 to actually restore' });
      }
      const incoming = req.body;
      if (!incoming || !Array.isArray(incoming.trades)) {
        return res.status(400).json({ error: 'expected a backup file shaped { trades: [...] }' });
      }

      // Never overwrite without keeping what was there.
      try {
        fs.copyFileSync(DB(), DB().replace(/\.(json|db)$/, `.pre-restore-${Date.now()}.json`));
      } catch {}

      const maxId = incoming.trades.reduce((m, t) => Math.max(m, parseInt(t.id) || 0), 0);
      const db = {
        trades:     incoming.trades,
        executions: incoming.executions || [],
        nextId:     incoming.nextId || maxId + 1
      };
      writeDb(db);

      console.log(`[ExitFix] Restored ${db.trades.length} trades from backup`);
      res.json({ ok: true, restored: db.trades.length, nextId: db.nextId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Say so loudly at boot if the journal came up empty — that is the signature
  // of a deploy having wiped it.
  try {
    const n = (readDb().trades || []).length;
    if (n) console.log(`[ExitFix] Journal loaded: ${n} trades`);
    else   console.warn('[ExitFix] Journal is EMPTY at startup. If unexpected, restore via POST /api/restore?confirm=1');
  } catch {
    console.warn('[ExitFix] No trades DB found at startup');
  }

  console.log('ExitFix loaded — /api/audit-exits, /api/repair-exits, /api/backup, /api/restore');
};
