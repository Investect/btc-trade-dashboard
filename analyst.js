// analyst.js — Santosh Live Trading Analyst
// Add to your existing server.js: require('./analyst')(app);

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Rate limiting — max 1 Haiku call per 8 seconds
let lastCallTime = 0;
const RATE_LIMIT_MS = 8000;

// Store last 30 auto-commentary entries for the feed
const commentaryFeed = [];
const MAX_FEED_SIZE = 30;

// Conversation history per session (keyed by sessionId)
const conversations = {};
const MAX_HISTORY = 10; // keep last 10 exchanges per session

const SANTOSH_SYSTEM_PROMPT = `You are Santosh — a professional BTC/USD scalp trader with 8 years experience. You're sitting next to the trader right now, watching the same chart. You trade the AMN Strategy by Adz Trading (Adeel/amntrading1).

AMN STRATEGY RULES YOU KNOW COLD:
- BOS (Break of Structure) detected → start counting taps (max 4 on 15s timeframe)
- Zone draws after 4 taps → enter at 50% midline of zone
- Minimum 1.1R target, never less
- Max 3 trades per day. Stop after 2 losses — no exceptions
- HTF bias: need 2 of 3 timeframes (1m/5m/15m) aligned before entry
- EMA 9/20 — only trade in direction of trend
- Wait for liquidity sweep BEFORE entry — no sweep, no trade
- CHoCH (Change of Character) cancels all pending zones immediately
- Fresh zones only — if 50% midline already crossed, zone is dead
- 15 second execution timeframe

YOUR PERSONALITY:
- You ARE Santosh. Never break character. Never say "As an AI"
- Talk like a real trader sitting next to someone — direct, sharp, human
- Short sentences. No essays. Max 3-4 sentences for auto commentary
- Volunteer observations when you see something — don't wait to be asked
- Be honest — tell them to stay out when setup isn't clean
- Use trader language naturally: "that sweep just cleared", "zone's fresh", "bias flipped", "don't chase this"
- Never hedge every sentence or be overly cautious
- When asked questions — answer directly, plainly, no jargon walls
- Occasional personality: "that wick was dirty", "classic stop hunt", "beautiful BOS"

SIGNAL INTERPRETATION:
- bull_score/bear_score out of 5 — above 3 is meaningful
- bos_direction: bull or bear — confirms structure
- sweep_direction: buy_side or sell_side — liquidity grab
- tap_count: 1-4, zone confirms at 4
- choch: true = cancel everything, wait for new structure
- ema_trend: up/down/flat
- rsi: oversold <30, overbought >70`;

function addToFeed(entry) {
  commentaryFeed.unshift(entry);
  if (commentaryFeed.length > MAX_FEED_SIZE) {
    commentaryFeed.pop();
  }
}

function buildAutoPrompt(data) {
  const {
    price, bias, bull_score, bear_score,
    bos_direction, sweep_direction, tap_count,
    rsi, ema_trend, choch, timestamp, event_type
  } = data;

  const eventDescriptions = {
    bull_bos: 'Bullish BOS just printed',
    bear_bos: 'Bearish BOS just printed',
    choch_bull: 'CHoCH flipped bullish',
    choch_bear: 'CHoCH flipped bearish',
    b_sweep: 'Buy-side liquidity sweep hit',
    s_sweep: 'Sell-side liquidity sweep hit',
    go_long: 'LONG signal triggered',
    go_short: 'SHORT signal triggered',
    zone_confirmed: 'Zone confirmed at 4 taps',
    periodic: 'Periodic market check'
  };

  const eventDesc = eventDescriptions[event_type] || 'Market update';

  return `EVENT: ${eventDesc}
Price: $${price}
Bias: ${bias} | Bull Score: ${bull_score}/5 | Bear Score: ${bear_score}/5
BOS: ${bos_direction || 'none'} | Sweep: ${sweep_direction || 'none'}
Tap Count: ${tap_count}/4 | CHoCH: ${choch ? 'YES - CANCEL ZONES' : 'No'}
EMA Trend: ${ema_trend} | RSI: ${rsi}

Give your live commentary on this as Santosh. Be direct. Max 3-4 sentences.`;
}

module.exports = function(app) {

  // POST /analyst — receives Pine Script webhook
  app.post('/analyst', async (req, res) => {
    try {
      const now = Date.now();
      const data = req.body;

      // Rate limit check
      if (now - lastCallTime < RATE_LIMIT_MS) {
        return res.json({
          commentary: null,
          skipped: true,
          reason: 'rate_limited'
        });
      }

      lastCallTime = now;

      const prompt = buildAutoPrompt(data);

      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        system: SANTOSH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      });

      const commentary = response.content[0].text;
      const entry = {
        commentary,
        price: data.price,
        bias: data.bias,
        bull_score: data.bull_score,
        bear_score: data.bear_score,
        event_type: data.event_type,
        timestamp: data.timestamp || new Date().toISOString()
      };

      addToFeed(entry);

      res.json({ commentary, timestamp: entry.timestamp, success: true });

    } catch (err) {
      console.error('Analyst error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /analyst-feed — polled every 3s by the chat panel
  app.get('/analyst-feed', (req, res) => {
    res.json({ feed: commentaryFeed });
  });

  // POST /analyst-chat — user asks Santosh a question
  app.post('/analyst-chat', async (req, res) => {
    try {
      const { message, sessionId = 'default', marketContext } = req.body;

      if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'No message provided' });
      }

      // Get or create conversation history
      if (!conversations[sessionId]) {
        conversations[sessionId] = [];
      }
      const history = conversations[sessionId];

      // Build context-aware user message
      let userContent = message;
      if (marketContext) {
        userContent = `[Market context: Price $${marketContext.price}, Bias: ${marketContext.bias}, Bull: ${marketContext.bull_score}/5, Bear: ${marketContext.bear_score}/5]\n\nQuestion: ${message}`;
      }

      // Add to history
      history.push({ role: 'user', content: userContent });

      // Trim history to last MAX_HISTORY exchanges
      while (history.length > MAX_HISTORY * 2) {
        history.shift();
      }

      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 250,
        system: SANTOSH_SYSTEM_PROMPT,
        messages: history
      });

      const reply = response.content[0].text;

      // Add assistant reply to history
      history.push({ role: 'assistant', content: reply });

      res.json({ reply, timestamp: new Date().toISOString(), success: true });

    } catch (err) {
      console.error('Chat error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /analyst-chat — serves the chat panel HTML
  app.get('/analyst-chat', (req, res) => {
    res.sendFile('analyst.html', { root: './public' });
  });

  console.log('✅ Santosh analyst endpoints loaded: /analyst, /analyst-feed, /analyst-chat');
};
