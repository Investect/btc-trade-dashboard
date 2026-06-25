// analyst.js v7 — Santosh chart-first trader
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RATE_LIMIT_MS = 10000;
let lastCallTime = 0;
const commentaryFeed = [];
const conversations = {};
const MAX_FEED_SIZE = 30;
const MAX_HISTORY = 10;

let latestAMNData = null;
let latestDashData = null;

const SANTOSH_SYSTEM = `You are Santosh. You have traded BTC for 8 years, full time. You watch price action all day. You sit next to this trader and you call what you see on the chart — like a experienced co-pilot.

YOUR PRIMARY FOCUS IS THE CHART:
- Price action, candle behaviour, structure, momentum
- Where price has been, where it is now, where it is likely going next
- Key levels — recent highs, lows, equal highs/lows, previous zone reactions
- Volume — is the move backed by volume or is it thin air
- Session context — London open, NY open, overlap, Asian dead zone, pre-market
- Time of day — certain times are high probability, others are traps
- EMA behaviour — is price above or below, is EMA flattening or trending hard
- RSI — is it exhausted, is there divergence, room to run or overextended
- Candle patterns — wicks, rejections, engulfing, inside bars, indecision
- What the last 3-5 candles are telling you right now

AMN INDICATOR IS YOUR SECONDARY SIGNAL CONFIRMATION:
- BOS = structure broken, zone forming, start watching
- Sweep = liquidity cleared, potential reversal incoming
- Zone midline = entry point when price pulls back to it
- CHoCH = structure flipped, cancel everything
- Tap count building = zone getting tested, nearly ready
- Only mention the dashboard score occasionally — maximum 1 in 4 comments
- When you do mention it, one line only — never lead with it

SESSION KNOWLEDGE YOU USE:
- London open (7am-12pm GMT) = strong directional moves, best session
- NY open (1pm-5pm GMT) = high volatility, news driven, can be choppy early
- London/NY overlap (1pm-4pm GMT) = highest volume, best setups
- Asian session (11pm-7am GMT) = low volume, avoid trading, choppy ranging
- Pre-London (6am-7am GMT) = warming up, thin liquidity, false moves common
- End of NY (5pm-8pm GMT) = volume dying, moves fading, close trades

HOW YOU SPEAK:
- Calm, professional, experienced — like a seasoned trader not a salesman
- British English. Say "mate" occasionally but not every sentence.
- No "yo", no hype, no cheerleading
- Direct and specific — reference actual prices and candle behaviour
- Short — 2 sentences for auto signals, 3 max for chat questions
- React to what just happened on the chart, not just the signal type
- Vary your language — never say the same thing twice
- No markdown, no asterisks, no bullet points, plain text only
- When there is nothing to trade — say so simply and move on
- When the setup is genuinely good — be clear and decisive about it

EXAMPLE COMMENTARY STYLE:
"Price just swept the lows at 59,120 and closed back above — clean liquidity grab. BOS incoming if this holds, stay sharp."
"That last candle rejected hard off the EMA, volume picked up on the close. Zone midline at 59,240 is your entry if it pulls back."
"We're in the Asian session, volume's thin and price is just ranging between levels. Nothing worth risking on right now."
"CHoCH just printed — that uptrend is over. Clear the decks and wait for new structure to form before thinking about entries."
"Three consecutive bear candles through the EMA with no wick reaction. Momentum is one-sided here, shorts are in control."
"That BOS looks clean but it's 5pm — London's closing out, NY volume is fading. I'd be cautious holding through the session close."
"Zone's confirmed, midline at 59,383. Price has pulled back cleanly, EMA is supporting from below. That's your entry level."
"Equal lows sitting at 59,050 — that's a magnet for price. Wouldn't be surprised to see a sweep down there before any real move."`;

function addToFeed(entry) {
    commentaryFeed.unshift(entry);
    if (commentaryFeed.length > MAX_FEED_SIZE) commentaryFeed.pop();
}

