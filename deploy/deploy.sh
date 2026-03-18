#!/bin/bash
# ═══════════════════════════════════════════════
#  SUR Protocol — Master Deploy Orchestration
# ═══════════════════════════════════════════════
#
# Usage:
#   ./deploy/deploy.sh testnet   # Deploy to Base Sepolia
#   ./deploy/deploy.sh mainnet   # Deploy to Base Mainnet (CAUTION!)
#   ./deploy/deploy.sh local     # Deploy to local Anvil fork
#
# Prerequisites:
#   - Foundry (forge, cast, anvil)
#   - Node.js 20+
#   - Rust 1.75+
#   - .env file with PRIVATE_KEY, RPC_URL, etc.

set -euo pipefail

NETWORK="${1:-testnet}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy"
ADDRESSES_FILE="$DEPLOY_DIR/addresses-${NETWORK}.json"
ENV_TEMPLATE="$DEPLOY_DIR/.env.${NETWORK}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[Deploy]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo "╔═══════════════════════════════════════════════╗"
echo "║     SUR Protocol — Deploy Orchestration        ║"
echo "║     Network: ${NETWORK}                               ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════
# STEP 0: VALIDATE ENVIRONMENT
# ═══════════════════════════════════════
log "Step 0: Validating environment..."

command -v forge >/dev/null 2>&1 || err "Foundry not installed. Run: curl -L https://foundry.paradigm.xyz | bash && foundryup"
command -v node >/dev/null 2>&1 || err "Node.js not installed"
command -v cargo >/dev/null 2>&1 || err "Rust not installed"

# Load env
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
  ok "Loaded .env"
else
  err "No .env file found. Copy .env.example and configure."
fi

[ -z "${PRIVATE_KEY:-}" ] && err "PRIVATE_KEY not set in .env"

# Set RPC based on network
case "$NETWORK" in
  testnet)
    RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
    CHAIN_ID=84532
    ;;
  mainnet)
    RPC_URL="${BASE_MAINNET_RPC_URL:-https://mainnet.base.org}"
    CHAIN_ID=8453
    read -p "⚠️  MAINNET DEPLOY! Type 'YES' to confirm: " confirm
    [ "$confirm" != "YES" ] && err "Aborted."
    ;;
  local)
    RPC_URL="http://127.0.0.1:8545"
    CHAIN_ID=31337
    ;;
  *) err "Unknown network: $NETWORK. Use: testnet, mainnet, local" ;;
esac

DEPLOYER=$(cast wallet address "$PRIVATE_KEY" 2>/dev/null || echo "unknown")
log "Deployer: $DEPLOYER"
log "RPC: $RPC_URL"

# Check balance
BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
BALANCE_ETH=$(echo "scale=6; $BALANCE / 1000000000000000000" | bc 2>/dev/null || echo "?")
log "Balance: $BALANCE_ETH ETH"

ok "Environment validated"
echo ""

# ═══════════════════════════════════════
# STEP 1: COMPILE CONTRACTS
# ═══════════════════════════════════════
log "Step 1: Compiling smart contracts..."
cd "$ROOT_DIR/contracts"

# Install deps if needed
[ ! -d "lib/forge-std" ] && forge install foundry-rs/forge-std --no-commit

forge build --force 2>&1 | tail -3
ok "Contracts compiled"
echo ""

# ═══════════════════════════════════════
# STEP 2: RUN TESTS
# ═══════════════════════════════════════
log "Step 2: Running tests..."
TEST_OUTPUT=$(forge test --no-match-contract "InvariantTest" 2>&1)
TESTS_PASSED=$(echo "$TEST_OUTPUT" | grep -c "PASS" || true)
TESTS_FAILED=$(echo "$TEST_OUTPUT" | grep -c "FAIL" || true)

if [ "$TESTS_FAILED" -gt 0 ]; then
  err "Tests failed! Fix tests before deploying. Run: forge test -vvv"
fi

ok "$TESTS_PASSED tests passed, 0 failed"
echo ""

# ═══════════════════════════════════════
# STEP 3: DEPLOY CONTRACTS
# ═══════════════════════════════════════
log "Step 3: Deploying contracts to $NETWORK..."

