#!/usr/bin/env bash
# SUR Protocol - Railway Deployment Setup
# Run this after creating a Railway project and installing the CLI
#
# Prerequisites:
#   1. npm install -g @railway/cli
#   2. railway login
#   3. railway init (link to your GitHub repo or deploy from local)
#   4. Have these ready:
#      - OPERATOR_PRIVATE_KEY (API/settlement wallet)
#      - KEEPER_PRIVATE_KEY (oracle/keeper/funding wallet — can be same for testnet)
#      - BASE_SEPOLIA_RPC (Alchemy/Infura RPC URL)
#      - FRONTEND_URL (your Vercel URL, e.g. https://web-orcin-phi-55.vercel.app)
#
# Usage:
#   export OPERATOR_PRIVATE_KEY=0x...
#   export KEEPER_PRIVATE_KEY=0x...
#   export BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
#   export FRONTEND_URL=https://web-orcin-phi-55.vercel.app
#   chmod +x deploy/railway-setup.sh
#   ./deploy/railway-setup.sh

set -e

# ---- Validation ----
if [ -z "$OPERATOR_PRIVATE_KEY" ]; then
  echo "ERROR: OPERATOR_PRIVATE_KEY not set"
  echo "  export OPERATOR_PRIVATE_KEY=0x..."
  exit 1
fi

if [ -z "$KEEPER_PRIVATE_KEY" ]; then
  echo "WARNING: KEEPER_PRIVATE_KEY not set, using OPERATOR_PRIVATE_KEY"
  KEEPER_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY
fi

echo "╔════════════════════════════════════════════╗"
echo "║   SUR Protocol - Railway Deployment Setup  ║"
echo "╚════════════════════════════════════════════╝"
echo

# ---- Contract addresses (Base Sepolia) ----
VAULT_ADDRESS="0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81"
ENGINE_ADDRESS="0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6"
SETTLEMENT_ADDRESS="0x7297429477254843cB00A6e17C5B1f83B3AE2Eec"
LIQUIDATOR_ADDRESS="0xE748C66Ec162F7C0E56258415632A46b69b48eB1"
INSURANCE_FUND_ADDRESS="0x65a5ae9d3C96196522d7AdC3837686BB3c023209"
ORACLE_ROUTER_ADDRESS="0xb1A0aC35bcAABd9FFD19b4006a43873663901882"
RPC_URL="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
CORS="${FRONTEND_URL:-http://localhost:3000},http://localhost:3001"

# ---- Shared env vars ----
SHARED_VARS=(
  "NETWORK=testnet"
  "RPC_URL=$RPC_URL"
  "VAULT_ADDRESS=$VAULT_ADDRESS"
  "ENGINE_ADDRESS=$ENGINE_ADDRESS"
  "SETTLEMENT_ADDRESS=$SETTLEMENT_ADDRESS"
  "LIQUIDATOR_ADDRESS=$LIQUIDATOR_ADDRESS"
  "INSURANCE_FUND_ADDRESS=$INSURANCE_FUND_ADDRESS"
  "ORACLE_ROUTER_ADDRESS=$ORACLE_ROUTER_ADDRESS"
)

set_shared_vars() {
  for var in "${SHARED_VARS[@]}"; do
    railway variables set "$var"
  done
}

# ═══════════════════════════════════════════════
# 1. API Server (HTTP + WebSocket)
# ═══════════════════════════════════════════════
echo "[1/4] Creating API service..."
railway service create sur-api
railway link --service sur-api

set_shared_vars
railway variables set "OPERATOR_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY"
railway variables set "CORS_ORIGINS=$CORS"
railway variables set "MAX_WS_CONNECTIONS=200"
railway variables set "MAX_MESSAGES_PER_SEC=10"

echo "  ✓ API service created"
echo "  → In Railway dashboard:"
echo "    - Root directory: api/"
echo "    - Builder: Dockerfile"
echo "    - Port: auto-detected from \$PORT"
echo

# ═══════════════════════════════════════════════
# 2. Oracle Keeper (Worker - no port needed)
# ═══════════════════════════════════════════════
echo "[2/4] Creating Oracle Keeper service..."
railway service create sur-oracle-keeper
railway link --service sur-oracle-keeper

set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY"
railway variables set "PUSH_INTERVAL_MS=5000"
railway variables set "MAX_GAS_PRICE_GWEI=50"
railway variables set "HEALTH_PORT=3011"

echo "  ✓ Oracle Keeper created"
echo "  → Root directory: oracle-keeper/"
echo

# ═══════════════════════════════════════════════
# 3. Liquidation Keeper (Worker)
# ═══════════════════════════════════════════════
echo "[3/4] Creating Liquidation Keeper service..."
railway service create sur-liquidation-keeper
railway link --service sur-liquidation-keeper

set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY"
railway variables set "SCAN_INTERVAL_MS=5000"
railway variables set "MARKETS=BTC-USD,ETH-USD"
railway variables set "HEALTH_PORT=3010"

echo "  ✓ Liquidation Keeper created"
echo "  → Root directory: keeper/"
echo

# ═══════════════════════════════════════════════
# 4. Funding Bot (Worker)
# ═══════════════════════════════════════════════
echo "[4/4] Creating Funding Bot service..."
railway service create sur-funding-bot
railway link --service sur-funding-bot

set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY"
railway variables set "CHECK_INTERVAL_MS=30000"
railway variables set "MARKETS=BTC-USD,ETH-USD"
railway variables set "HEALTH_PORT=3012"

echo "  ✓ Funding Bot created"
echo "  → Root directory: funding-bot/"
echo

# ═══════════════════════════════════════════════
echo
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║   All 4 Services Created!                                ║"
echo "║                                                          ║"
echo "║   Next steps:                                            ║"
echo "║                                                          ║"
echo "║   1. In Railway dashboard, set root directory for each:  ║"
echo "║      • sur-api → api/                                    ║"
echo "║      • sur-oracle-keeper → oracle-keeper/                ║"
echo "║      • sur-liquidation-keeper → keeper/                  ║"
echo "║      • sur-funding-bot → funding-bot/                    ║"
echo "║                                                          ║"
echo "║   2. Deploy:                                             ║"
echo "║      railway up (for each service)                       ║"
echo "║                                                          ║"
echo "║   3. Copy the API public URL from Railway dashboard      ║"
echo "║                                                          ║"
echo "║   4. In Vercel, set environment variable:                ║"
echo "║      NEXT_PUBLIC_WS_URL=wss://<your-api-url>             ║"
echo "║                                                          ║"
echo "║   5. Redeploy frontend on Vercel                         ║"
echo "║                                                          ║"
echo "║   6. Verify:                                             ║"
echo "║      curl https://<api-url>/health                       ║"
echo "╚═══════════════════════════════════════════════════════════╝"
