# SUR Protocol - Backend Deployment Guide

## Architecture

```
┌──────────────────────────────────┐
│  Vercel (Frontend)               │
│  web-orcin-phi-55.vercel.app     │
│  Next.js 14 + Paper Trading      │
└─────────────┬────────────────────┘
              │ wss://
┌─────────────▼────────────────────┐
│  Railway: sur-api                │
│  HTTP health + WebSocket         │──→ Supabase (PostgreSQL)
│  Order Matching + Settlement     │    Trade history, leaderboard
└─────────────┬────────────────────┘
              │ Base Sepolia RPC
┌─────────────▼────────────────────┐
│  Smart Contracts (Base Sepolia)  │
│  PerpVault · PerpEngine          │
│  OrderSettlement · Liquidator    │
│  InsuranceFund · OracleRouter    │
└─────────────▲────────────────────┘
              │
┌─────────────┴────────────────────┐
│  Railway Workers:                │
│  • Oracle Keeper  (every 5s)     │
│  • Liquidation Bot (every 5s)    │
│  • Funding Bot    (every 30s)    │
└──────────────────────────────────┘
```

## Prerequisites

1. **Wallets** (already generated — see `security/NEW_WALLETS_2026-03-19.md`):
   - Operator wallet → signs settlements (API service)
   - Keeper wallet → signs oracle pushes, liquidations, funding (3 worker services)
2. **Fund keeper wallet**: ~0.05 Base Sepolia ETH from https://www.alchemy.com/faucets/base-sepolia
3. **Railway account**: https://railway.app ($5/mo hobby plan)
4. **RPC URL**: Get from Alchemy (free) → https://dashboard.alchemy.com → Create App → Base Sepolia

## Quick Deploy (Automated)

```bash
# 1. Install Railway CLI
npm install -g @railway/cli
railway login

# 2. Navigate to project root
cd sur-protocol

# 3. Create Railway project
railway init

# 4. Set your secrets and run the setup script
export OPERATOR_PRIVATE_KEY=0x...your_operator_key...
export KEEPER_PRIVATE_KEY=0x...your_keeper_key...
export BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
export FRONTEND_URL=https://web-orcin-phi-55.vercel.app

chmod +x deploy/railway-setup.sh
./deploy/railway-setup.sh

# 5. In Railway dashboard, set root directories:
#    sur-api → api/
#    sur-oracle-keeper → oracle-keeper/
#    sur-liquidation-keeper → keeper/
#    sur-funding-bot → funding-bot/

# 6. Deploy each service
railway link --service sur-api && railway up
railway link --service sur-oracle-keeper && railway up
railway link --service sur-liquidation-keeper && railway up
railway link --service sur-funding-bot && railway up
```

## Manual Deploy (Step by Step)

### Step 1: Deploy API Server

```bash
railway service create sur-api
railway link --service sur-api

# Required env vars
railway variables set NETWORK=testnet
railway variables set RPC_URL=<your-alchemy-rpc>
railway variables set OPERATOR_PRIVATE_KEY=<your-operator-key>
railway variables set VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
railway variables set ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
railway variables set SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
railway variables set LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
railway variables set INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
railway variables set ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882
railway variables set CORS_ORIGINS=https://web-orcin-phi-55.vercel.app,http://localhost:3000

# In Railway dashboard: root directory → api/
railway up
```

**Verify:** `curl https://<your-railway-url>/health`

### Step 2: Update Frontend (Vercel)

In Vercel dashboard → Settings → Environment Variables:
- `NEXT_PUBLIC_WS_URL` = `wss://<your-railway-api-url>`

Redeploy the frontend.

### Step 3: Deploy Oracle Keeper

```bash
railway service create sur-oracle-keeper
railway link --service sur-oracle-keeper

# Same contract addresses as API, plus:
railway variables set KEEPER_PRIVATE_KEY=<your-keeper-key>
railway variables set PUSH_INTERVAL_MS=5000
railway variables set MAX_GAS_PRICE_GWEI=50
railway variables set HEALTH_PORT=3011

# Root directory → oracle-keeper/
railway up
```

### Step 4: Deploy Liquidation Keeper

```bash
railway service create sur-liquidation-keeper
railway link --service sur-liquidation-keeper

railway variables set KEEPER_PRIVATE_KEY=<your-keeper-key>
railway variables set SCAN_INTERVAL_MS=5000
railway variables set MARKETS=BTC-USD,ETH-USD
railway variables set HEALTH_PORT=3010

# Root directory → keeper/
railway up
```

### Step 5: Deploy Funding Bot

