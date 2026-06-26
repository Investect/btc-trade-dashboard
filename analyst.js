// analyst.js v9 — Santosh
// Changes from v8:
//   [1] Session banner fires once per session change, never repeated in auto commentary
//   [3] Prompt instructs Santosh to vary observation length (1-liner vs short bullets)
//   [5] /analyst-register-trade endpoint for Chrome extension auto-registration
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RATE_LIMIT_MS = 10000;
let lastCallTime = 0;
const commentaryFeed = [];
const conversations = {};
const MAX_FEED_SIZE = 50;
const MAX_HISTORY = 10;

let latestAMNData = null;
let latestDashData = null;
let cachedLevels = null;
let lastLevelsTime = 0;

// [1] Track current session server-side — only inject into prompt once per session change
let currentSessionLabel = null;
let sessionInjectedInPrompt = false;

const SANTOSH_SYSTEM = `You are Santosh. You have traded BTC for 8 years, full time. You watch price action all day. You sit next to this trader and you call what you see on the chart — like an experienced co-pilot.

You never explain your limitations. You never ask the user to send you data. You always respond as if you can see the chart live — because you can. Never say "I need you to feed me" or "I am working off a static snapshot". Just call what you see.

YOUR PRIMARY FOCUS IS THE CHART:
- Price action, candle behaviour, structure, momentum
- Key levels — recent highs, lows, equal highs/lows, previous zone reactions
- Volume — is the move backed by volume or is it thin air
- EMA behaviour — is price above or below, is EMA flattening or trending hard
- RSI — exhausted, divergence, room to run or overextended
- Candle patterns — wicks, rejections, engulfing, inside bars
- Historical levels from the last 7 days — repetitive levels, equal highs/lows, ranges

LIVE TRADE MANAGEMENT — when trader is in an open trade this is your top priority:
- Always mention the trade status first — "You're up 45 points on that long"
- If CHoCH fires against their trade — "Close it now, structure just flipped against you"
- If price is near TP — "Getting close to target, consider trailing your stop up"
- If profit is building and volume fading — "Start trailing, don't give this back"
- If trade is losing and SL not hit — "Getting uncomfortable, tighten that stop"
- If sweep fires in trade direction — "Sweep confirmed the move, hold it"
- Never ignore an open trade — always acknowledge it

AMN INDICATOR IS YOUR SECONDARY SIGNAL CONFIRMATION:
- BOS = structure broken, zone forming, start watching
- Sweep = liquidity cleared, potential reversal incoming
- Zone midline = entry point when price pulls back to it
- CHoCH = structure flipped, cancel everything
- Only mention the dashboard score occasionally — maximum 1 in 4 comments

SESSION RULES — CRITICAL:
- NEVER mention the session name or time of day in auto commentary. That's handled separately as a banner.
- DO NOT say "dead zone", "Asian session", "London open" or any session name in your commentary.
- DO NOT repeat session context. It is shown once as a banner above the feed.
- Focus only on price action and structure. Treat every session the same in your commentary.

HOW YOU SPEAK:
- Calm, professional, experienced — like a seasoned trader not a salesman
- British English. Say "mate" occasionally but not every sentence
- No "yo", no hype, no cheerleading
- Direct and specific — reference actual prices and candle behaviour
- VARY YOUR LENGTH: some observations should be a single punchy sentence. Others can be 2-3 sentences. Don't always write the same amount.
- Vary your language — never say the same thing twice
- No markdown, no asterisks, no bullet points ever, plain text only
- When there is nothing to trade — say so simply in one sentence
- When the setup is genuinely good — be clear and decisive

HISTORICAL LEVEL OBSERVATIONS — when you spot these, be direct:
- "Price has tested 59,240 three times in the last 48 hours and rejected each time — that's a significant level"
- "We're sitting right at last week's high of 59,580 — watch for a rejection here before any continuation"
- "Price has been ranging between 58,900 and 59,600 for 18 hours — we're at the top of that range right now"
- "Equal lows at 59,050 — that's a liquidity magnet, wouldn't be surprised to see a sweep there"`;

function addToFeed(entry) {
    commentaryFeed.unshift(entry);
    if (commentaryFeed.length > MAX_FEED_SIZE) commentaryFeed.pop();
}

