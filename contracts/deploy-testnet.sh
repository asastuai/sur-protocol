#!/bin/bash
# =============================================================================
# SUR Protocol - Base Sepolia Testnet Deployment
# =============================================================================
# Usage:
#   1. Fund deployer wallet with Sepolia ETH:
#      Deployer: 0x5e444D0Ee11AC01D41b982c3b608c4afa0Aa02fE
#      Faucet: https://www.alchemy.com/faucets/base-sepolia
#
#   2. Set environment variables and run:
#      export DEPLOYER_PRIVATE_KEY="your_private_key_here"
#      export GUARDIAN_ADDRESS="0xa2bca41088Ccbe1741e1E17686582DfF641392A8"
#      export FEE_RECIPIENT="0xa2bca41088Ccbe1741e1E17686582DfF641392A8"
#      bash deploy-testnet.sh
#
# =============================================================================

set -e

# Validate required env vars
if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
    echo "ERROR: DEPLOYER_PRIVATE_KEY not set"
    echo "  export DEPLOYER_PRIVATE_KEY=\"your_private_key_here\""
    exit 1
fi

if [ -z "$GUARDIAN_ADDRESS" ]; then
    echo "Using Operator wallet as Guardian (testnet only)"
    export GUARDIAN_ADDRESS="0xa2bca41088Ccbe1741e1E17686582DfF641392A8"
fi

if [ -z "$FEE_RECIPIENT" ]; then
    echo "Using Operator wallet as Fee Recipient (testnet only)"
    export FEE_RECIPIENT="0xa2bca41088Ccbe1741e1E17686582DfF641392A8"
fi

# Use public Base Sepolia RPC if not set
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

echo ""
echo "=========================================================="
echo "  SUR Protocol - Deploying to Base Sepolia"
echo "=========================================================="
echo ""
echo "  Guardian:      $GUARDIAN_ADDRESS"
echo "  Fee Recipient: $FEE_RECIPIENT"
echo "  RPC:           $BASE_SEPOLIA_RPC_URL"
echo ""

# Deploy
forge script script/DeployTestnet.s.sol:DeployTestnet \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" \
    --broadcast \
    --slow \
    -vvvv 2>&1 | tee deploy-testnet-output.log

echo ""
echo "=========================================================="
echo "  Deployment log saved to: deploy-testnet-output.log"
echo "=========================================================="
echo ""
echo "NEXT: Update contract addresses in:"
echo "  - web/.env.production"
echo "  - web/.env"
echo "  - Railway env vars"
echo ""
echo "Extract addresses from the log above and run:"
echo "  grep -E '(PerpVault|PerpEngine|OrderSettlement|Liquidator|InsuranceFund|OracleRouter|SurTimelock):' deploy-testnet-output.log"
