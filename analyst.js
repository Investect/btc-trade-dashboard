// analyst.js v4 — Santosh human voice
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

const SANTOSH_SYSTEM = `You are Santosh — a mate who happens to be a professional BTC scalp trader with 8 years experience. You're sitting right next to the trader watching the same screen. You trade the AMN strategy together.

AMN RULES YOU KNOW:
- BOS fires → count 4 taps → zone confirmed → enter at 50% midline → minimum 1.1R
- Need 2 of 3 HTF timeframes aligned before any trade (bull_votes or bear_votes >= 2)
- Always wait for a liquidity sweep before entry
- CHoCH means cancel everything and wait for new structure
- Max 3 trades per day, stop after 2 losses no matter what
- Fresh zones only — if 50% midline already crossed, zone is dead

YOUR VOICE — this is critical:
- Talk exactly like a friendly experienced trader mate, casual and real
- Say things like "hey", "yo", "alright", "mate", "look", "right"
- Short sentences. Natural. Like you're talking not writing.
- 2-3 sentences MAX for auto signals. Never longer.
- When a signal fires, tell them WHAT just happened, WHAT it means, and WHAT to do or watch for
- When a trade is open and going well, tell them to manage it — trail the stop, watch volume
- When something looks like it won't reach TP, say so honestly and early
- When to close, say "close it now" or "take that profit"
- When there's no setup, say "nothing doing right now, stay flat"
- Use exact prices when you have them: "midline's at 59,240, that's your entry"
- Never robotic. Never say "As an AI". Never write paragraphs.
- For questions: answer like a mate would. Direct, friendly, 2-3 sentences.

EXAMPLE AUTO COMMENTARIES (match this tone exactly):
"Hey, AMN just fired a bull BOS — bias is 3/3 bull, setup's looking clean. Watch for 4 taps into the zone then get ready."
"Yo, sweep just cleared the sell-side at 59,140. That's the liquidity grab we needed — BOS incoming, stay alert."
"Alright, GO LONG signal confirmed. Zone mid is 59,240, get in there, TP 59,380, SL 59,100. Looks good mate."
"CHoCH just flipped bear — drop everything, all zones cancelled. Wait for new structure before touching anything."
"Hey, you're in profit on that long but volume's dropping off. Start trailing that stop, I wouldn't hold for full TP here."
"Nothing doing right now — bias is mixed, no clean setup. Hands off the keyboard mate."
"Yo, close that trade now — reversal candles forming and volume's fading. Take the profit, don't get greedy."`;

function addToFeed(entry) {
    commentaryFeed.unshift(entry);
    if (commentaryFeed.length > MAX_FEED_SIZE) commentaryFeed.pop();
}

function buildAutoPrompt(d) {
    const evt = d.event_type?.replace(/_/g, ' ').toUpperCase() || 'UPDATE';
    const bias = `${d.bias?.toUpperCase()} — ${d.bull_votes}/3 bull, ${d.bear_votes}/3 bear`;
    const zone = d.zone_active
        ? `Zone confirmed: ${d.zone_type} | Entry at ${d.zone_mid} | TP ${d.tp_level} | SL ${d.sl_level}`
        : 'No confirmed zone yet';
    const extras = [
        d.choch ? `CHoCH ${d.choch_direction} just fired` : null,
        d.sweep_direction && d.sweep_direction !== 'none' ? `${d.sweep_direction} sweep hit` : null,
        d.tap_count > 0 ? `${d.tap_count}/${d.min_taps} taps counted` : null,
    ].filter(Boolean).join(' | ');

    return `Signal: ${evt}
Price: $${d.price} | Bias: ${bias}
EMA trend: ${d.ema_trend} | RSI: ${d.rsi}
${zone}
${extras ? extras : ''}

Respond as Santosh. 2-3 sentences, casual and human, tell them what happened and what to do. Match the example tone exactly.`;
}

function buildPostTradePrompt(trade, market) {
    const won = trade.pnl > 0;
    const dur = Math.round((trade.exit_time - trade.entry_time) / 1000);
    const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur / 60)}m ${dur % 60}s`;
    return `Trade just closed:
${won ? 'WIN ✅' : 'LOSS ❌'} | ${trade.direction} | Entry $${trade.entry_price} → Exit $${trade.exit_price} | ${trade.points?.toFixed(1)} points | P&L ${won ? '+' : ''}$${trade.pnl?.toFixed(2)} | Held ${durStr}
Market now: $${market?.price} | ${market?.bias} ${market?.bull_votes}/3 | EMA ${market?.ema_trend}
${market?.zone_active ? `Zone still active: entry ${market.zone_mid}, TP ${market.tp_level}` : 'No active zone'}

Give a quick honest debrief as Santosh — 2-3 sentences. Was it a good AMN setup? Did they manage it well? What should they take away from it? Keep it real and casual.`;
}

let latestMarketData = null;

module.exports = function(app) {

    app.post('/analyst', async (req, res) => {
        try {
            const now = Date.now();
            const data = req.body;
            latestMarketData = data;

            if (now - lastCallTime < RATE_LIMIT_MS) {
                return res.json({ skipped: true });
            }
            lastCallTime = now;

            const response = await client.messages.create({
                model: 'claude-haiku-4-5',
                max_tokens: 100,
                system: SANTOSH_SYSTEM,
                messages: [{ role: 'user', content: buildAutoPrompt(data) }]
            });

            const commentary = response.content[0].text;
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
                timestamp: data.timestamp || new Date().toISOString()
            });

            res.json({ commentary, success: true });

        } catch (err) {
            console.error('Analyst error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/analyst-feed', (req, res) => {
        res.json({ feed: commentaryFeed });
    });

    app.post('/analyst-chat', async (req, res) => {
        try {
            const { message, sessionId = 'default' } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'No message' });

            if (!conversations[sessionId]) conversations[sessionId] = [];
            const history = conversations[sessionId];

            let userContent = message;
            if (latestMarketData) {
                const d = latestMarketData;
                const z = d.zone_active
                    ? ` | ${d.zone_type} zone active: entry ${d.zone_mid}, TP ${d.tp_level}, SL ${d.sl_level}`
                    : '';
                userContent = `[Chart: $${d.price} | ${d.bias} ${d.bull_votes}/3 bull | EMA ${d.ema_trend} | RSI ${d.rsi}${z}]\n${message}`;
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
                messages: [{ role: 'user', content: buildPostTradePrompt(trade, latestMarketData) }]
            });

            const debrief = response.content[0].text;
            const idx = db.trades.findIndex(t => t.id === parseInt(req.params.id));
            db.trades[idx].santosh_debrief = debrief;
            db.trades[idx].debrief_time = Date.now();
            fs.writeFileSync(DB, JSON.stringify(db, null, 2));

            addToFeed({
                commentary: `📋 ${debrief}`,
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

    app.get('/analyst-chat', (req, res) => {
        res.sendFile('analyst.html', { root: './public' });
    });

    console.log('✅ Santosh v4 loaded');
};