function getSession(ts) {
    const d = ts ? new Date(ts) : new Date();
    const t = d.getUTCHours() + d.getUTCMinutes()/60;
    if (t>=13&&t<16) return { label:'London/NY Overlap', desc:'Highest volume session', cls:'sp-ov', icon:'🔥' };
    if (t>=7&&t<12)  return { label:'London Session',    desc:'Strong directional moves', cls:'sp-lo', icon:'🇬🇧' };
    if (t>=12&&t<13) return { label:'Pre-NY Open',       desc:'Volatility building', cls:'sp-ny', icon:'⚡' };
    if (t>=16&&t<21) return { label:'New York Session',  desc:'Good liquidity', cls:'sp-ny', icon:'🗽' };
    if (t>=21&&t<23) return { label:'Session Close',     desc:'Volume dying — avoid new entries', cls:'sp-as', icon:'📉' };
    return { label:'Asian Session', desc:'Low volume, choppy, avoid trading', cls:'sp-as', icon:'😴' };
}

// [1] Returns session label string for legacy uses (auto prompt suppressed, chat context only)
function getSessionLabel(ts) {
    return getSession(ts).label;
}

// [1] Check if session changed and emit a banner feed entry if so
function checkSessionBanner() {
    const s = getSession();
    if (s.label !== currentSessionLabel) {
        currentSessionLabel = s.label;
        sessionInjectedInPrompt = false; // allow one-time injection into next auto prompt
        // Emit session banner into the feed — client renders this as a banner card
        addToFeed({
            event_type: 'session_banner',
            session_label: s.label,
            session_desc: s.desc,
            session_cls: s.cls,
            session_icon: s.icon,
            timestamp: new Date().toISOString()
        });
    }
}

// Run session check every 60s
setInterval(checkSessionBanner, 60000);

