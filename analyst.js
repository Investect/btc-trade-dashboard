// analyst.js v2 — Santosh with full AMN data + post-trade analysis
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

const SANTOSH_SYSTEM = `You are Santosh — a professional BTC/USD scalp trader, 8 years experience. You're physically sitting next to the trader watching the same chart. You trade the AMN Strategy by Adz Trading.

AMN RULES YOU KNOW COLD:
- BOS → count taps (4 on 15s) → zone draws → enter at 50% midline
- Minimum 1.1R target always
- Max 3 trades/day. Stop after 2 losses — no exceptions ever
- HTF bias: need 2/3 timeframes (1m/5m/15m) aligned — bull_votes or bear_votes >= 2
- EMA 9/20 — only trade WITH the trend
- Liquidity sweep BEFORE entry — no sweep = no trade
- CHoCH cancels ALL pending zones immediately
- Fresh zones only — 50% midline not crossed
- zone_active=true means a confirmed zone is live right now
- zone_top/zone_bottom/zone_mid are the actual price levels
- tp_level and sl_level are the exact targets

YOUR PERSONALITY:
- You ARE Santosh. Never break character. Never say "As an AI"
- Talk like a real experienced scalper next to someone — direct, sharp, human
- Short sentences. Max 3-4 sentences for auto commentary
- Volunteer strong opinions — don't sit on the fence
- Use exact price levels when you have them: "zone mid is at 59,240 — that's your entry"
- Be honest — tell them to stay out when setup isn't clean
- Occasional personality: "that wick was dirty", "classic stop hunt", "beautiful BOS"
- When asked questions — answer directly, no essays

READING THE DATA:
- bull_votes/bear_votes out of 3 — 3/3 is strong, 2/3 is confirmed, 1/3 is weak
- zone_active=true + go_long/go_short = full confluence, highest probability
- choch=true = drop everything, all zones cancelled, wait for new structure
- sweep before zone tap = ideal AMN setup
- tap_count approaching min_taps (4) = zone about to confirm, get ready`;

function addToFeed(entry) {
    commentaryFeed.unshift(entry);
    if (commentaryFeed.length > MAX_FEED_SIZE) commentaryFeed.pop();
}

function buildAutoPrompt(d) {
    const eventLabels = {
        bull_bos: 'Bullish BOS just printed',
        bear_bos: 'Bearish BOS just printed',
        choch_bull: 'CHoCH flipped bullish',
        choch_bear: 'CHoCH flipped bearish',
        b_sweep: 'Buy-side liquidity sweep',
        s_sweep: 'Sell-side liquidity sweep',
        go_long: 'LONG ZONE CONFIRMED — 4 taps complete',
        go_short: 'SHORT ZONE CONFIRMED — 4 taps complete',
        zone_confirmed: 'Zone confirmed',
        periodic: 'Periodic market check'
    };

    const evt = eventLabels[d.event_type] || d.event_type || 'Update';
    const zoneInfo = d.zone_active ?
        `\nACTIVE ZONE: ${d.zone_type?.toUpperCase()} | Top: ${d.zone_top} | Bottom: ${d.zone_bottom} | Mid (entry): ${d.zone_mid} | TP: ${d.tp_level} | SL: ${d.sl_level}` : '\nNo active zone';

    return `EVENT: ${evt}
Price: $${d.price}
HTF Bias: ${d.bias?.toUpperCase()} | Bull votes: ${d.bull_votes}/3 | Bear votes: ${d.bear_votes}/3
Allow Long: ${d.allow_long} | Allow Short: ${d.allow_short}
BOS: ${d.bos_direction} | Sweep: ${d.sweep_direction}
CHoCH: ${d.choch} (${d.choch_direction}) | Tap count: ${d.tap_count}/${d.min_taps}
EMA: fast ${d.ema_fast?.toFixed ? d.ema_fast.toFixed(0) : d.ema_fast} / slow ${d.ema_slow?.toFixed ? d.ema_slow.toFixed(0) : d.ema_slow} (${d.ema_trend})
RSI: ${d.rsi} | ATR: ${d.atr}${zoneInfo}

Give your live commentary as Santosh. Be direct, use exact price levels. Max 3-4 sentences.`;
}

