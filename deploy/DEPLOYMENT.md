# SUR Protocol - Backend Deployment Guide

## Quick Start

### Prerequisites
1. **Operator wallet**: Generate a fresh EOA (`cast wallet new`)
2. **Fund it**: ~0.05 Base Sepolia ETH from https://www.alchemy.com/faucets/base-sepolia
3. **Railway account**: https://railway.app ($5/mo hobby plan)
4. **Supabase project**: https://supabase.com (free tier)

### Step 1: Deploy API Server to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login

# Create project
cd sur-protocol
railway init

# Create API service
railway service create sur-api
railway link --service sur-api

# Set environment variables
railway variables set NETWORK=testnet
railway variables set RPC_URL=<your-alchemy-rpc-url>
railway variables set OPERATOR_PRIVATE_KEY=<your-operator-key>
railway variables set VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
railway variables set ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
railway variables set SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
railway variables set LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
railway variables set INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
railway variables set ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882

# In Railway dashboard: set root directory to "api/"
# Deploy
railway up
```

**Verify:** `curl https://<your-railway-url>/health`

### Step 2: Update Frontend on Vercel

In Vercel dashboard → Settings → Environment Variables:
- `NEXT_PUBLIC_WS_URL` = `wss://<your-railway-url>`

Redeploy the frontend.

### Step 3: Deploy Oracle Keeper

```bash
railway service create sur-oracle-keeper
railway link --service sur-oracle-keeper
# Set same env vars as API + KEEPER_PRIVATE_KEY
# In dashboard: set root directory to "oracle-keeper/"
# IMPORTANT: Set as Worker (no port/health check)
railway up
```

### Step 4: Deploy Liquidation Keeper

```bash
railway service create sur-liquidation-keeper
railway link --service sur-liquidation-keeper
# Set same env vars + KEEPER_PRIVATE_KEY
# Root directory: "keeper/"
# Set as Worker
railway up
```

### Step 5: Deploy Funding Bot

```bash
railway service create sur-funding-bot
railway link --service sur-funding-bot
# Set same env vars + KEEPER_PRIVATE_KEY
# Root directory: "funding-bot/"
# Set as Worker
railway up
```

### Step 6: Set Up Supabase

1. Create project at supabase.com
2. Go to SQL Editor
3. Paste contents of `api/src/db/schema.sql`
4. Run it
5. Copy the project URL and service key
6. Add to Railway API service:
   ```bash
   railway link --service sur-api
   railway variables set SUPABASE_URL=<your-supabase-url>
   railway variables set SUPABASE_SERVICE_KEY=<your-service-key>
   ```

## Architecture

```
┌─────────────────────────┐
│  Vercel (Frontend)      │
│  sur-protocol.vercel.app│
└────────┬────────────────┘
         │ wss://
┌────────▼────────────────┐
│  Railway: sur-api       │
│  HTTP health + WS       │──→ Supabase (PostgreSQL)
│  Matching + Settlement  │
└────────┬────────────────┘
         │ Base Sepolia RPC
┌────────▼────────────────┐
│  Smart Contracts        │
│  PerpEngine, Vault, etc │
└────────▲────────────────┘
         │
┌────────┴────────────────┐
│  Railway Workers:       │
│  • Oracle Keeper (5s)   │
│  • Liquidation Bot (5s) │
│  • Funding Bot (30s)    │
└─────────────────────────┘
```

## Cost Estimate

| Service | Provider | Cost |
|---------|----------|------|
| Frontend | Vercel | Free |
| API + 3 workers | Railway Hobby | ~$5/mo |
| PostgreSQL | Supabase Free | $0 |
| **Total** | | **~$5/mo** |

## Verification Checklist

- [ ] `curl https://<api-url>/health` returns 200
- [ ] Frontend shows "Connected" status
- [ ] Oracle prices updating on BaseScan (OracleRouter contract)
- [ ] Test trade submits and settles on-chain
- [ ] Supabase trades table populating
