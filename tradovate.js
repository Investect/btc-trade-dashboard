// tradovate.js — Tradovate futures account poller
//
// UNTESTED against a real Tradovate account — there were no credentials available
// to build this against. It follows Tradovate's documented public REST API exactly,
// but has not made a single real API call. Treat this as a first draft: wire in real
// credentials, watch the logs on first boot, and expect to fix something.
//
// Design choice: read-only, and reuses the EXISTING trade pipeline rather than
// building a parallel one. It never places, modifies, or cancels an order — it only
// polls positions/fills and calls the same /analyst-register-trade,
// /analyst-close-trade, /analyst-bb-price-style endpoints the BlackBull extension
// already uses (shadowed by exit-fix.js, tested, working). Tradovate positions are
// tagged with a "TV:" prefix on their ctrader_id so they can never collide with a
// real cTrader position id.
//
// Mount from server.js with:   require('./tradovate')(app);
// Order relative to exit-fix.js/analyst.js does not matter — this file defines no
// routes those files also define, it only calls into the ones exit-fix.js already
// shadows correctly.

const TRADOVATE_ENV      = (process.env.TRADOVATE_ENV || 'demo').toLowerCase(); // 'demo' | 'live'
const BASE_URL           = TRADOVATE_ENV === 'live'
  ? 'https://live.tradovateapi.com/v1'
  : 'https://demo.tradovateapi.com/v1';

const USERNAME  = process.env.TRADOVATE_USERNAME;
const PASSWORD  = process.env.TRADOVATE_PASSWORD;
const CID       = process.env.TRADOVATE_CID;       // "App ID" issued by Tradovate's API application process
const SEC       = process.env.TRADOVATE_SEC;        // "App Secret" issued alongside it
const APP_ID    = process.env.TRADOVATE_APP_NAME || 'SantoshJournal';
const APP_VER   = process.env.TRADOVATE_APP_VERSION || '1.0';
const POLL_MS   = parseInt(process.env.TRADOVATE_POLL_MS || '5000', 10);

const SELF_URL  = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// ── AUTH STATE ─────────────────────────────────────────────────────────────────
let accessToken   = null;
let tokenExpiresAt = 0;
let authFailedOnce = false;

async function authenticate() {
  if (!USERNAME || !PASSWORD || !CID || !SEC) {
    if (!authFailedOnce) {
      console.warn('[Tradovate] Not configured — set TRADOVATE_USERNAME, TRADOVATE_PASSWORD, ' +
        'TRADOVATE_CID, TRADOVATE_SEC to enable. Skipping (this is not an error if you have not set it up yet).');
      authFailedOnce = true;
    }
    return false;
  }

  try {
    const r = await fetch(`${BASE_URL}/auth/accesstokenrequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:       USERNAME,
        password:   PASSWORD,
        appId:      APP_ID,
        appVersion: APP_VER,
        cid:        CID,
        sec:        SEC,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok || !data.accessToken) {
      console.error('[Tradovate] Auth failed:', data.errorText || JSON.stringify(data));
      return false;
    }
    accessToken = data.accessToken;
    // Tradovate access tokens are short-lived (documented ~80 min). Refresh at 60 min
    // to stay well inside that window rather than racing the expiry.
    tokenExpiresAt = Date.now() + 60 * 60 * 1000;
    console.log(`[Tradovate] Authenticated (${TRADOVATE_ENV}). Token refreshes in 60 min.`);
    return true;
  } catch (err) {
    console.error('[Tradovate] Auth request failed:', err.message);
    return false;
  }
}

async function ensureAuth() {
  if (accessToken && Date.now() < tokenExpiresAt) return true;
  return authenticate();
}

async function tvGet(path) {
  const ok = await ensureAuth();
  if (!ok) return null;
  try {
    const r = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401) {
      // Token rejected — force a fresh auth next cycle rather than spinning on a dead token.
      accessToken = null;
      console.warn('[Tradovate] Token rejected (401), will re-auth next poll');
      return null;
    }
    if (!r.ok) {
      console.warn(`[Tradovate] GET ${path} -> ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.error(`[Tradovate] GET ${path} failed:`, err.message);
    return null;
  }
}

// ── CONTRACT / PRODUCT NAME LOOKUP ──────────────────────────────────────────────
// Positions/fills reference numeric contractId — resolve to a human symbol
// ("ESZ6", "NQZ6", ...) and cache it, since contracts don't change mid-session.
const contractCache = new Map();
async function contractName(contractId) {
  if (contractCache.has(contractId)) return contractCache.get(contractId);
  const c = await tvGet(`/contract/item?id=${contractId}`);
  const name = c?.name || `CONTRACT_${contractId}`;
  contractCache.set(contractId, name);
  return name;
}

// Point value per contract. Tradovate's /product/item response includes this
// (valuePerPoint / tickSize / tickValue) but the exact field names vary by
// instrument family — this table covers the common ones the user is likely to
// trade and falls back to a product lookup for anything else. VERIFY against
// Tradovate's own margin/contract spec page before trusting real P&L from an
// instrument not in this table.
const KNOWN_PPP = {
  ES: 50,    MES: 5,
  NQ: 20,    MNQ: 2,
  YM: 5,     MYM: 0.5,
  RTY: 50,   M2K: 5,
  GC: 100,   MGC: 10,
  CL: 1000,  MCL: 100,
  SI: 5000,
};
function pppForSymbol(symbol) {
  const root = String(symbol).replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, ''); // strip month/year code e.g. "ESZ6" -> "ES"
  return KNOWN_PPP[root] ?? null;
}