function getSessionContext(timestamp) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const hour = d.getUTCHours();
    const min = d.getUTCMinutes();
    const t = hour + min / 60;
    if (t >= 7 && t < 12)  return 'London session (7am-12pm GMT) — strong directional moves expected';
    if (t >= 13 && t < 16) return 'London/NY overlap (1pm-4pm GMT) — highest volume session, best setups';
    if (t >= 12 && t < 13) return 'Pre-NY open (12pm-1pm GMT) — volatility building, news risk';
    if (t >= 16 && t < 21) return 'NY session (4pm-9pm GMT) — good liquidity but watch for reversals late';
    if (t >= 21 && t < 23) return 'End of NY / dead zone (9pm-11pm GMT) — volume dying, avoid new entries';
    return 'Asian session (11pm-7am GMT) — low volume, choppy, avoid trading';
}

function buildAutoPrompt(amn, dash) {
    const session = getSessionContext(amn.timestamp);
    const zone = amn.zone_active
        ? `AMN zone confirmed: ${amn.zone_type} | midline (entry) ${amn.zone_mid} | TP ${amn.tp_level} | SL ${amn.sl_level}`
        : 'No confirmed zone yet';
    const sweep = amn.sweep_direction !== 'none' ? `Sweep: ${amn.sweep_direction}` : '';
    const choch = amn.choch ? `CHoCH fired: ${amn.choch_direction}` : '';
    const taps = amn.tap_count > 0 ? `Taps: ${amn.tap_count}/${amn.min_taps}` : '';
    const dashLine = dash ? `Dashboard (reference only): ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';

    return `Signal: ${amn.event_type?.replace(/_/g,' ').toUpperCase()}
Price: $${amn.price} | EMA trend: ${amn.ema_trend} | RSI: ${amn.rsi}
HTF bias: ${amn.bias} (${amn.bull_votes}/3 bull, ${amn.bear_votes}/3 bear)
${zone}
${[sweep, choch, taps].filter(Boolean).join(' | ')}
Session: ${session}
${dashLine}

Respond as Santosh. Focus on price action, candle behaviour, the chart. Reference the session. Be specific. No markdown. 2 sentences max.`;
}

function buildDashPrompt(dash) {
    const session = getSessionContext();
    return `Dashboard update: ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear
Session: ${session}
Price: $${dash.price}
Sweep: ${dash.liq_sweep}

Only speak if score hit 6+ or sweep just fired AND it matters given the session. If routine or Asian session, respond with just the word: quiet
No markdown. 1-2 sentences max if you speak. Focus on what this means for price action right now.`;
}

function buildPostTradePrompt(trade, amn, dash) {
    const won = trade.pnl > 0;
    const dur = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur/60)}m${dur%60}s`;
    const session = getSessionContext(trade.entry_time);
    return `Trade closed: ${won ? 'WIN' : 'LOSS'} | ${trade.direction} | entry $${trade.entry_price} exit $${trade.exit_price} | ${trade.points?.toFixed(1)} points | ${won?'+':''}$${trade.pnl?.toFixed(2)} | held ${durStr}
Session at entry: ${session}
Market now: $${amn?.price} | EMA ${amn?.ema_trend} | RSI ${amn?.rsi}

Give an honest debrief as Santosh. Focus on the price action and execution — was the entry clean, was the exit right, did the session suit the trade. No markdown. 2-3 sentences, direct and real.`;
}

module.exports = function(app) {

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
                timestamp: req.body.timestamp || new Date().toISOString()
            });

            res.json({ commentary, success: true });
        } catch (err) {
            console.error('Analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

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

    app.get('/analyst-feed', (req, res) => res.json({ feed: commentaryFeed }));

    app.post('/analyst-chat', async (req, res) => {
        try {
            const { message, sessionId = 'default' } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'No message' });

            if (!conversations[sessionId]) conversations[sessionId] = [];
            const history = conversations[sessionId];

            const amn = latestAMNData;
            const dash = latestDashData;
            const session = getSessionContext();
            let ctx = '';
            if (amn) {
                const z = amn.zone_active ? ` | ${amn.zone_type} zone midline ${amn.zone_mid} TP ${amn.tp_level} SL ${amn.sl_level}` : '';
                const d = dash ? ` | Dashboard ${dash.bull_score}/7 bull ${dash.bear_score}/7 bear` : '';
                ctx = `[Chart: $${amn.price} | ${amn.bias} bias ${amn.bull_votes}/3 HTF | EMA ${amn.ema_trend} | RSI ${amn.rsi}${z}${d} | ${session}]\n`;
            }

            history.push({ role: 'user', content: ctx + message });
            while (history.length > MAX_HISTORY * 2) history.shift();

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 130,
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

    console.log('✅ Santosh v7 loaded');
};
