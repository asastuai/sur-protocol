#!/bin/bash
# =============================================================================
# Update contract addresses in frontend after deployment
# =============================================================================
# Usage: bash update-addresses.sh <vault> <engine> <settlement> <liquidator> <insurance> <oracle> <timelock>
# Example:
#   bash update-addresses.sh 0xAAA... 0xBBB... 0xCCC... 0xDDD... 0xEEE... 0xFFF... 0xGGG...
# =============================================================================

set -e

if [ "$#" -lt 3 ]; then
    echo "Usage: bash update-addresses.sh <vault> <engine> <settlement>"
    echo ""
    echo "Pass at least the 3 main addresses (vault, engine, settlement)"
    echo "These are the ones referenced in the frontend .env files"
    exit 1
fi

VAULT=$1
ENGINE=$2
SETTLEMENT=$3

WEB_DIR="../web"

echo "Updating frontend contract addresses..."
echo "  Vault:      $VAULT"
echo "  Engine:     $ENGINE"
echo "  Settlement: $SETTLEMENT"

# Update .env
sed -i "s|NEXT_PUBLIC_VAULT_ADDRESS=.*|NEXT_PUBLIC_VAULT_ADDRESS=$VAULT|" "$WEB_DIR/.env"
sed -i "s|NEXT_PUBLIC_ENGINE_ADDRESS=.*|NEXT_PUBLIC_ENGINE_ADDRESS=$ENGINE|" "$WEB_DIR/.env"
sed -i "s|NEXT_PUBLIC_SETTLEMENT_ADDRESS=.*|NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT|" "$WEB_DIR/.env"

# Update .env.production
sed -i "s|NEXT_PUBLIC_VAULT_ADDRESS=.*|NEXT_PUBLIC_VAULT_ADDRESS=$VAULT|" "$WEB_DIR/.env.production"
sed -i "s|NEXT_PUBLIC_ENGINE_ADDRESS=.*|NEXT_PUBLIC_ENGINE_ADDRESS=$ENGINE|" "$WEB_DIR/.env.production"
sed -i "s|NEXT_PUBLIC_SETTLEMENT_ADDRESS=.*|NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT|" "$WEB_DIR/.env.production"

echo ""
echo "Updated:"
echo "  $WEB_DIR/.env"
echo "  $WEB_DIR/.env.production"
echo ""
echo "Remember to also update Railway env vars for the API service."
echo "Then redeploy frontend: cd ../web && vercel --prod"