// ── STATE ────────────────────────────────────────────────────────────────────
// posId -> { symbol, side, avgPrice, qty, ctraderId }
const trackedPositions = new Map();
let lastPollOk = false;
let lastPollAt = 0;
let lastError  = null;

function tvId(positionId) {
  return `TV:${positionId}`;
}

async function callSantosh(path, body) {
  try {
    const r = await fetch(`${SELF_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return await r.json();
  } catch (err) {
    console.error(`[Tradovate] Failed calling ${path}:`, err.message);
    return null;
  }
}

async function poll() {
  const ok = await ensureAuth();
  if (!ok) { lastPollOk = false; return; }

  const [positions, accounts] = await Promise.all([
    tvGet('/position/list'),
    tvGet('/account/list'),
  ]);
  lastPollAt = Date.now();

  if (!Array.isArray(positions)) {
    lastPollOk = false;
    lastError = 'positions fetch failed or returned non-array';
    return;
  }
  lastPollOk = true;
  lastError = null;

  // Tradovate returns one row per contract per account even when flat (netPos: 0).
  const open = positions.filter(p => p.netPos && p.netPos !== 0);
  const currentIds = new Set(open.map(p => String(p.id)));

  for (const p of open) {
    const id = String(p.id);
    if (trackedPositions.has(id)) continue; // already registered

    const symbol = await contractName(p.contractId);
    const side   = p.netPos > 0 ? 'buy' : 'sell';
    const qty    = Math.abs(p.netPos);
    const avgPrice = p.netPrice;
    const ppp    = pppForSymbol(symbol);

    trackedPositions.set(id, { symbol, side, avgPrice, qty, ctraderId: tvId(id) });

    if (ppp == null) {
      console.warn(`[Tradovate] Opened ${symbol} but no known point value — P&L will be wrong ` +
        `until KNOWN_PPP in tradovate.js has an entry for this root symbol. Registered anyway so the position is visible.`);
    }

    await callSantosh('/analyst-register-trade', {
      id:          tvId(id),
      direction:   side === 'buy' ? 'Long' : 'Short',
      symbol,
      entry_price: avgPrice,
      size:        qty,
      ppp:         ppp ?? 1,
      entry_time:  Date.now(),
      status:      'open',
    });
    console.log(`[Tradovate] Registered ${symbol} ${side === 'buy' ? 'Long' : 'Short'} ${qty} @ ${avgPrice} (ppp ${ppp ?? 'UNKNOWN — check KNOWN_PPP'})`);
  }

  // Positions that vanished need a real exit price — pull the most recent fill
  // for that contract rather than guessing, same "never fabricate" principle
  // exit-fix.js applies to BlackBull closes.
  for (const [id, info] of [...trackedPositions]) {
    if (currentIds.has(id)) continue;

    const fills = await tvGet(`/fill/list`);
    const closingFill = Array.isArray(fills)
      ? fills
          .filter(f => String(f.positionId) === id)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
      : null;

    trackedPositions.delete(id);

    if (!closingFill) {
      console.error(`[Tradovate] Position ${id} (${info.symbol}) closed but no matching fill found — ` +
        `NOT closing in the journal, it will show as open until this is resolved manually. ` +
        `Refusing to invent an exit price.`);
      continue;
    }

    await callSantosh('/analyst-close-trade', {
      id:         tvId(id),
      exit_price: closingFill.price,
      exit_time:  new Date(closingFill.timestamp).getTime(),
      exit_source: 'tradovate_fill',
    });
    console.log(`[Tradovate] Closed ${info.symbol} ${id} @ ${closingFill.price}`);
  }
}

module.exports = function(app) {
  // Lightweight status endpoint — nothing here should ever throw, this is read-only.
  app.get('/api/tradovate/status', (req, res) => {
    res.json({
      configured:  Boolean(USERNAME && PASSWORD && CID && SEC),
      env:         TRADOVATE_ENV,
      authed:      Boolean(accessToken && Date.now() < tokenExpiresAt),
      lastPollOk,
      lastPollAt,
      lastError,
      openPositions: [...trackedPositions.entries()].map(([id, p]) => ({ id, ...p })),
    });
  });

  if (USERNAME && PASSWORD && CID && SEC) {
    setTimeout(poll, 3000);
    setInterval(poll, POLL_MS);
    console.log(`[Tradovate] Poller starting (${TRADOVATE_ENV}, every ${POLL_MS}ms) — /api/tradovate/status for diagnostics`);
  } else {
    console.log('[Tradovate] Not configured — set TRADOVATE_USERNAME/PASSWORD/CID/SEC in env to enable. ' +
      '/api/tradovate/status will report configured:false until then.');
  }
};
