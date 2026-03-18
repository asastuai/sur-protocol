#!/usr/bin/env bash
# SUR Protocol - Railway Deployment Setup
# Run this after creating a Railway project and installing the CLI
#
# Prerequisites:
#   1. npm install -g @railway/cli
#   2. railway login
#   3. railway init (link to your GitHub repo)
#   4. Have OPERATOR_PRIVATE_KEY and BASE_SEPOLIA_RPC ready
#
# Usage:
#   chmod +x deploy/railway-setup.sh
#   ./deploy/railway-setup.sh

set -e

echo "╔════════════════════════════════════════════╗"
echo "║   SUR Protocol - Railway Deployment Setup  ║"
echo "╚════════════════════════════════════════════╝"
echo

# ---- Shared env vars ----
SHARED_VARS=(
  "NETWORK=testnet"
  "RPC_URL=${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
  "VAULT_ADDRESS=0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81"
  "ENGINE_ADDRESS=0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6"
  "SETTLEMENT_ADDRESS=0x7297429477254843cB00A6e17C5B1f83B3AE2Eec"
  "LIQUIDATOR_ADDRESS=0xE748C66Ec162F7C0E56258415632A46b69b48eB1"
  "INSURANCE_FUND_ADDRESS=0x65a5ae9d3C96196522d7AdC3837686BB3c023209"
  "ORACLE_ROUTER_ADDRESS=0xb1A0aC35bcAABd9FFD19b4006a43873663901882"
)

# ---- 1. API Server (HTTP + WebSocket) ----
echo "[1/4] Creating API service..."
railway service create sur-api
railway link --service sur-api

for var in "${SHARED_VARS[@]}"; do
  railway variables set "$var"
done
railway variables set "OPERATOR_PRIVATE_KEY=${OPERATOR_PRIVATE_KEY}"

# Railway auto-detects Dockerfile in api/
echo "  Set root directory to 'api/' in Railway dashboard"
echo "  Set build command: npm run build"
echo "  Set start command: npm start"
echo

# ---- 2. Oracle Keeper (Worker - no port) ----
echo "[2/4] Creating Oracle Keeper service..."
railway service create sur-oracle-keeper
railway link --service sur-oracle-keeper

for var in "${SHARED_VARS[@]}"; do
  railway variables set "$var"
done
railway variables set "KEEPER_PRIVATE_KEY=${OPERATOR_PRIVATE_KEY}"
railway variables set "PUSH_INTERVAL_MS=5000"

echo "  Set root directory to 'oracle-keeper/' in Railway dashboard"
echo "  IMPORTANT: Set as 'Worker' (no health check / no port)"
echo

# ---- 3. Liquidation Keeper (Worker) ----
echo "[3/4] Creating Liquidation Keeper service..."
railway service create sur-liquidation-keeper
railway link --service sur-liquidation-keeper

for var in "${SHARED_VARS[@]}"; do
  railway variables set "$var"
done
railway variables set "KEEPER_PRIVATE_KEY=${OPERATOR_PRIVATE_KEY}"
railway variables set "SCAN_INTERVAL_MS=5000"

echo "  Set root directory to 'keeper/' in Railway dashboard"
echo "  IMPORTANT: Set as 'Worker' (no health check / no port)"
echo

# ---- 4. Funding Bot (Worker) ----
echo "[4/4] Creating Funding Bot service..."
railway service create sur-funding-bot
railway link --service sur-funding-bot

for var in "${SHARED_VARS[@]}"; do
  railway variables set "$var"
done
railway variables set "KEEPER_PRIVATE_KEY=${OPERATOR_PRIVATE_KEY}"
railway variables set "CHECK_INTERVAL_MS=30000"

echo "  Set root directory to 'funding-bot/' in Railway dashboard"
echo "  IMPORTANT: Set as 'Worker' (no health check / no port)"
echo

echo "╔════════════════════════════════════════════╗"
echo "║   Setup Complete!                          ║"
echo "║                                            ║"
echo "║   Next steps:                              ║"
echo "║   1. Set root directories in dashboard     ║"
echo "║   2. railway up  (deploy all services)     ║"
echo "║   3. Copy API URL for frontend             ║"
echo "║   4. Set NEXT_PUBLIC_WS_URL on Vercel      ║"
echo "╚════════════════════════════════════════════╝"