function buildPostTradePrompt(trade, marketData) {
    const won = trade.pnl > 0;
    const pts = trade.points?.toFixed(1);
    const pnl = Math.abs(trade.pnl).toFixed(2);
    const durSec = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = durSec < 60 ? `${durSec}s` : `${Math.floor(durSec/60)}m ${durSec%60}s`;

    return `POST-TRADE DEBRIEF REQUEST:
Trade: ${won ? 'WIN ✅' : 'LOSS ❌'} | ${trade.direction?.toUpperCase()} | ${trade.size} lots
Entry: $${trade.entry_price} → Exit: $${trade.exit_price}
Points: ${pts} | P&L: ${won ? '+' : '-'}$${pnl} | Hold time: ${durStr}

Current market context:
Price now: $${marketData?.price || 'unknown'}
Current bias: ${marketData?.bias || 'unknown'} (Bull: ${marketData?.bull_votes || 0}/3, Bear: ${marketData?.bear_votes || 0}/3)
EMA trend: ${marketData?.ema_trend || 'unknown'}
Zone active: ${marketData?.zone_active || false}
${marketData?.zone_active ? `Zone: ${marketData.zone_type} | Entry level: ${marketData.zone_mid} | TP: ${marketData.tp_level} | SL: ${marketData.sl_level}` : ''}

Give a brutally honest post-trade debrief as Santosh. Was the entry clean? Did they follow AMN rules? What should they do differently? Keep it to 4-5 sentences max. Be straight with them — no sugarcoating.`;
}

// Store latest market data for post-trade context
let latestMarketData = null;

module.exports = function(app) {

    // POST /analyst — Pine Script webhook
    app.post('/analyst', async (req, res) => {
        try {
            const now = Date.now();
            const data = req.body;

            // Store latest market data
            latestMarketData = data;

            if (now - lastCallTime < RATE_LIMIT_MS) {
                return res.json({ commentary: null, skipped: true });
            }
            lastCallTime = now;

            const prompt = buildAutoPrompt(data);
            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 150,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: prompt }]
            });

            const commentary = response.content[0].text;
            const entry = {
                commentary,
                price: data.price,
                bias: data.bias,
                bull_score: data.bull_votes,
                bear_score: data.bear_votes,
                event_type: data.event_type,
                zone_active: data.zone_active,
                zone_type: data.zone_type,
                zone_mid: data.zone_mid,
                go_long: data.event_type === 'go_long',
                go_short: data.event_type === 'go_short',
                timestamp: data.timestamp || new Date().toISOString()
            };

            addToFeed(entry);
            res.json({ commentary, timestamp: entry.timestamp, success: true });

        } catch (err) {
            console.error('Analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /analyst-feed — polled by chat panel
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

            // Inject current market context into every question
            let userContent = message;
            if (latestMarketData) {
                const d = latestMarketData;
                const zoneStr = d.zone_active ?
                    ` | ${d.zone_type} zone active: entry ${d.zone_mid}, TP ${d.tp_level}, SL ${d.sl_level}` : '';
                userContent = `[Live: $${d.price} | ${d.bias?.toUpperCase()} ${d.bull_votes}/3 bull | EMA ${d.ema_trend} | RSI ${d.rsi}${zoneStr}]\n\n${message}`;
            }

            history.push({ role: 'user', content: userContent });
            while (history.length > MAX_HISTORY * 2) history.shift();

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 250,
                system: SANTOSH_SYSTEM,
                messages: history
            });

            const reply = response.content[0].text;
            history.push({ role: 'assistant', content: reply });

            res.json({ reply, timestamp: new Date().toISOString(), success: true });

        } catch (err) {
            console.error('Chat error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /analyst-debrief/:id — auto post-trade analysis
    app.post('/analyst-debrief/:id', async (req, res) => {
        try {
            const DB = process.env.DB_PATH || path.join(__dirname, 'trades.json');
            const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
            const trade = db.trades.find(t => t.id === parseInt(req.params.id));

            if (!trade) return res.status(404).json({ error: 'Trade not found' });
            if (trade.status !== 'closed') return res.status(400).json({ error: 'Trade not closed yet' });

            const prompt = buildPostTradePrompt(trade, latestMarketData);
            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 300,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: prompt }]
            });

            const debrief = response.content[0].text;

            // Save to trade record
            const idx = db.trades.findIndex(t => t.id === parseInt(req.params.id));
            db.trades[idx].santosh_debrief = debrief;
            db.trades[idx].debrief_time = Date.now();
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            // Add to feed
            addToFeed({
                commentary: `📋 DEBRIEF: ${debrief}`,
                price: latestMarketData?.price,
                event_type: 'debrief',
                timestamp: new Date().toISOString()
            });

            res.json({ debrief, success: true });

        } catch (err) {
            console.error('Debrief error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /analyst-chat — serves the panel
    app.get('/analyst-chat', (req, res) => {
        res.sendFile('analyst.html', { root: './public' });
    });

    console.log('✅ Santosh v2 loaded: /analyst /analyst-feed /analyst-chat /analyst-debrief/:id');
};
