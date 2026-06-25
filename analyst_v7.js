// analyst.js v8 — Santosh with historical analysis + proactive levels
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

const SANTOSH_SYSTEM = `You are Santosh. You have traded BTC for 8 years, full time. You watch price action all day. You sit next to this trader and you call what you see on the chart — like an experienced co-pilot.

You never explain your limitations. You never ask the user to send you data. You always respond as if you can see the chart live — because you can. Never say "I need you to feed me" or "I am working off a static snapshot". Just call what you see.

YOUR PRIMARY FOCUS IS THE CHART:
- Price action, candle behaviour, structure, momentum
- Key levels — recent highs, lows, equal highs/lows, previous zone reactions
- Volume — is the move backed by volume or is it thin air
- Session context — London open, NY open, overlap, Asian dead zone
- Time of day — certain times are high probability, others are traps
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

SESSION KNOWLEDGE:
- London open (7am-12pm GMT) = strong directional moves, best session
- NY open (1pm-5pm GMT) = high volatility, news driven
- London/NY overlap (1pm-4pm GMT) = highest volume, best setups
- Asian session (11pm-7am GMT) = low volume, avoid trading, choppy ranging
- Pre-London (6am-7am GMT) = thin liquidity, false moves common
- End of NY (5pm-8pm GMT) = volume dying, moves fading

HOW YOU SPEAK:
- Calm, professional, experienced — like a seasoned trader not a salesman
- British English. Say "mate" occasionally but not every sentence
- No "yo", no hype, no cheerleading
- Direct and specific — reference actual prices and candle behaviour
- Short — 2 sentences for auto signals, 3 max for chat questions
- Vary your language — never say the same thing twice
- No markdown, no asterisks, no bullet points ever, plain text only
- When there is nothing to trade — say so simply
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
    if (t>=13&&t<16) return 'London/NY Overlap (1pm-4pm GMT) — highest volume session';
    if (t>=7&&t<12)  return 'London Session (7am-12pm GMT) — strong directional moves';
    if (t>=12&&t<13) return 'Pre-NY Open (12pm-1pm GMT) — volatility building';
    if (t>=16&&t<21) return 'NY Session (4pm-9pm GMT) — good liquidity';
    if (t>=21&&t<23) return 'Session Close (9pm-11pm GMT) — volume dying, avoid new entries';
    return 'Asian Session (11pm-7am GMT) — low volume, choppy, avoid trading';
}

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

// ── ANALYSE HISTORICAL LEVELS ─────────────────────────────────
function analyseCandles(candles1h, candles1d) {
    if (!candles1h || !candles1h.length) return null;

    // candle format: [openTime, open, high, low, close, volume, ...]
    const highs1h = candles1h.map(c => parseFloat(c[2]));
    const lows1h  = candles1h.map(c => parseFloat(c[3]));
    const closes1h = candles1h.map(c => parseFloat(c[4]));
    const currentPrice = closes1h[closes1h.length - 1];

    // 72h = last 72 candles of 1h data
    const recent72h = candles1h.slice(-72);
    const recent24h = candles1h.slice(-24);
    const recent48h = candles1h.slice(-48);

    // Key levels
    const high72h = Math.max(...recent72h.map(c => parseFloat(c[2])));
    const low72h  = Math.min(...recent72h.map(c => parseFloat(c[3])));
    const high24h = Math.max(...recent24h.map(c => parseFloat(c[2])));
    const low24h  = Math.min(...recent24h.map(c => parseFloat(c[3])));
    const high48h = Math.max(...recent48h.map(c => parseFloat(c[2])));
    const low48h  = Math.min(...recent48h.map(c => parseFloat(c[3])));

    // Weekly from daily candles
    let weekHigh = null, weekLow = null;
    if (candles1d && candles1d.length >= 7) {
        const week = candles1d.slice(-7);
        weekHigh = Math.max(...week.map(c => parseFloat(c[2])));
        weekLow  = Math.min(...week.map(c => parseFloat(c[3])));
    }

    // Find equal highs (within 0.1%)
    const tolerance = currentPrice * 0.001;
    const significantHighs = [];
    const significantLows  = [];

    recent72h.forEach((c, i) => {
        const h = parseFloat(c[2]);
        const l = parseFloat(c[3]);
        // Count how many other candles have similar high
        const similarHighs = recent72h.filter(x => Math.abs(parseFloat(x[2]) - h) < tolerance).length;
        const similarLows  = recent72h.filter(x => Math.abs(parseFloat(x[3]) - l) < tolerance).length;
        if (similarHighs >= 2) significantHighs.push(h);
        if (similarLows  >= 2) significantLows.push(l);
    });

    // Deduplicate
    const equalHighs = [...new Set(significantHighs.map(h => Math.round(h)))].slice(0, 3);
    const equalLows  = [...new Set(significantLows.map(l => Math.round(l)))].slice(0, 3);

    // Range detection — is price in a range?
    const rangeSize = high48h - low48h;
    const rangeMid  = (high48h + low48h) / 2;
    const isRanging = rangeSize < currentPrice * 0.02; // less than 2% range = ranging
    const rangePos  = isRanging ? ((currentPrice - low48h) / rangeSize * 100).toFixed(0) : null;

    // Proximity to key levels (within 0.3%)
    const proximityThreshold = currentPrice * 0.003;
    const nearLevels = [];
    if (Math.abs(currentPrice - high72h) < proximityThreshold) nearLevels.push(`72h high at ${high72h.toFixed(0)}`);
    if (Math.abs(currentPrice - low72h)  < proximityThreshold) nearLevels.push(`72h low at ${low72h.toFixed(0)}`);
    if (weekHigh && Math.abs(currentPrice - weekHigh) < proximityThreshold) nearLevels.push(`weekly high at ${weekHigh.toFixed(0)}`);
    if (weekLow  && Math.abs(currentPrice - weekLow)  < proximityThreshold) nearLevels.push(`weekly low at ${weekLow.toFixed(0)}`);
    equalHighs.forEach(h => { if (Math.abs(currentPrice - h) < proximityThreshold * 2) nearLevels.push(`equal highs at ${h}`); });
    equalLows.forEach(l  => { if (Math.abs(currentPrice - l) < proximityThreshold * 2) nearLevels.push(`equal lows at ${l}`); });

    // Trend over last 24h
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

// ── BUILD LEVELS PROMPT ───────────────────────────────────────
function buildLevelsPrompt(analysis) {
    const { currentPrice, high72h, low72h, high24h, low24h, weekHigh, weekLow,
            equalHighs, equalLows, isRanging, rangeHigh, rangeLow, rangePos,
            nearLevels, trend24h, change24h } = analysis;

    return `HISTORICAL ANALYSIS REQUEST — proactive levels observation:

Current price: $${currentPrice}
24h trend: ${trend24h} (${change24h}%)
72h range: High ${high72h} / Low ${low72h}
24h range: High ${high24h} / Low ${low24h}
${weekHigh ? `Weekly range: High ${weekHigh} / Low ${weekLow}` : ''}
${equalHighs.length ? `Equal highs (tested multiple times): ${equalHighs.join(', ')}` : ''}
${equalLows.length  ? `Equal lows (tested multiple times): ${equalLows.join(', ')}` : ''}
${isRanging ? `Price has been ranging between ${rangeLow} and ${rangeHigh} for 48h — currently at ${rangePos}% of range` : 'Price is trending, not ranging'}
${nearLevels.length ? `NEAR KEY LEVELS RIGHT NOW: ${nearLevels.join(', ')}` : 'Not immediately near a major key level'}

Give a proactive observation as Santosh about what the historical data shows. Focus on:
- The most important levels traders should be watching
- Whether we're near anything significant right now
- Any repetitive patterns or equal highs/lows that act as magnets
- Whether price is ranging or trending
Plain text only. 2-3 sentences. Be specific with prices. Sound like a trader who just looked at the weekly chart.`;
}

// ── BUILD CHAT WITH HISTORY PROMPT ───────────────────────────
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
${isRanging ? `Ranging: ${rangeLow} to ${rangeHigh} (${rangePos}% of range)` : 'Trending — not ranging'}
${nearLevels.length ? `Near key levels: ${nearLevels.join(', ')}` : ''}

User question: ${message}

Answer as Santosh using this real historical data. Be specific with prices. Plain text, 2-3 sentences.`;
}