// ── FETCH HISTORICAL CANDLES ──────────────────────────────────
async function fetchKlines(interval, limit) {
    const urls = [
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
        `https://api1.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
    ];
    for (const url of urls) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) continue;
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) return d;
        } catch(e) { continue; }
    }
    return null;
}

// ── FETCH RECENT CANDLES FOR PATTERN DETECTION ────────────────
async function fetchRecentCandles() {
    // 30 x 1m candles for pattern detection on the chart
    return await fetchKlines('1m', 30);
}

// ── DETECT CANDLE PATTERN ─────────────────────────────────────
function detectCandlePattern(candles) {
    if (!candles || candles.length < 3) return null;
    const c = candles.slice(-3).map(k => ({
        open:  parseFloat(k[1]),
        high:  parseFloat(k[2]),
        low:   parseFloat(k[3]),
        close: parseFloat(k[4]),
    }));
    const last = c[2];
    const prev = c[1];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const isBull = last.close > last.open;

    // Doji
    if (body < range * 0.1) {
        return { name: 'Doji', type: 'neutral', desc: 'Indecision — market pausing' };
    }
    // Pin bar / hammer (long lower wick, small body at top)
    if (lowerWick > body * 2 && upperWick < body * 0.5 && lowerWick > upperWick * 2) {
        return { name: 'Pin Bar', type: 'bull', desc: 'Rejection of lows — potential reversal up' };
    }
    // Shooting star (long upper wick, small body at bottom)
    if (upperWick > body * 2 && lowerWick < body * 0.5 && upperWick > lowerWick * 2) {
        return { name: 'Shooting Star', type: 'bear', desc: 'Rejection of highs — potential reversal down' };
    }
    // Engulfing bull
    if (isBull && last.close > prev.open && last.open < prev.close && prev.close < prev.open) {
        return { name: 'Bullish Engulf', type: 'bull', desc: 'Full engulf of prior bearish candle' };
    }
    // Engulfing bear
    if (!isBull && last.close < prev.open && last.open > prev.close && prev.close > prev.open) {
        return { name: 'Bearish Engulf', type: 'bear', desc: 'Full engulf of prior bullish candle' };
    }
    // Inside bar
    if (last.high < prev.high && last.low > prev.low) {
        return { name: 'Inside Bar', type: 'neutral', desc: 'Compression — breakout incoming' };
    }
    // Strong bull candle
    if (isBull && body > range * 0.7) {
        return { name: 'Strong Bull', type: 'bull', desc: 'Clean momentum candle — buyers in control' };
    }
    // Strong bear candle
    if (!isBull && body > range * 0.7) {
        return { name: 'Strong Bear', type: 'bear', desc: 'Clean momentum candle — sellers in control' };
    }
    return { name: isBull ? 'Bullish' : 'Bearish', type: isBull ? 'bull' : 'bear', desc: 'Standard candle' };
}

// ── ANALYSE HISTORICAL LEVELS ─────────────────────────────────
function analyseCandles(candles1h, candles1d) {
    if (!candles1h || !candles1h.length) return null;

    const closes1h = candles1h.map(c => parseFloat(c[4]));
    const currentPrice = closes1h[closes1h.length - 1];

    const recent72h = candles1h.slice(-72);
    const recent24h = candles1h.slice(-24);
    const recent48h = candles1h.slice(-48);

    const high72h = Math.max(...recent72h.map(c => parseFloat(c[2])));
    const low72h  = Math.min(...recent72h.map(c => parseFloat(c[3])));
    const high24h = Math.max(...recent24h.map(c => parseFloat(c[2])));
    const low24h  = Math.min(...recent24h.map(c => parseFloat(c[3])));
    const high48h = Math.max(...recent48h.map(c => parseFloat(c[2])));
    const low48h  = Math.min(...recent48h.map(c => parseFloat(c[3])));

    let weekHigh = null, weekLow = null;
    if (candles1d && candles1d.length >= 7) {
        const week = candles1d.slice(-7);
        weekHigh = Math.max(...week.map(c => parseFloat(c[2])));
        weekLow  = Math.min(...week.map(c => parseFloat(c[3])));
    }

    const tolerance = currentPrice * 0.001;
    const significantHighs = [];
    const significantLows  = [];
    recent72h.forEach(c => {
        const h = parseFloat(c[2]);
        const l = parseFloat(c[3]);
        if (recent72h.filter(x => Math.abs(parseFloat(x[2]) - h) < tolerance).length >= 2) significantHighs.push(h);
        if (recent72h.filter(x => Math.abs(parseFloat(x[3]) - l) < tolerance).length >= 2) significantLows.push(l);
    });
    const equalHighs = [...new Set(significantHighs.map(h => Math.round(h)))].slice(0, 3);
    const equalLows  = [...new Set(significantLows.map(l => Math.round(l)))].slice(0, 3);

    const rangeSize = high48h - low48h;
    const isRanging = rangeSize < currentPrice * 0.02;
    const rangePos  = isRanging ? ((currentPrice - low48h) / rangeSize * 100).toFixed(0) : null;

    const proximityThreshold = currentPrice * 0.003;
    const nearLevels = [];
    if (Math.abs(currentPrice - high72h) < proximityThreshold) nearLevels.push(`72h high at ${high72h.toFixed(0)}`);
    if (Math.abs(currentPrice - low72h)  < proximityThreshold) nearLevels.push(`72h low at ${low72h.toFixed(0)}`);
    if (weekHigh && Math.abs(currentPrice - weekHigh) < proximityThreshold) nearLevels.push(`weekly high at ${weekHigh.toFixed(0)}`);
    if (weekLow  && Math.abs(currentPrice - weekLow)  < proximityThreshold) nearLevels.push(`weekly low at ${weekLow.toFixed(0)}`);
    equalHighs.forEach(h => { if (Math.abs(currentPrice - h) < proximityThreshold * 2) nearLevels.push(`equal highs at ${h}`); });
    equalLows.forEach(l  => { if (Math.abs(currentPrice - l) < proximityThreshold * 2) nearLevels.push(`equal lows at ${l}`); });

    const open24h  = parseFloat(recent24h[0][1]);
    const close24h = parseFloat(recent24h[recent24h.length-1][4]);
    const trend24h = close24h > open24h ? 'bullish' : 'bearish';
    const change24h = ((close24h - open24h) / open24h * 100).toFixed(2);

    return {
        currentPrice: currentPrice.toFixed(2),
        high72h: high72h.toFixed(0),
        low72h:  low72h.toFixed(0),
        high24h: high24h.toFixed(0),
        low24h:  low24h.toFixed(0),
        weekHigh: weekHigh?.toFixed(0),
        weekLow:  weekLow?.toFixed(0),
        equalHighs,
        equalLows,
        isRanging,
        rangeHigh: high48h.toFixed(0),
        rangeLow:  low48h.toFixed(0),
        rangePos,
        nearLevels,
        trend24h,
        change24h,
    };
}

function buildLevelsPrompt(analysis) {
    const { currentPrice, high72h, low72h, high24h, low24h, weekHigh, weekLow,
            equalHighs, equalLows, isRanging, rangeHigh, rangeLow, rangePos,
            nearLevels, trend24h, change24h } = analysis;
    return `HISTORICAL ANALYSIS REQUEST:
Current price: $${currentPrice}
24h trend: ${trend24h} (${change24h}%)
72h range: High ${high72h} / Low ${low72h}
24h range: High ${high24h} / Low ${low24h}
${weekHigh ? `Weekly range: High ${weekHigh} / Low ${weekLow}` : ''}
${equalHighs.length ? `Equal highs: ${equalHighs.join(', ')}` : ''}
${equalLows.length  ? `Equal lows: ${equalLows.join(', ')}` : ''}
${isRanging ? `Ranging: ${rangeLow} to ${rangeHigh}, price at ${rangePos}% of range` : 'Trending — not ranging'}
${nearLevels.length ? `NEAR KEY LEVELS NOW: ${nearLevels.join(', ')}` : 'Not near a major level'}

Give a proactive levels observation. Vary the length — sometimes one punchy sentence is enough. Sometimes 2-3 if there's a lot to say. Plain text only. Be specific with prices.`;
}

function buildHistoricalChatPrompt(message, analysis) {
    if (!analysis) return message;
    const { currentPrice, high72h, low72h, high24h, low24h, weekHigh, weekLow,
            equalHighs, equalLows, isRanging, rangeHigh, rangeLow, rangePos,
            trend24h, change24h, nearLevels } = analysis;
    return `HISTORICAL DATA (last 7 days from Binance):
Price: $${currentPrice} | 24h: ${trend24h} ${change24h}%
72h: High ${high72h} / Low ${low72h}
24h: High ${high24h} / Low ${low24h}
${weekHigh ? `Weekly: High ${weekHigh} / Low ${weekLow}` : ''}
${equalHighs.length ? `Equal highs: ${equalHighs.join(', ')}` : ''}
${equalLows.length  ? `Equal lows: ${equalLows.join(', ')}` : ''}
${isRanging ? `Ranging: ${rangeLow} to ${rangeHigh} (${rangePos}%)` : 'Trending — not ranging'}
${nearLevels.length ? `Near key levels: ${nearLevels.join(', ')}` : ''}

User question: ${message}

Answer as Santosh using this real historical data. Be specific with prices. Plain text, vary length.`;
}

async function runHistoricalAnalysis() {
    try {
        console.log('[Santosh] Running historical analysis...');
        const [candles1h, candles1d] = await Promise.all([
            fetchKlines('1h', 168),
            fetchKlines('1d', 30),
        ]);
        if (!candles1h) { console.log('[Santosh] Could not fetch historical data'); return; }

        const analysis = analyseCandles(candles1h, candles1d);
        cachedLevels = analysis;
        lastLevelsTime = Date.now();

        const response = await client.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 120,
            system: SANTOSH_SYSTEM,
            messages: [{ role: 'user', content: buildLevelsPrompt(analysis) }]
        });

        const commentary = response.content[0].text.replace(/\*\*/g,'').replace(/\*/g,'');
        addToFeed({
            commentary,
            price: analysis.currentPrice,
            event_type: 'levels_analysis',
            high72h: analysis.high72h,
            low72h: analysis.low72h,
            weekHigh: analysis.weekHigh,
            weekLow: analysis.weekLow,
            equalHighs: analysis.equalHighs,
            equalLows: analysis.equalLows,
            nearLevels: analysis.nearLevels,
            isRanging: analysis.isRanging,
            rangeHigh: analysis.rangeHigh,
            rangeLow: analysis.rangeLow,
            timestamp: new Date().toISOString()
        });
        console.log('[Santosh] Historical analysis complete');
    } catch(err) {
        console.error('[Santosh] Historical analysis error:', err.message);
    }
}