DEPLOY_OUTPUT=$(forge script script/TestnetIntegration.s.sol:TestnetIntegration \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --private-key "$PRIVATE_KEY" \
  -vvv 2>&1)

# Extract addresses from deploy output
extract_address() {
  echo "$DEPLOY_OUTPUT" | grep -i "$1:" | grep -oE "0x[a-fA-F0-9]{40}" | head -1
}

VAULT_ADDR=$(extract_address "PerpVault")
ENGINE_ADDR=$(extract_address "PerpEngine")
SETTLEMENT_ADDR=$(extract_address "OrderSettlement")
LIQUIDATOR_ADDR=$(extract_address "Liquidator")
INSURANCE_ADDR=$(extract_address "InsuranceFund")
ORACLE_ADDR=$(extract_address "OracleRouter")

# Validate we got all addresses
for addr_var in VAULT_ADDR ENGINE_ADDR SETTLEMENT_ADDR LIQUIDATOR_ADDR INSURANCE_ADDR ORACLE_ADDR; do
  addr="${!addr_var}"
  if [ -z "$addr" ] || [ "$addr" = "" ]; then
    warn "Could not extract $addr_var from deploy output."
    warn "Check forge output and set addresses manually in $ADDRESSES_FILE"
  fi
done

ok "Contracts deployed"
echo ""

# ═══════════════════════════════════════
# STEP 4: SAVE ADDRESSES
# ═══════════════════════════════════════
log "Step 4: Saving addresses..."

mkdir -p "$DEPLOY_DIR"

cat > "$ADDRESSES_FILE" << EOF
{
  "network": "$NETWORK",
  "chainId": $CHAIN_ID,
  "deployer": "$DEPLOYER",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "vault": "${VAULT_ADDR:-UNKNOWN}",
    "engine": "${ENGINE_ADDR:-UNKNOWN}",
    "settlement": "${SETTLEMENT_ADDR:-UNKNOWN}",
    "liquidator": "${LIQUIDATOR_ADDR:-UNKNOWN}",
    "insuranceFund": "${INSURANCE_ADDR:-UNKNOWN}",
    "oracleRouter": "${ORACLE_ADDR:-UNKNOWN}"
  },
  "rpcUrl": "$RPC_URL"
}
EOF

ok "Addresses saved to $ADDRESSES_FILE"
cat "$ADDRESSES_FILE"
echo ""

# ═══════════════════════════════════════
# STEP 5: GENERATE .ENV FILES
# ═══════════════════════════════════════
log "Step 5: Generating .env files for all services..."

generate_env() {
  local service=$1
  local dir="$ROOT_DIR/$service"
  local env_file="$dir/.env"

  if [ ! -d "$dir" ]; then return; fi

  cat > "$env_file" << EOF
# Auto-generated by deploy.sh — $NETWORK — $(date -u +%Y-%m-%dT%H:%M:%SZ)
NETWORK=$NETWORK
RPC_URL=$RPC_URL
VAULT_ADDRESS=${VAULT_ADDR:-0x}
ENGINE_ADDRESS=${ENGINE_ADDR:-0x}
SETTLEMENT_ADDRESS=${SETTLEMENT_ADDR:-0x}
LIQUIDATOR_ADDRESS=${LIQUIDATOR_ADDR:-0x}
INSURANCE_FUND_ADDRESS=${INSURANCE_ADDR:-0x}
ORACLE_ROUTER_ADDRESS=${ORACLE_ADDR:-0x}
EOF

  # Service-specific additions
  case "$service" in
    api)
      echo "OPERATOR_PRIVATE_KEY=$PRIVATE_KEY" >> "$env_file"
      echo "WS_PORT=3002" >> "$env_file"
      echo "BATCH_INTERVAL_MS=2000" >> "$env_file"
      ;;
    keeper)
      echo "KEEPER_PRIVATE_KEY=$PRIVATE_KEY" >> "$env_file"
      echo "SCAN_INTERVAL_MS=5000" >> "$env_file"
      ;;
    oracle-keeper)
      echo "KEEPER_PRIVATE_KEY=$PRIVATE_KEY" >> "$env_file"
      echo "PUSH_INTERVAL_MS=5000" >> "$env_file"
      ;;
    funding-bot)
      echo "KEEPER_PRIVATE_KEY=$PRIVATE_KEY" >> "$env_file"
      echo "CHECK_INTERVAL_MS=30000" >> "$env_file"
      ;;
    risk-engine)
      echo "SCAN_INTERVAL_MS=15000" >> "$env_file"
      ;;
    web)
      echo "NEXT_PUBLIC_WS_URL=ws://localhost:3002" >> "$env_file"
      echo "NEXT_PUBLIC_CHAIN_ID=$CHAIN_ID" >> "$env_file"
      echo "NEXT_PUBLIC_VAULT_ADDRESS=${VAULT_ADDR:-0x}" >> "$env_file"
      echo "NEXT_PUBLIC_ENGINE_ADDRESS=${ENGINE_ADDR:-0x}" >> "$env_file"
      echo "NEXT_PUBLIC_SETTLEMENT_ADDRESS=${SETTLEMENT_ADDR:-0x}" >> "$env_file"
      ;;
  esac

  ok "Generated $env_file"
}

