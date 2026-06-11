# BTC Scalp Trade Dashboard

Live rolling trade journal that auto-populates from TradingView webhook alerts.

---

## Deploy to Render (free)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "BTC trade dashboard"
git remote add origin https://github.com/YOUR_USERNAME/btc-trade-dashboard.git
git push -u origin main
```

### 2. Deploy on Render
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Render auto-detects `render.yaml` — just click **Deploy**
4. Your dashboard URL will be: `https://btc-trade-dashboard.onrender.com`

---

## Set up TradingView Alert

### Alert message format (JSON)
In TradingView, create an alert and set the message body to:

**For a BUY execution:**
```json
{
  "action": "buy",
  "price": {{close}},
  "size": 2,
  "ppp": 1.0,
  "symbol": "BTCUSD"
}
```

**For a SELL execution:**
```json
{
  "action": "sell",
  "price": {{close}},
  "size": 2,
  "ppp": 1.0,
  "symbol": "BTCUSD"
}
```

> Change `size` and `ppp` to match your actual trade. `ppp` = $ per point per lot.
> For BlackBull BTC/USD CFD: ppp is typically $1 per point per lot.

### Webhook URL
Set the Webhook URL in TradingView alert to:
```
https://YOUR-APP.onrender.com/webhook
```

---

## Embed in TradingView

1. In TradingView layout, click **+** → **Add a widget**
2. Select **Web** (or press `W`)
3. Enter your dashboard URL: `https://YOUR-APP.onrender.com`
4. Resize the panel to sit alongside your chart

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Receive TradingView execution alerts |
| `/api/trades` | GET | Get last 8 closed trades + open trade + stats |
| `/api/trade` | POST | Manually add a trade (fallback) |
| `/api/trades` | DELETE | Clear all trade history |
| `/health` | GET | Server health check |

---

## Webhook payload fields

| Field | Required | Description |
|-------|----------|-------------|
| `action` | ✅ | `"buy"` or `"sell"` |
| `price` | ✅ | Execution price |
| `size` | ❌ | Lot size (default: 1.0) |
| `ppp` | ❌ | $ per point per lot (default: 1.0) |
| `symbol` | ❌ | Symbol name (default: "BTCUSD") |

---

## Trade pairing logic

- **Buy** → opens a Long (or closes an open Short)
- **Sell** → opens a Short (or closes an open Long)
- Same direction twice → treated as a scale-in / new position

---

## Local development

```bash
npm install
node server.js
# Dashboard at http://localhost:3000
```