// ── READ OPEN TRADE ───────────────────────────────────────────
function getOpenTrade() {
    try {
        const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
        if (!fs.existsSync(DB)) return null;
        const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
        return db.trades.find(t => t.status === 'open') || null;
    } catch(e) { return null; }
}

function getOpenTrades() {
    try {
        const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
        if (!fs.existsSync(DB)) return [];
        const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
        return db.trades.filter(t => t.status === 'open');
    } catch(e) { return []; }
}

function buildOpenTradeContext(trade, currentPrice) {
    if (!trade) return null;
    const price = parseFloat(currentPrice);
    const entry = parseFloat(trade.entry_price);
    const dir = trade.direction;
    const pts = dir === 'Long' ? price - entry : entry - price;
    const pnl = (pts * (trade.ppp||1) * (trade.size||1)).toFixed(2);
    const inProfit = pts > 0;
    const durSec = Math.round((Date.now() - trade.entry_time) / 1000);
    const durStr = durSec < 60 ? `${durSec}s` : `${Math.floor(durSec/60)}m ${durSec%60}s`;
    return {
        direction: dir,
        entry: entry.toFixed(2),
        currentPrice: price.toFixed(2),
        points: pts.toFixed(1),
        pnl,
        inProfit,
        duration: durStr,
        size: trade.size,
        summary: `OPEN TRADE: ${dir} from $${entry.toFixed(2)} | Now $${price.toFixed(2)} | ${inProfit?'+':''}${pts.toFixed(1)} pts | P&L ${inProfit?'+':''}$${pnl} | In trade ${durStr}`
    };
}