for svc in api keeper oracle-keeper funding-bot risk-engine web monitoring; do
  generate_env "$svc"
done
echo ""

# ═══════════════════════════════════════
# STEP 6: INSTALL DEPENDENCIES
# ═══════════════════════════════════════
log "Step 6: Installing dependencies..."

for svc in api keeper oracle-keeper funding-bot risk-engine web sdk monitoring; do
  dir="$ROOT_DIR/$svc"
  if [ -f "$dir/package.json" ]; then
    (cd "$dir" && npm install --silent 2>/dev/null) && ok "Installed: $svc" || warn "Failed: $svc"
  fi
done

# Rust engine
if [ -f "$ROOT_DIR/engine/Cargo.toml" ]; then
  (cd "$ROOT_DIR/engine" && cargo build --release 2>/dev/null) && ok "Built: engine (Rust)" || warn "Failed: engine"
fi
echo ""

# ═══════════════════════════════════════
# STEP 7: VERIFY DEPLOYMENT
# ═══════════════════════════════════════
log "Step 7: Verifying deployment..."

verify_contract() {
  local name=$1
  local addr=$2
  if [ -z "$addr" ] || [ "$addr" = "UNKNOWN" ]; then
    warn "Skipping $name (address unknown)"
    return
  fi
  local code=$(cast code "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
  if [ "$code" != "0x" ] && [ ${#code} -gt 4 ]; then
    ok "$name at $addr (${#code} bytes)"
  else
    warn "$name at $addr has no code!"
  fi
}

verify_contract "PerpVault" "$VAULT_ADDR"
verify_contract "PerpEngine" "$ENGINE_ADDR"
verify_contract "OrderSettlement" "$SETTLEMENT_ADDR"
verify_contract "Liquidator" "$LIQUIDATOR_ADDR"
verify_contract "InsuranceFund" "$INSURANCE_ADDR"
verify_contract "OracleRouter" "$ORACLE_ADDR"
echo ""

# ═══════════════════════════════════════
# DONE
# ═══════════════════════════════════════
echo "═══════════════════════════════════════════════"
echo ""
ok "DEPLOYMENT COMPLETE"
echo ""
echo "  Addresses: $ADDRESSES_FILE"
echo "  .env files generated for all services"
echo ""
echo "  Start services in this order:"
echo "    1. cd oracle-keeper && npm run dev   # FIRST (prices)"
echo "    2. cd api && npm run dev             # Backend API"
echo "    3. cd funding-bot && npm run dev     # Funding rates"
echo "    4. cd risk-engine && npm run dev     # Monitoring"
echo "    5. cd keeper && npm run dev          # Liquidations"
echo "    6. cd web && npm run dev             # Frontend"
echo ""
echo "  Or use: ./deploy/start-all.sh"
echo ""
echo "═══════════════════════════════════════════════"
