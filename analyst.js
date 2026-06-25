// analyst.js v5 — Santosh with full AMN + Dashboard cross-comparison
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RATE_LIMIT_MS = 8000;
let lastCallTime = 0;
const commentaryFeed = [];
const conversations = {};
const MAX_FEED_SIZE = 30;
const MAX_HISTORY = 10;

// Store latest data from BOTH indicators separately
let latestAMNData = null;
let latestDashData = null;

const SANTOSH_SYSTEM = `You are Santosh — a mate who happens to be a professional BTC scalp trader with 8 years experience. You're sitting right next to the trader watching the same screen. You trade the AMN strategy together.

AMN RULES YOU KNOW:
- BOS fires → count taps (min 2) → zone confirmed → enter at 50% midline → minimum 1.1R
- Need 2 of 3 HTF timeframes aligned before any trade
- Always wait for a liquidity sweep before entry
- CHoCH means cancel everything and wait for new structure
- Max 3 trades per day, stop after 2 losses no matter what
- Fresh zones only — if 50% midline already crossed, zone is dead

SIGNAL QUALITY RATING — you assess this every time:
- GRADE A (7/7 or 6/7 dashboard + AMN signal + sweep confirmed) = "this is as clean as it gets, take it"
- GRADE B (5/7 dashboard + AMN signal) = "decent setup, take it but size down"
- GRADE C (4/7 or below) = "weak confluence, I'd skip this one"
- If AMN fires but dashboard score is low = warn them
- If dashboard is 7/7 but no AMN signal yet = alert them to get ready
- Always compare what the AMN indicator says vs what the dashboard says — if they disagree, say so

DASHBOARD READINGS:
- bull_score/7 and bear_score/7 = overall confluence score
- trend_1m/5m/15m/1h = individual timeframe trends
- momentum_1m/5m/15m = EMA momentum
- structure = HH/HL (bullish) or LH/LL (bearish)
- liq_sweep = recent liquidity sweep detection
- verdict = dashboard's overall verdict

YOUR VOICE:
- Talk like a friendly experienced trader mate, casual and real
- Say things like "hey", "yo", "alright", "mate", "look", "right"
- Short sentences. Natural. Like you're talking not writing.
- 2-3 sentences MAX for auto signals. Never longer.
- Rate the setup quality in every signal comment
- When AMN and dashboard agree = confident
- When they disagree = cautious and say why
- Never robotic. Never say "As an AI". Never write paragraphs.

EXAMPLE COMMENTARIES:
"Yo, GO LONG just fired — dashboard is 7/7 bull, structure HH/HL across the board. Zone mid is 59,240, this is Grade A mate, get in."
"Hey BOS just printed but dashboard is only 4/7 — momentum on 5m is still bear. Grade C setup, I'd sit this one out."
"Alright, sweep cleared sell-side and dashboard just hit 6/7 bull. AMN hasn't fired yet but get ready — BOS incoming any second."
"CHoCH bear just fired — drop everything. Dashboard agrees, bear score jumping. Wait for new structure."
"Nothing doing — dashboard is 3/7, mixed signals across timeframes. Hands off the keyboard mate."`;

function addToFeed(entry) {
    commentaryFeed.unshift(entry);
    if (commentaryFeed.length > MAX_FEED_SIZE) commentaryFeed.pop();
}

function getSignalQuality(amnData, dashData) {
    if (!dashData) return { grade: 'unknown', label: 'No dashboard data yet' };
    const isBull = amnData?.bias === 'bull' || amnData?.event_type?.includes('long') || amnData?.event_type?.includes('bull');
    const score = isBull ? dashData.bull_score : dashData.bear_score;
    const hasZone = amnData?.zone_active;
    const hasSweep = amnData?.sweep_direction && amnData.sweep_direction !== 'none';
    if (score >= 6 && hasZone && hasSweep) return { grade: 'A', label: `Grade A — ${score}/7 dashboard, zone + sweep confirmed` };
    if (score >= 6 && hasZone) return { grade: 'A-', label: `Grade A — ${score}/7 dashboard, zone confirmed` };
    if (score >= 5) return { grade: 'B', label: `Grade B — ${score}/7 dashboard` };
    if (score >= 4) return { grade: 'C', label: `Grade C — only ${score}/7 dashboard, weak confluence` };
    return { grade: 'D', label: `Skip — ${score}/7 dashboard, too weak` };
}