// [1] Build auto prompt — session context suppressed after first injection per session change
function buildAutoPrompt(amn, dash) {
    const zone = amn.zone_active
        ? `AMN zone: ${amn.zone_type} | midline ${amn.zone_mid} | TP ${amn.tp_level} | SL ${amn.sl_level}`
        : 'No confirmed zone';
    const sweep = amn.sweep_direction !== 'none' ? `Sweep: ${amn.sweep_direction}` : '';
    const choch = amn.choch ? `CHoCH: ${amn.choch_direction}` : '';
    const taps = amn.tap_count > 0 ? `Taps: ${amn.tap_count}/${amn.min_taps}` : '';
    const dashLine = dash ? `Dashboard (reference): ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';

    const openTrades = getOpenTrades();
    const tradeCtxs = openTrades.map(t => buildOpenTradeContext(t, amn.price)).filter(Boolean);
    const tradeLine = tradeCtxs.length > 0
        ? tradeCtxs.map(t => t.summary).join(' | ')
        : 'No open trade';
    const tradeCtx = tradeCtxs[0] || null; // primary trade for priority logic

    let levelsCtx = '';
    if (cachedLevels) {
        const { high72h, low72h, equalHighs, equalLows, nearLevels, isRanging, rangeHigh, rangeLow } = cachedLevels;
        levelsCtx = `Historical context: 72h High ${high72h} / Low ${low72h}`;
        if (nearLevels && nearLevels.length) levelsCtx += ` | NEAR: ${nearLevels.join(', ')}`;
        if (isRanging) levelsCtx += ` | Ranging ${rangeLow}-${rangeHigh}`;
        if (equalHighs && equalHighs.length) levelsCtx += ` | Equal highs: ${equalHighs.join(', ')}`;
        if (equalLows && equalLows.length) levelsCtx += ` | Equal lows: ${equalLows.join(', ')}`;
    }

    return `Signal: ${amn.event_type?.replace(/_/g,' ').toUpperCase()}
Price: $${amn.price} | EMA: ${amn.ema_trend} | RSI: ${amn.rsi}
HTF: ${amn.bias} (${amn.bull_votes}/3 bull, ${amn.bear_votes}/3 bear)
${zone}
${[sweep, choch, taps].filter(Boolean).join(' | ')}
${levelsCtx}
${tradeLine}
${dashLine}

${tradeCtx
    ? 'PRIORITY: Trader is in a live trade. Lead with advice on managing it. Then comment on the signal.'
    : 'Respond as Santosh. Focus on price action, candle behaviour, key levels. Do NOT mention the session or time of day.'}
Plain text only. Vary your length — sometimes one sentence is right, sometimes 2-3.`;
}

function buildDashPrompt(dash) {
    return `Dashboard: ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear
Sweep: ${dash.liq_sweep} | Price: $${dash.price}
${cachedLevels ? `Key levels: 72h High ${cachedLevels.high72h} / Low ${cachedLevels.low72h}` : ''}

Only speak if score hit 6+ or sweep fired AND session is active. If quiet, respond: quiet
Plain text. Do NOT mention session or time of day in your commentary.`;
}

function buildPostTradePrompt(trade, amn, dash) {
    const won = trade.pnl > 0;
    const dur = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur/60)}m${dur%60}s`;
    return `Trade closed: ${won?'WIN':'LOSS'} | ${trade.direction} | entry $${trade.entry_price} exit $${trade.exit_price} | ${trade.points?.toFixed(1)}pts | ${won?'+':''}$${trade.pnl?.toFixed(2)} | held ${durStr}
Market: $${amn?.price} | EMA ${amn?.ema_trend} | RSI ${amn?.rsi}
${cachedLevels ? `Key levels: 72h High ${cachedLevels.high72h} / Low ${cachedLevels.low72h}` : ''}

Honest debrief as Santosh. Focus on execution quality and whether the entry respected key levels. Plain text. 2-3 sentences.`;
}

