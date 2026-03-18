#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}[Step $1]${NC} $2"; }
ok()   { echo -e "  ${GREEN}OK${NC} $1"; }
warn() { echo -e "  ${YELLOW}!!${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; exit 1; }

VAULT_ADDRESS="0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81"
ENGINE_ADDRESS="0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6"
SETTLEMENT_ADDRESS="0x7297429477254843cB00A6e17C5B1f83B3AE2Eec"
LIQUIDATOR_ADDRESS="0xE748C66Ec162F7C0E56258415632A46b69b48eB1"
INSURANCE_FUND_ADDRESS="0x65a5ae9d3C96196522d7AdC3837686BB3c023209"
ORACLE_ROUTER_ADDRESS="0xb1A0aC35bcAABd9FFD19b4006a43873663901882"

echo ""
echo "  SUR Protocol - Full Backend Deployment"
echo ""

step "0" "Validating prerequisites..."

[[ -z "${OPERATOR_PRIVATE_KEY:-}" ]] && fail "OPERATOR_PRIVATE_KEY not set"
[[ -z "${BASE_SEPOLIA_RPC:-}" ]] && fail "BASE_SEPOLIA_RPC not set"
ok "Environment variables present"

command -v railway &>/dev/null || fail "railway CLI not installed (npm i -g @railway/cli)"
command -v node &>/dev/null    || fail "node not installed"
ok "CLIs available"

railway whoami &>/dev/null || fail "Not logged in to Railway. Run: railway login"
ok "Railway authenticated"

HAS_SUPABASE=false
if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_KEY:-}" ]]; then
  HAS_SUPABASE=true
  ok "Supabase credentials present"
else
  warn "Supabase not configured - deploying without persistence"
fi

HAS_VERCEL=false
if command -v vercel &>/dev/null; then
  HAS_VERCEL=true
  ok "Vercel CLI available"
else
  warn "Vercel CLI not found - update frontend env vars manually"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
ok "Repo root: $REPO_ROOT"

set_shared_vars() {
  railway variables set "NETWORK=testnet" 2>/dev/null || true
  railway variables set "RPC_URL=$BASE_SEPOLIA_RPC" 2>/dev/null || true
  railway variables set "VAULT_ADDRESS=$VAULT_ADDRESS" 2>/dev/null || true
  railway variables set "ENGINE_ADDRESS=$ENGINE_ADDRESS" 2>/dev/null || true
  railway variables set "SETTLEMENT_ADDRESS=$SETTLEMENT_ADDRESS" 2>/dev/null || true
  railway variables set "LIQUIDATOR_ADDRESS=$LIQUIDATOR_ADDRESS" 2>/dev/null || true
  railway variables set "INSURANCE_FUND_ADDRESS=$INSURANCE_FUND_ADDRESS" 2>/dev/null || true
  railway variables set "ORACLE_ROUTER_ADDRESS=$ORACLE_ROUTER_ADDRESS" 2>/dev/null || true
}

# ---- STEP 1: Railway Project ----
step "1" "Initializing Railway project..."
if ! railway status &>/dev/null; then
  railway init --name sur-protocol
  ok "Railway project created"
else
  ok "Railway project already linked"
fi

# ---- STEP 2: API Server ----
step "2" "Deploying API server..."
cd "$REPO_ROOT/api"
npm install --silent 2>&1 || true
npm run build
ok "API builds successfully"
cd "$REPO_ROOT"

railway service create sur-api 2>/dev/null || warn "sur-api may already exist"
railway link --service sur-api 2>/dev/null || true
set_shared_vars
railway variables set "OPERATOR_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY" 2>/dev/null || true

if $HAS_SUPABASE; then
  railway variables set "SUPABASE_URL=$SUPABASE_URL" 2>/dev/null || true
  railway variables set "SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY" 2>/dev/null || true
fi

railway up --service sur-api --detach -d api/
ok "API deploying to Railway"