```bash
railway service create sur-funding-bot
railway link --service sur-funding-bot

railway variables set KEEPER_PRIVATE_KEY=<your-keeper-key>
railway variables set CHECK_INTERVAL_MS=30000
railway variables set MARKETS=BTC-USD,ETH-USD
railway variables set HEALTH_PORT=3012

# Root directory → funding-bot/
railway up
```

### Step 6: Set Up Supabase (Optional)

Supabase stores trade history and leaderboard data. The protocol works without it.

1. Create project at https://supabase.com (free tier)
2. Go to SQL Editor → paste `api/src/db/schema.sql` → Run
3. Add to Railway API service:
   ```bash
   railway link --service sur-api
   railway variables set SUPABASE_URL=https://xxxxx.supabase.co
   railway variables set SUPABASE_SERVICE_KEY=eyJhbG...
   ```

## Environment Variables Reference

### API Service (sur-api)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPERATOR_PRIVATE_KEY` | Yes | — | Wallet that signs settlement TXs |
| `RPC_URL` | No | sepolia.base.org | Primary RPC endpoint |
| `RPC_URLS_FALLBACK` | No | — | Comma-separated backup RPCs |
| `PORT` | No | 3002 | HTTP+WS port (Railway sets this) |
| `CORS_ORIGINS` | No | localhost | Comma-separated allowed origins |
| `MAX_WS_CONNECTIONS` | No | 200 | Max concurrent WebSocket clients |
| `MAX_MESSAGES_PER_SEC` | No | 10 | Rate limit per client |
| `BATCH_INTERVAL_MS` | No | 2000 | Settlement batch interval |
| `SUPABASE_URL` | No | — | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | No | — | Supabase service role key |

### Worker Services (oracle-keeper, keeper, funding-bot)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KEEPER_PRIVATE_KEY` | Yes | — | Wallet for keeper transactions |
| `RPC_URL` | No | sepolia.base.org | Primary RPC endpoint |
| `RPC_URLS_FALLBACK` | No | — | Comma-separated backup RPCs |
| `PUSH_INTERVAL_MS` | No | 5000 | Oracle push interval |
| `SCAN_INTERVAL_MS` | No | 5000 | Liquidation scan interval |
| `CHECK_INTERVAL_MS` | No | 30000 | Funding check interval |
| `MAX_GAS_PRICE_GWEI` | No | 50 | Max gas price for oracle pushes |
| `MARKETS` | No | BTC-USD,ETH-USD | Markets to monitor |
| `HEALTH_PORT` | No | 3010-3012 | Health check HTTP port |

### Contract Addresses (Base Sepolia)

```
VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882
```

## Cost Estimate

| Service | Provider | Cost |
|---------|----------|------|
| Frontend | Vercel Free | $0 |
| API + 3 workers | Railway Hobby | ~$5/mo |
| Database | Supabase Free | $0 |
| RPC | Alchemy Free Tier | $0 |
| **Total** | | **~$5/mo** |

## Verification Checklist

After deployment, verify everything works:

- [ ] `curl https://<api-url>/health` → returns `{"status":"ok"}`
- [ ] `curl https://<api-url>/metrics` → returns Prometheus metrics
- [ ] Frontend at Vercel URL → WebSocket status shows "Connected"
- [ ] Oracle: check OracleRouter on [BaseScan](https://sepolia.basescan.org/address/0xb1A0aC35bcAABd9FFD19b4006a43873663901882) → prices updating every 5s
- [ ] Railway logs: `railway logs --service sur-oracle-keeper` → "Price pushed" messages
- [ ] Railway logs: `railway logs --service sur-liquidation-keeper` → "Scan complete" messages
- [ ] Railway logs: `railway logs --service sur-funding-bot` → "Funding check" messages
- [ ] Test: submit a trade on the frontend → verify it appears in settlement pipeline

## Troubleshooting

### API not starting
```bash
railway logs --service sur-api --tail 50
# Common issues: missing env vars, invalid private key format
```

### Oracle not pushing prices
```bash
# Check Pyth Hermes is reachable
curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
# Check keeper wallet has ETH for gas
cast balance <KEEPER_ADDRESS> --rpc-url https://sepolia.base.org
```

### WebSocket not connecting from frontend
1. Check CORS_ORIGINS includes your Vercel URL
2. Check NEXT_PUBLIC_WS_URL starts with `wss://` (not `ws://`)
3. Check Railway service has a public domain enabled

### Service crashing in a loop
```bash
railway logs --service <name> --tail 100
# Usually: missing private key, wrong contract address, or out of gas
```