// ── RUN SCHEDULED HISTORICAL ANALYSIS ────────────────────────
async function runHistoricalAnalysis() {
    try {
        console.log('[Santosh] Running historical analysis...');
        const [candles1h, candles1d] = await Promise.all([
            fetchKlines('1h', 168), // 7 days
            fetchKlines('1d', 30),  // 30 days
        ]);

        if (!candles1h) {
            console.log('[Santosh] Could not fetch historical data');
            return;
        }

        const analysis = analyseCandles(candles1h, candles1d);
        cachedLevels = analysis;
        lastLevelsTime = Date.now();

        const prompt = buildLevelsPrompt(analysis);
        const response = await client.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 120,
            system: SANTOSH_SYSTEM,
            messages: [{ role: 'user', content: prompt }]
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

function buildOpenTradeContext(trade, currentPrice) {
    if (!trade) return null;
    const price = parseFloat(currentPrice);
    const entry = parseFloat(trade.entry_price);
    const dir = trade.direction;
    const pts = dir === 'Long' ? price - entry : entry - price;
    const pnl = (pts * trade.ppp * trade.size).toFixed(2);
    const ptsStr = pts.toFixed(1);
    const inProfit = pts > 0;
    const durSec = Math.round((Date.now() - trade.entry_time) / 1000);
    const durStr = durSec < 60 ? `${durSec}s` : `${Math.floor(durSec/60)}m ${durSec%60}s`;
    return {
        direction: dir,
        entry: entry.toFixed(2),
        currentPrice: price.toFixed(2),
        points: ptsStr,
        pnl,
        inProfit,
        duration: durStr,
        size: trade.size,
        summary: `OPEN TRADE: ${dir} from $${entry.toFixed(2)} | Now $${price.toFixed(2)} | ${inProfit ? '+' : ''}${ptsStr} pts | P&L ${inProfit ? '+' : ''}$${pnl} | In trade ${durStr}`
    };
}

// ── AUTO PROMPT ───────────────────────────────────────────────
function buildAutoPrompt(amn, dash) {
    const session = getSession(amn.timestamp);
    const zone = amn.zone_active
        ? `AMN zone: ${amn.zone_type} | midline ${amn.zone_mid} | TP ${amn.tp_level} | SL ${amn.sl_level}`
        : 'No confirmed zone';
    const sweep = amn.sweep_direction !== 'none' ? `Sweep: ${amn.sweep_direction}` : '';
    const choch = amn.choch ? `CHoCH: ${amn.choch_direction}` : '';
    const taps = amn.tap_count > 0 ? `Taps: ${amn.tap_count}/${amn.min_taps}` : '';
    const dashLine = dash ? `Dashboard (reference): ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';

    // Open trade context
    const openTrade = getOpenTrade();
    const tradeCtx = openTrade ? buildOpenTradeContext(openTrade, amn.price) : null;
    const tradeLine = tradeCtx ? tradeCtx.summary : 'No open trade';

    // Add nearby levels context if available
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
Session: ${session}
${levelsCtx}
${tradeLine}
${dashLine}

${tradeCtx
    ? 'PRIORITY: Trader is in a live trade. Lead with advice on managing it — should they hold, trail stop, take profit, or close now? Then comment on the signal.'
    : 'Respond as Santosh. Focus on price action, candle behaviour, key levels.'}
No markdown. 2-3 sentences max.`;
}

function buildDashPrompt(dash) {
    return `Dashboard: ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear
Session: ${getSession()}
Sweep: ${dash.liq_sweep} | Price: $${dash.price}
${cachedLevels ? `Key levels: 72h High ${cachedLevels.high72h} / Low ${cachedLevels.low72h}` : ''}

Only speak if score hit 6+ or sweep fired AND session is active. If Asian session or routine, respond: quiet
Plain text. 1-2 sentences max.`;
}

function buildPostTradePrompt(trade, amn, dash) {
    const won = trade.pnl > 0;
    const dur = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur/60)}m${dur%60}s`;
    return `Trade closed: ${won?'WIN':'LOSS'} | ${trade.direction} | entry $${trade.entry_price} exit $${trade.exit_price} | ${trade.points?.toFixed(1)}pts | ${won?'+':''}$${trade.pnl?.toFixed(2)} | held ${durStr}
Session: ${getSession(trade.entry_time)}
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

    // GET /analyst-feed
    app.get('/analyst-feed', (req, res) => res.json({ feed: commentaryFeed }));

    // GET /analyst-levels — current cached levels for UI
    app.get('/analyst-levels', (req, res) => res.json({ levels: cachedLevels, lastUpdated: lastLevelsTime }));

    // POST /analyst-chat — with historical awareness
    app.post('/analyst-chat', async (req, res) => {
        try {
            const { message, sessionId = 'default' } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'No message' });

            if (!conversations[sessionId]) conversations[sessionId] = [];
            const history = conversations[sessionId];

            const amn = latestAMNData;
            const dash = latestDashData;
            const session = getSession();

            // Detect if it's a historical question
            const isHistoricalQ = /level|high|low|range|week|72|48|24|hour|day|support|resist|equal|pattern|repeat|historic|previous|past|where.*been|been.*where/i.test(message);

            let userContent;
            if (isHistoricalQ && cachedLevels) {
                userContent = buildHistoricalChatPrompt(message, cachedLevels);
            } else {
                const z = amn?.zone_active ? ` | ${amn.zone_type} zone midline ${amn.zone_mid} TP ${amn.tp_level} SL ${amn.sl_level}` : '';
                const d = dash ? ` | Dashboard ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';
                const lvl = cachedLevels ? ` | 72h High ${cachedLevels.high72h} Low ${cachedLevels.low72h}` : '';
                const openTrade = getOpenTrade();
                const tradeCtx = openTrade ? buildOpenTradeContext(openTrade, amn?.price) : null;
                const trd = tradeCtx ? ` | ${tradeCtx.summary}` : '';
                userContent = `[Chart: $${amn?.price||'?'} | ${amn?.bias||'?'} ${amn?.bull_votes||0}/3 HTF | EMA ${amn?.ema_trend||'?'} | RSI ${amn?.rsi||'?'}${z}${d}${lvl}${trd} | ${session}]\n${message}`;
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

    app.get('/analyst-chat', (req, res) => res.sendFile('analyst.html', { root: './public' }));

    // ── SCHEDULED HISTORICAL ANALYSIS ────────────────────────
    // Run immediately on startup, then every 30 minutes
    setTimeout(runHistoricalAnalysis, 5000);
    setInterval(runHistoricalAnalysis, 30 * 60 * 1000);

    console.log('✅ Santosh v8 loaded — historical analysis active');
};