sleep 15
API_URL=$(railway domain --service sur-api 2>/dev/null || echo "")
if [[ -z "$API_URL" ]]; then
  API_URL=$(railway domain --service sur-api --generate 2>/dev/null || echo "sur-api-production.up.railway.app")
fi
ok "API URL: https://$API_URL"

# ---- STEP 3: Oracle Keeper ----
step "3" "Deploying Oracle Keeper (worker)..."
cd "$REPO_ROOT/oracle-keeper"
npm install --silent 2>&1 || true
npm run build
ok "Oracle keeper builds"
cd "$REPO_ROOT"

railway service create sur-oracle-keeper 2>/dev/null || warn "may already exist"
railway link --service sur-oracle-keeper 2>/dev/null || true
set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY" 2>/dev/null || true
railway variables set "PUSH_INTERVAL_MS=5000" 2>/dev/null || true
railway up --service sur-oracle-keeper --detach -d oracle-keeper/
ok "Oracle keeper deploying"

# ---- STEP 4: Liquidation Keeper ----
step "4" "Deploying Liquidation Keeper (worker)..."
cd "$REPO_ROOT/keeper"
npm install --silent 2>&1 || true
npm run build
ok "Liquidation keeper builds"
cd "$REPO_ROOT"

railway service create sur-liquidation-keeper 2>/dev/null || warn "may already exist"
railway link --service sur-liquidation-keeper 2>/dev/null || true
set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY" 2>/dev/null || true
railway variables set "SCAN_INTERVAL_MS=5000" 2>/dev/null || true
railway up --service sur-liquidation-keeper --detach -d keeper/
ok "Liquidation keeper deploying"

# ---- STEP 5: Funding Bot ----
step "5" "Deploying Funding Bot (worker)..."
cd "$REPO_ROOT/funding-bot"
npm install --silent 2>&1 || true
npm run build
ok "Funding bot builds"
cd "$REPO_ROOT"

railway service create sur-funding-bot 2>/dev/null || warn "may already exist"
railway link --service sur-funding-bot 2>/dev/null || true
set_shared_vars
railway variables set "KEEPER_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY" 2>/dev/null || true
railway variables set "CHECK_INTERVAL_MS=30000" 2>/dev/null || true
railway up --service sur-funding-bot --detach -d funding-bot/
ok "Funding bot deploying"

# ---- STEP 6: Supabase ----
if $HAS_SUPABASE; then
  step "6" "Supabase configured - run schema manually:"
  echo "  1. Go to your Supabase dashboard -> SQL Editor"
  echo "  2. Paste contents of api/src/db/schema.sql"
  echo "  3. Click Run"
else
  step "6" "Skipping Supabase (not configured)"
fi

# ---- STEP 7: Vercel ----
step "7" "Updating Vercel frontend..."
if $HAS_VERCEL; then
  cd "$REPO_ROOT/web"
  echo "wss://$API_URL" | vercel env add NEXT_PUBLIC_WS_URL production --force 2>/dev/null && ok "Vercel env set" || warn "Set manually in Vercel dashboard"
  vercel --prod --yes 2>/dev/null && ok "Frontend redeployed" || warn "Run vercel --prod manually in web/"
  cd "$REPO_ROOT"
else
  warn "Set in Vercel dashboard: NEXT_PUBLIC_WS_URL = wss://$API_URL"
fi

# ---- STEP 8: Verify ----
step "8" "Verifying deployment..."
echo "  Waiting 30s for services..."
sleep 30

HEALTH=$(curl -s --max-time 10 "https://$API_URL/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "API health check passed!"
  echo "  $HEALTH"
else
  warn "API not responding yet - check: curl https://$API_URL/health"
fi

echo ""
echo "  DEPLOYMENT COMPLETE"
echo ""
echo "  API:       https://$API_URL"
echo "  WebSocket: wss://$API_URL"
echo "  Health:    https://$API_URL/health"
echo "  Frontend:  https://sur-protocol.vercel.app"
echo ""
echo "  4 services deployed to Railway"
echo "  Dashboard: https://railway.app/dashboard"
echo ""
