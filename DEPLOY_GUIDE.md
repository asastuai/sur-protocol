# SUR Protocol — Deploy Guide

## Architecture

```
                    Internet
                       |
        +--------------+--------------+
        |              |              |
   [Vercel]      [Railway]      [Base Sepolia]
   Frontend      4 services      Smart Contracts
        |              |              |
        |    +---------+--------+     |
        |    |    |    |    |   |     |
        |   API  Oracle Keeper Funding|
        |   +WS  Keeper  Bot   Bot   |
        |    |         |    |   |     |
        +----+---------+----+---+-----+
                       |
                  Pyth Hermes
                  (price feed)
```

---

## Phase 0: Prerequisites

### 0.1 — Create Operator Wallet

You need a fresh EOA wallet that will sign all keeper transactions.

**Option A: Using cast (if you have Foundry)**
```bash
cast wallet new
```

**Option B: Using Node.js**
```bash
node -e "const w = require('crypto').randomBytes(32).toString('hex'); console.log('Private Key: 0x' + w); const { privateKeyToAccount } = require('viem/accounts'); console.log('Address:', privateKeyToAccount('0x' + w).address)"
```

**Option C: MetaMask**
1. Create new account in MetaMask
2. Export private key (Account Details > Export Private Key)

Save the private key somewhere secure. You'll use it as `OPERATOR_PRIVATE_KEY` and `KEEPER_PRIVATE_KEY`.

### 0.2 — Fund Wallet with Base Sepolia ETH

Go to: https://www.alchemy.com/faucets/base-sepolia

Paste your operator address, request 0.05 ETH.

Alternative faucets:
- https://www.coinbase.com/faucets/base-ethereum-sepolia
- https://faucet.quicknode.com/base/sepolia

### 0.3 — Get an RPC URL

Go to: https://www.alchemy.com
1. Sign up (free)
2. Create App > Chain: Base Sepolia
3. Copy the HTTPS URL

It looks like: `https://base-sepolia.g.alchemy.com/v2/abc123xyz`

### 0.4 — Create Railway Account

Go to: https://railway.app
1. Sign in with GitHub
2. Hobby Plan ($5/mo) — needed for persistent services

### 0.5 — Gather Contract Addresses

These are already deployed on Base Sepolia (from deploy/addresses.json):

```
VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882
```

### 0.6 — Checklist Before Starting

- [ ] Operator private key saved
- [ ] Wallet funded with ~0.05 Base Sepolia ETH
- [ ] Alchemy RPC URL ready
- [ ] Railway account created
- [ ] Contract addresses noted above

---

## Phase 1: Push Code to GitHub

Railway deploys from GitHub. If the code isn't there yet:

```bash
cd /path/to/sur-protocol
git init
git add -A
git commit -m "SUR Protocol — full codebase"
git remote add origin https://github.com/YOUR_USER/sur-protocol.git
git push -u origin main
```

If you prefer not to use GitHub, Railway also supports:
- Direct Docker deploy
- Railway CLI (`railway up`)

---

## Phase 2: Deploy API + WebSocket Server

This is the main service. It runs the HTTP health check, WebSocket server, matching engine, and settlement pipeline.

### 2.1 — Create Service on Railway

1. Go to https://railway.app/new
2. Click "Deploy from GitHub repo"
3. Select your `sur-protocol` repository
4. Railway will detect the repo

### 2.2 — Configure the Service

In Railway dashboard for this service:

**Settings tab:**
- Service Name: `sur-api`
- Root Directory: `api`
- Build Command: `npm run build`
- Start Command: `npm start`

**Variables tab — add ALL of these:**

```
PORT=3002
NETWORK=testnet
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
OPERATOR_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882
BATCH_INTERVAL_MS=2000
MAX_BATCH_SIZE=50
```

**Networking tab:**
- Generate Domain (Railway gives you `something.up.railway.app`)
- Or set custom domain if you have one

### 2.3 — Deploy

Click "Deploy". Watch the logs. You should see:

```
╔════════════════════════════════════════════╗
║       SUR Protocol - Backend API           ║
╚════════════════════════════════════════════╝
[Config] Network: Base Sepolia
[Config] Markets: BTC-USD, ETH-USD
[Settlement] Pipeline started
  HTTP + WebSocket: port 3002
  Status: RUNNING
```