module.exports = function(app) {

    // POST /analyst — AMN signal webhook
    app.post('/analyst', async (req, res) => {
        try {
            const now = Date.now();
            latestAMNData = req.body;
            checkSessionBanner(); // [1] check if session changed, emit banner if so
            if (now - lastCallTime < RATE_LIMIT_MS) return res.json({ skipped: true });
            lastCallTime = now;

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 90,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: buildAutoPrompt(req.body, latestDashData) }]
            });

            const commentary = response.content[0].text.replace(/\*\*/g,'').replace(/\*/g,'');
            addToFeed({
                commentary,
                price: req.body.price,
                bias: req.body.bias,
                bull_score: req.body.bull_votes,
                bear_score: req.body.bear_votes,
                event_type: req.body.event_type,
                zone_active: req.body.zone_active,
                zone_type: req.body.zone_type,
                zone_mid: req.body.zone_mid,
                tp_level: req.body.tp_level,
                sl_level: req.body.sl_level,
                timestamp: req.body.timestamp || new Date().toISOString()
            });
            res.json({ commentary, success: true });
        } catch (err) {
            console.error('Analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /analyst-dashboard
    app.post('/analyst-dashboard', async (req, res) => {
        try {
            latestDashData = req.body;
            const now = Date.now();
            const significant = req.body.bull_score >= 6 || req.body.bear_score >= 6 ||
                (req.body.liq_sweep && req.body.liq_sweep !== 'none' && req.body.liq_sweep !== '0');
            if (!significant || now - lastCallTime < RATE_LIMIT_MS) return res.json({ skipped: true });
            lastCallTime = now;

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 75,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: buildDashPrompt(req.body) }]
            });

            const commentary = response.content[0].text.replace(/\*\*/g,'').replace(/\*/g,'');
            if (commentary.toLowerCase().trim() === 'quiet' || commentary.length < 10) return res.json({ skipped: true });

            addToFeed({
                commentary,
                price: req.body.price,
                bias: req.body.bull_score > req.body.bear_score ? 'bull' : 'bear',
                bull_score: req.body.bull_score,
                bear_score: req.body.bear_score,
                event_type: 'dashboard_update',
                timestamp: new Date().toISOString()
            });
            res.json({ commentary, success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /analyst-bb-price — receives live BlackBull bid/ask from injected.js
    let bbBid = null, bbAsk = null, bbLivePriceTs = 0;
    app.post('/analyst-bb-price', (req, res) => {
        bbBid = parseFloat(req.body.bid);
        bbAsk = parseFloat(req.body.ask);
        bbLivePriceTs = Date.now();
        res.json({ ok: true });
    });

    // GET /analyst-bb-price — HTML polls this for accurate P&L
    app.get('/analyst-bb-price', (req, res) => {
        const fresh = bbBid && (Date.now() - bbLivePriceTs) < 10000;
        res.json({ bid: fresh ? bbBid : null, ask: fresh ? bbAsk : null });
    });

    // GET /analyst-feed
    app.get('/analyst-feed', (req, res) => res.json({ feed: commentaryFeed }));

    // GET /analyst-levels
    app.get('/analyst-levels', (req, res) => res.json({ levels: cachedLevels, lastUpdated: lastLevelsTime }));

    // GET /analyst-candles — [4] recent 1m candles + detected pattern for client SVG
    app.get('/analyst-candles', async (req, res) => {
        try {
            const candles = await fetchRecentCandles();
            if (!candles) return res.json({ candles: [], pattern: null });
            const pattern = detectCandlePattern(candles);
            // Return last 8 candles for mini chart
            const mini = candles.slice(-8).map(k => ({
                open:  parseFloat(k[1]),
                high:  parseFloat(k[2]),
                low:   parseFloat(k[3]),
                close: parseFloat(k[4]),
            }));
            res.json({ candles: mini, pattern });
        } catch(err) {
            res.json({ candles: [], pattern: null });
        }
    });

    // POST /analyst-chat
    app.post('/analyst-chat', async (req, res) => {
        try {
            const { message, sessionId = 'default' } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'No message' });

            if (!conversations[sessionId]) conversations[sessionId] = [];
            const history = conversations[sessionId];

            const amn = latestAMNData;
            const dash = latestDashData;
            const session = getSession();

            const isHistoricalQ = /level|high|low|range|week|72|48|24|hour|day|support|resist|equal|pattern|repeat|historic|previous|past|where.*been|been.*where/i.test(message);

            let userContent;
            if (isHistoricalQ && cachedLevels) {
                userContent = buildHistoricalChatPrompt(message, cachedLevels);
            } else {
                const z = amn?.zone_active ? ` | ${amn.zone_type} zone midline ${amn.zone_mid} TP ${amn.tp_level} SL ${amn.sl_level}` : '';
                const d = dash ? ` | Dashboard ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';
                const lvl = cachedLevels ? ` | 72h High ${cachedLevels.high72h} Low ${cachedLevels.low72h}` : '';
                const openTrades = getOpenTrades();
                const trd = openTrades.length > 0
                    ? ' | ' + openTrades.map(t => buildOpenTradeContext(t, amn?.price)?.summary).filter(Boolean).join(' | ')
                    : '';
                // For chat, include session as useful context (user asking questions)
                userContent = `[Chart: $${amn?.price||'?'} | ${amn?.bias||'?'} ${amn?.bull_votes||0}/3 HTF | EMA ${amn?.ema_trend||'?'} | RSI ${amn?.rsi||'?'}${z}${d}${lvl}${trd} | Session: ${session.label}]\n${message}`;
            }

            history.push({ role: 'user', content: userContent });
            while (history.length > MAX_HISTORY * 2) history.shift();

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 150,
                system: SANTOSH_SYSTEM,
                messages: history
            });

            const reply = response.content[0].text.replace(/\*\*/g,'').replace(/\*/g,'');
            history.push({ role: 'assistant', content: reply });
            res.json({ reply, success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /analyst-debrief/:id
    app.post('/analyst-debrief/:id', async (req, res) => {
        try {
            const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
            const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
            const trade = db.trades.find(t => t.id === parseInt(req.params.id));
            if (!trade) return res.status(404).json({ error: 'Trade not found' });

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 130,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: buildPostTradePrompt(trade, latestAMNData, latestDashData) }]
            });

            const debrief = response.content[0].text.replace(/\*\*/g,'').replace(/\*/g,'');
            const idx = db.trades.findIndex(t => t.id === parseInt(req.params.id));
            db.trades[idx].santosh_debrief = debrief;
            db.trades[idx].debrief_time = Date.now();
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            addToFeed({
                commentary: `Debrief: ${debrief}`,
                price: latestAMNData?.price,
                event_type: 'debrief',
                timestamp: new Date().toISOString()
            });
            res.json({ debrief, success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // [5] POST /analyst-register-trade — Chrome extension auto-registers open trade
    // Writes directly into main trades.json with cTrader position ID as ctrader_id field
    // Also closes any existing stale open trade first
    app.post('/analyst-register-trade', (req, res) => {
        try {
            const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
            let db = { trades: [], executions: [], nextId: 1 };
            if (fs.existsSync(DB)) db = JSON.parse(fs.readFileSync(DB, 'utf8'));

            const incoming = req.body;
            if (!incoming.id || !incoming.direction || !incoming.entry_price) {
                return res.status(400).json({ error: 'Missing required fields: id, direction, entry_price' });
            }

            const ctraderId = String(incoming.id);

            // Already registered and still open — idempotent
            const existing = db.trades.find(t => t.ctrader_id === ctraderId && t.status === 'open');
            if (existing) {
                return res.json({ status: 'already_registered', trade: existing });
            }

            // Allow up to 2 open trades — cancel oldest if already at limit
            const openTrades = db.trades.filter(t => t.status === 'open');
            if (openTrades.length >= 2) {
                const oldest = openTrades.sort((a,b) => a.entry_time - b.entry_time)[0];
                const oldestIdx = db.trades.findIndex(t => t.id === oldest.id);
                db.trades[oldestIdx].status = 'cancelled';
                console.log(`[Santosh] Max trades reached, cancelled oldest id=${oldest.id}`);
            }

            // Write new open trade into main trades.json
            const trade = {
                id: db.nextId++,
                ctrader_id: ctraderId,
                direction: incoming.direction,
                entry_price: parseFloat(incoming.entry_price),
                entry_time: incoming.entry_time || Date.now(),
                exit_price: null,
                exit_time: null,
                size: parseFloat(incoming.size) || 0.01,
                ppp: parseFloat(incoming.ppp) || 1,
                points: null,
                pnl: null,
                status: 'open',
                source: 'extension_auto'
            };
            db.trades.push(trade);
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            addToFeed({
                commentary: `${trade.direction} from $${trade.entry_price} — watching it.`,
                price: String(trade.entry_price),
                event_type: 'trade',
                timestamp: new Date().toISOString()
            });

            console.log(`[Santosh] Trade registered: ${trade.direction} $${trade.entry_price} ctrader_id=${ctraderId}`);
            res.json({ status: 'registered', trade });
        } catch(err) {
            console.error('[Santosh] Register trade error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // [5] POST /analyst-close-trade — Chrome extension closes trade when position closes
    // Matches by ctrader_id field, falls back to numeric id
    app.post('/analyst-close-trade', (req, res) => {
        try {
            const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
            if (!fs.existsSync(DB)) return res.status(404).json({ error: 'No trades DB' });
            const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

            const ctraderIdStr = String(req.body.id);

            // Match by ctrader_id first, then fall back to numeric id
            let idx = db.trades.findIndex(t => t.ctrader_id === ctraderIdStr && t.status === 'open');
            if (idx === -1) idx = db.trades.findIndex(t => String(t.id) === ctraderIdStr && t.status === 'open');
            // With multi-trade support, never use last resort — must match specific trade
            // if (idx === -1) idx = db.trades.findIndex(t => t.status === 'open');
            if (idx === -1) return res.status(404).json({ error: 'Open trade not found' });

            const trade = db.trades[idx];
            const exitPrice = parseFloat(req.body.exit_price) || parseFloat(latestAMNData?.price) || trade.entry_price;
            const pts = trade.direction === 'Long' ? exitPrice - trade.entry_price : trade.entry_price - exitPrice;
            db.trades[idx] = {
                ...trade,
                status: 'closed',
                exit_price: exitPrice,
                exit_time: req.body.exit_time || Date.now(),
                points: pts,
                pnl: pts * trade.ppp * trade.size
            };
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            console.log(`[Santosh] Trade closed: ctrader_id=${ctraderIdStr} exit=$${exitPrice} pts=${pts.toFixed(1)}`);
            res.json({ status: 'closed', trade: db.trades[idx] });
        } catch(err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/analyst-chat', (req, res) => res.sendFile('analyst.html', { root: './public' }));

    // Scheduled historical analysis
    setTimeout(runHistoricalAnalysis, 5000);
    setInterval(runHistoricalAnalysis, 30 * 60 * 1000);

    // Initial session check
    checkSessionBanner();

    console.log('✅ Santosh v9 loaded');
};
