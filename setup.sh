#!/bin/bash
# SUR Protocol - Quick Setup
# Run: chmod +x setup.sh && ./setup.sh

set -e

echo "🌎 SUR Protocol - Setup"
echo "========================"

# Check prerequisites
echo ""
echo "Checking prerequisites..."

if ! command -v forge &> /dev/null; then
    echo "❌ Foundry not found. Installing..."
    curl -L https://foundry.paradigm.xyz | bash
    source ~/.bashrc
    foundryup
else
    echo "✅ Foundry found: $(forge --version)"
fi

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 20+"
    exit 1
else
    echo "✅ Node.js found: $(node --version)"
fi

# Setup contracts
echo ""
echo "Setting up contracts..."
cd contracts

# Install Foundry dependencies
echo "Installing forge-std..."
forge install foundry-rs/forge-std --no-commit 2>/dev/null || echo "forge-std already installed"

echo "Installing OpenZeppelin..."
forge install OpenZeppelin/openzeppelin-contracts --no-commit 2>/dev/null || echo "OpenZeppelin already installed"

# Build
echo ""
echo "Building contracts..."
forge build

# Test
echo ""
echo "Running tests..."
forge test -vvv

echo ""
echo "========================"
echo "✅ SUR Protocol setup complete!"
echo ""
echo "Next steps:"
echo "  1. cp .env.example .env  (and fill in your keys)"
echo "  2. cd contracts && forge test -vvv"
echo "  3. Deploy to Base Sepolia:"
echo "     forge script script/DeploySur.s.sol:DeploySur --rpc-url base_sepolia --broadcast --verify"
echo ""
echo "🚀 Let's build the future of perps in Argentina!"