### 2.4 — Verify

```bash
curl https://YOUR_SERVICE.up.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "sur-api",
  "version": "0.1.0",
  "uptime": 42,
  "network": "Base Sepolia",
  "connections": 0,
  "markets": 2
}
```

Save the URL — you'll need it for the frontend.

---

## Phase 3: Deploy Oracle Keeper

This pushes Pyth prices on-chain every 5 seconds. Without it, the protocol is frozen.

### 3.1 — Create Worker Service

In the same Railway project:
1. Click "New" > "Service" > "GitHub Repo" (same repo)
2. Configure:

**Settings:**
- Service Name: `oracle-keeper`
- Root Directory: `oracle-keeper`
- Build Command: `npm run build`
- Start Command: `npm start`

**Variables:**
```
NETWORK=testnet
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
KEEPER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882
PUSH_INTERVAL_MS=5000
MAX_GAS_PRICE_GWEI=50
MIN_BALANCE_ETH=0.005
```

**Networking:**
- No port needed (this is a worker, not a web service)
- In Settings, you may need to remove the auto-generated port

### 3.2 — Verify in Logs

You should see:
```
[Push #1] BTC-USD: $84,521.30 | ETH-USD: $1,923.45 | gas: 0.0001 ETH
[Push #2] BTC-USD: $84,519.80 | ETH-USD: $1,923.12 | gas: 0.0001 ETH
```

If you see "Sim skipped" — that's normal, it means the price hasn't changed enough to warrant an on-chain update.

### 3.3 — Verify On-Chain

Go to BaseScan (Sepolia):
```
https://sepolia.basescan.org/address/0xb1A0aC35bcAABd9FFD19b4006a43873663901882
```

You should see `pushPriceBatchWithPyth` transactions from your keeper address.

---

## Phase 4: Deploy Liquidation Keeper

Scans positions and liquidates undercollateralized ones.

### 4.1 — Create Worker Service

**Settings:**
- Service Name: `liquidation-keeper`
- Root Directory: `keeper`
- Build Command: `npm run build`
- Start Command: `npm start`

**Variables:**
```
NETWORK=testnet
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
KEEPER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
SCAN_INTERVAL_MS=5000
MARKETS=BTC-USD,ETH-USD
```

### 4.2 — Verify

Logs should show:
```
KEEPER BOT RUNNING
  Monitoring 0 positions
  Scanning every 5s
```

It'll be idle until there are open positions to monitor.

---

## Phase 5: Deploy Funding Bot

Applies funding rates every 8 hours.

### 5.1 — Create Worker Service

**Settings:**
- Service Name: `funding-bot`
- Root Directory: `funding-bot`
- Build Command: `npm run build`
- Start Command: `npm start`

**Variables:**
```
NETWORK=testnet
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
KEEPER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
MARKETS=BTC-USD,ETH-USD
CHECK_INTERVAL_MS=30000
```

### 5.2 — Verify

Logs should show funding status and "Next funding in Xm".

---

## Phase 6: Connect Frontend to Live Backend

### 6.1 — Update Vercel Environment

Go to https://vercel.com > your SUR Protocol project > Settings > Environment Variables

Add:
```
NEXT_PUBLIC_WS_URL=wss://YOUR_SERVICE.up.railway.app
```

Replace `YOUR_SERVICE.up.railway.app` with the actual Railway URL from Phase 2.

### 6.2 — Redeploy

In Vercel, go to Deployments > click "Redeploy" on the latest deployment.

### 6.3 — Verify

1. Open https://sur-protocol.vercel.app
2. Open browser DevTools > Console
3. You should see the WebSocket connection succeed
4. Prices should be live (from Pyth via oracle keeper)

---

## Phase 7: Supabase (Optional — Data Persistence)

This adds trade history and leaderboard persistence. The API works without it.

### 7.1 — Create Supabase Project

1. Go to https://supabase.com > New Project
2. Region: us-east-1 (or closest to Railway)
3. Save the project URL and service key

### 7.2 — Create Tables

Go to SQL Editor in Supabase and run:

```sql
-- Trades history
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  side TEXT NOT NULL,
  maker_order_id TEXT,
  taker_order_id TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Positions (synced from chain)
CREATE TABLE positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  size NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  margin NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Leaderboard
CREATE TABLE leaderboard (
  trader TEXT PRIMARY KEY,
  total_pnl NUMERIC DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  trade_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Leaderboard update function
CREATE OR REPLACE FUNCTION update_leaderboard(
  p_trader TEXT,
  p_pnl NUMERIC,
  p_volume NUMERIC
) RETURNS VOID AS $$
BEGIN
  INSERT INTO leaderboard (trader, total_pnl, total_volume, trade_count, updated_at)
  VALUES (p_trader, p_pnl, p_volume, 1, now())
  ON CONFLICT (trader) DO UPDATE SET
    total_pnl = leaderboard.total_pnl + p_pnl,
    total_volume = leaderboard.total_volume + p_volume,
    trade_count = leaderboard.trade_count + 1,
    updated_at = now();
END;
$$ LANGUAGE plpgsql;
```

### 7.3 — Add Variables to API Service

In Railway, update `sur-api` service variables:

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...
```

Redeploy the API service.

---

## Troubleshooting

### API won't start
- Check logs in Railway dashboard
- Verify `OPERATOR_PRIVATE_KEY` starts with `0x`
- Verify all contract addresses are correct

### Oracle keeper: "Sim skipped"
- Normal — means price hasn't changed enough for an on-chain update
- Actual pushes happen when price moves significantly

### "insufficient funds for gas"
- Your operator wallet needs more Base Sepolia ETH
- Request from faucet again

### WebSocket won't connect from frontend
- Verify the URL is `wss://` (not `ws://`) — Railway uses HTTPS
- Check CORS — the API already sets `Access-Control-Allow-Origin: *`
- Check browser console for specific error

### Settlement failures
- Check that contracts are actually deployed at those addresses
- Verify on BaseScan: https://sepolia.basescan.org/address/ADDRESS

### Railway builds fail
- Check that `package.json` has all dependencies
- Check `tsconfig.json` compiles cleanly: `cd api && npm run build`

---

## Cost Summary

| Service          | Provider | Monthly Cost |
|------------------|----------|-------------|
| Frontend         | Vercel   | $0 (free)   |
| API + WS         | Railway  | ~$2         |
| Oracle Keeper    | Railway  | ~$1         |
| Liquidation Bot  | Railway  | ~$1         |
| Funding Bot      | Railway  | ~$0.50      |
| Database         | Supabase | $0 (free)   |
| Gas (testnet)    | Faucet   | $0          |
| **Total**        |          | **~$5/mo**  |

---

## Verification Checklist

After each phase, verify:

- [ ] **Phase 2**: `curl https://YOUR_API.up.railway.app/health` returns 200
- [ ] **Phase 3**: Oracle keeper logs show price pushes; BaseScan shows txs
- [ ] **Phase 4**: Keeper logs show "RUNNING" and scan count increasing
- [ ] **Phase 5**: Funding bot logs show rate monitoring
- [ ] **Phase 6**: Frontend connects to WebSocket (check DevTools console)
- [ ] **Phase 7**: Submit a test trade > check Supabase `trades` table

---

## Quick Reference — All Environment Variables

```bash
# Shared across all services
NETWORK=testnet
RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY

# Wallet (can be same key for all or separate)
OPERATOR_PRIVATE_KEY=0x...   # for API settlement
KEEPER_PRIVATE_KEY=0x...     # for oracle/keeper/funding

# Contract addresses (Base Sepolia)
VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81
ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6
SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec
LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1
INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209
ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882

# API specific
PORT=3002
BATCH_INTERVAL_MS=2000
MAX_BATCH_SIZE=50

# Oracle specific
PUSH_INTERVAL_MS=5000

# Keeper specific
SCAN_INTERVAL_MS=5000
MARKETS=BTC-USD,ETH-USD

# Funding specific
CHECK_INTERVAL_MS=30000

# Supabase (optional)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Frontend (Vercel)
NEXT_PUBLIC_WS_URL=wss://YOUR_API.up.railway.app
```