function buildAutoPrompt(amnData, dashData) {
    const evt = amnData.event_type?.replace(/_/g, ' ').toUpperCase() || 'UPDATE';
    const bias = `${amnData.bias?.toUpperCase()} — AMN: ${amnData.bull_votes}/3 HTF bull, ${amnData.bear_votes}/3 HTF bear`;
    const zone = amnData.zone_active
        ? `Zone: ${amnData.zone_type} | Entry ${amnData.zone_mid} | TP ${amnData.tp_level} | SL ${amnData.sl_level}`
        : 'No confirmed zone yet';

    const quality = getSignalQuality(amnData, dashData);

    let dashContext = 'Dashboard: no data yet';
    if (dashData) {
        dashContext = `Dashboard Score: BULL ${dashData.bull_score}/7, BEAR ${dashData.bear_score}/7
Verdict: ${dashData.verdict}
Trend: 1m ${dashData.trend_1m} | 5m ${dashData.trend_5m} | 15m ${dashData.trend_15m} | 1h ${dashData.trend_1h}
Momentum: 1m ${dashData.mom_1m} | 5m ${dashData.mom_5m} | 15m ${dashData.mom_15m}
Structure: 1m ${dashData.str_1m} | 5m ${dashData.str_5m}
Liq Sweep: ${dashData.liq_sweep || 'none'}
RSI: 1m ${dashData.rsi_1m} | 5m ${dashData.rsi_5m} | 15m ${dashData.rsi_15m}`;
    }

    const extras = [
        amnData.choch ? `CHoCH ${amnData.choch_direction} fired` : null,
        amnData.sweep_direction && amnData.sweep_direction !== 'none' ? `${amnData.sweep_direction} sweep hit` : null,
        amnData.tap_count > 0 ? `${amnData.tap_count}/${amnData.min_taps} taps` : null,
    ].filter(Boolean).join(' | ');

    return `AMN SIGNAL: ${evt}
Price: $${amnData.price} | ${bias}
EMA: ${amnData.ema_trend} | RSI: ${amnData.rsi}
${zone}
${extras || ''}

${dashContext}

SIGNAL QUALITY: ${quality.label}

Respond as Santosh. 2-3 sentences max. Compare what AMN says vs dashboard. Rate the setup. Tell them what to do. Casual and human.`;
}

function buildDashOnlyPrompt(dashData) {
    return `DASHBOARD UPDATE (no AMN signal yet):
Score: BULL ${dashData.bull_score}/7, BEAR ${dashData.bear_score}/7
Verdict: ${dashData.verdict}
Trend: 1m ${dashData.trend_1m} | 5m ${dashData.trend_5m} | 15m ${dashData.trend_15m} | 1h ${dashData.trend_1h}
Momentum: 1m ${dashData.mom_1m} | 5m ${dashData.mom_5m} | 15m ${dashData.mom_15m}
Liq Sweep: ${dashData.liq_sweep || 'none'}
Price: $${dashData.price}

Only speak up if something significant changed — score hit 6+ or 7, sweep just appeared, or score dropped suddenly. Otherwise stay quiet (respond with just "quiet"). 2 sentences max if you do speak.`;
}

function buildPostTradePrompt(trade, amnData, dashData) {
    const won = trade.pnl > 0;
    const dur = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur / 60)}m ${dur % 60}s`;
    const quality = getSignalQuality(amnData, dashData);
    return `TRADE CLOSED:
${won ? 'WIN ✅' : 'LOSS ❌'} | ${trade.direction} | Entry $${trade.entry_price} → Exit $${trade.exit_price} | ${trade.points?.toFixed(1)}pts | P&L ${won ? '+' : ''}$${trade.pnl?.toFixed(2)} | Held ${durStr}

Current market: $${amnData?.price} | ${amnData?.bias} ${amnData?.bull_votes}/3 HTF
Dashboard now: BULL ${dashData?.bull_score || '?'}/7, BEAR ${dashData?.bear_score || '?'}/7 | ${dashData?.verdict || 'unknown'}
Signal quality at time: ${quality.label}

Debrief as Santosh — 2-3 sentences. Was the setup Grade A/B/C quality? Did they follow AMN rules? What's the one thing to take away? Real and casual.`;
}

module.exports = function(app) {

    // POST /analyst — AMN Scalp 15s webhook
    app.post('/analyst', async (req, res) => {
        try {
            const now = Date.now();
            const data = req.body;
            latestAMNData = data;

            if (now - lastCallTime < RATE_LIMIT_MS) {
                return res.json({ skipped: true });
            }
            lastCallTime = now;

            const prompt = buildAutoPrompt(data, latestDashData);
            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 110,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: prompt }]
            });

            const commentary = response.content[0].text;
            const quality = getSignalQuality(data, latestDashData);

            addToFeed({
                commentary,
                price: data.price,
                bias: data.bias,
                bull_score: data.bull_votes,
                bear_score: data.bear_votes,
                event_type: data.event_type,
                zone_active: data.zone_active,
                zone_type: data.zone_type,
                zone_mid: data.zone_mid,
                signal_grade: quality.grade,
                timestamp: data.timestamp || new Date().toISOString()
            });

            res.json({ commentary, grade: quality.grade, success: true });

        } catch (err) {
            console.error('Analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /analyst-dashboard — AMN Dashboard webhook
    app.post('/analyst-dashboard', async (req, res) => {
        try {
            const data = req.body;
            latestDashData = data;

            const now = Date.now();

            // Only speak if score is high (6+/7) or something significant changed
            const prevScore = latestDashData?.prev_bull_score || 0;
            const scoreSpiked = data.bull_score >= 6 || data.bear_score >= 6;
            const sweepFired = data.liq_sweep && data.liq_sweep !== 'none';
            const shouldSpeak = scoreSpiked || sweepFired;

            if (!shouldSpeak || now - lastCallTime < RATE_LIMIT_MS) {
                return res.json({ skipped: true });
            }
            lastCallTime = now;

            const prompt = buildDashOnlyPrompt(data);
            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 80,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: prompt }]
            });

            const commentary = response.content[0].text;

            // Don't add to feed if Santosh said "quiet"
            if (commentary.toLowerCase().trim() !== 'quiet' && commentary.length > 10) {
                addToFeed({
                    commentary,
                    price: data.price,
                    bias: data.bull_score > data.bear_score ? 'bull' : 'bear',
                    bull_score: data.bull_score,
                    bear_score: data.bear_score,
                    event_type: 'dashboard_update',
                    timestamp: new Date().toISOString()
                });
            }

            res.json({ commentary, success: true });

        } catch (err) {
            console.error('Dashboard analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /analyst-feed
    app.get('/analyst-feed', (req, res) => {
        res.json({ feed: commentaryFeed });
    });

    // POST /analyst-chat — user question
    app.post('/analyst-chat', async (req, res) => {
        try {
            const { message, sessionId = 'default' } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'No message' });

            if (!conversations[sessionId]) conversations[sessionId] = [];
            const history = conversations[sessionId];

            let userContent = message;
            const d = latestAMNData;
            const dash = latestDashData;
            if (d || dash) {
                const zoneStr = d?.zone_active ? ` | ${d.zone_type} zone: entry ${d.zone_mid} TP ${d.tp_level} SL ${d.sl_level}` : '';
                const dashStr = dash ? ` | Dashboard: BULL ${dash.bull_score}/7 BEAR ${dash.bear_score}/7 | ${dash.verdict}` : '';
                userContent = `[Chart: $${d?.price || '?'} | AMN: ${d?.bias || '?'} ${d?.bull_votes || 0}/3 HTF | EMA ${d?.ema_trend || '?'}${zoneStr}${dashStr}]\n${message}`;
            }

            history.push({ role: 'user', content: userContent });
            while (history.length > MAX_HISTORY * 2) history.shift();

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 150,
                system: SANTOSH_SYSTEM,
                messages: history
            });

            const reply = response.content[0].text;
            history.push({ role: 'assistant', content: reply });

            res.json({ reply, success: true });

        } catch (err) {
            console.error('Chat error:', err.message);
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
            if (trade.status !== 'closed') return res.status(400).json({ error: 'Not closed' });

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 150,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: buildPostTradePrompt(trade, latestAMNData, latestDashData) }]
            });

            const debrief = response.content[0].text;
            const idx = db.trades.findIndex(t => t.id === parseInt(req.params.id));
            db.trades[idx].santosh_debrief = debrief;
            db.trades[idx].debrief_time = Date.now();
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            addToFeed({
                commentary: `📋 ${debrief}`,
                price: latestAMNData?.price,
                event_type: 'debrief',
                timestamp: new Date().toISOString()
            });

            res.json({ debrief, success: true });

        } catch (err) {
            console.error('Debrief error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/analyst-chat', (req, res) => {
        res.sendFile('analyst.html', { root: './public' });
    });

    console.log('✅ Santosh v5 loaded: /analyst /analyst-dashboard /analyst-feed /analyst-chat /analyst-debrief/:id');
};
