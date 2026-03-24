'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { WalletState, Market } from '@/lib/front-types';

interface HeaderProps {
  market: Market;
  wallet: WalletState;
  onConnectWallet?: () => void;
  onDisconnectWallet?: () => void;
}

export function TradingHeader({ market, wallet, onConnectWallet, onDisconnectWallet }: HeaderProps) {
  const [showWalletMenu, setShowWalletMenu] = useState(false);

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
      {/* Logo & Navigation */}
      <div className="flex items-center gap-8">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <svg
              className="h-5 w-5 text-primary-foreground"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <span className="text-lg font-bold text-foreground">SUR</span>
        </div>

        {/* Nav Links */}
        <nav className="hidden items-center gap-6 md:flex">
          <a href="#" className="text-sm font-medium text-foreground">
            Trade
          </a>
          <a href="/portfolio" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Portfolio
          </a>
          <a href="/leaderboard" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Leaderboard
          </a>
          <a href="/vaults" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Vaults
          </a>
        </nav>
      </div>

      {/* Market Info - Center */}
      <div className="hidden items-center gap-8 lg:flex">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-foreground">{market.symbol}</span>
          <span
            className={cn(
              'font-mono text-lg font-medium',
              market.change24h >= 0 ? 'text-long' : 'text-short'
            )}
          >
            ${market.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-xs font-medium',
              market.change24h >= 0 ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            )}
          >
            {market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}%
          </span>
        </div>

        <div className="flex items-center gap-6 text-xs">
          <div>
            <span className="text-muted-foreground">Mark: </span>
            <span className="font-mono text-foreground">
              ${market.markPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Index: </span>
            <span className="font-mono text-foreground">
              ${market.indexPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">24h Vol: </span>
            <span className="font-mono text-foreground">
              ${(market.volume24h / 1_000_000_000).toFixed(2)}B
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">OI: </span>
            <span className="font-mono text-foreground">
              ${(market.openInterest / 1_000_000).toFixed(0)}M
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Funding: </span>
            <span className={cn('font-mono', market.fundingRate >= 0 ? 'text-long' : 'text-short')}>
              {market.fundingRate >= 0 ? '+' : ''}{(market.fundingRate * 100).toFixed(4)}%
            </span>
            <span className="ml-1 text-muted-foreground">in {market.nextFunding}</span>
          </div>
        </div>
      </div>

      {/* Wallet & Settings */}
      <div className="flex items-center gap-3">
        {/* Network Status */}
        <div className="hidden items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 md:flex">
          <div className="h-2 w-2 rounded-full bg-long animate-pulse" />
          <span className="text-xs text-muted-foreground">Base</span>
        </div>

        {/* Wallet Button */}
        {wallet.connected && wallet.address ? (
          <div className="relative">
            <button
              onClick={() => setShowWalletMenu(!showWalletMenu)}
              className="flex items-center gap-3 rounded-lg border border-border bg-secondary px-3 py-2 transition-colors hover:border-primary"
            >
              <div className="text-right">
                <div className="font-mono text-sm text-foreground">
                  ${wallet.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatAddress(wallet.address)}
                </div>
              </div>
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-accent" />
            </button>

            {showWalletMenu && (
              <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-border bg-popover p-3 shadow-xl">
                <div className="mb-3 space-y-2 border-b border-border pb-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Balance</span>
                    <span className="font-mono text-foreground">
                      ${wallet.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Available</span>
                    <span className="font-mono text-foreground">
                      ${wallet.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Margin</span>
                    <span className="font-mono text-foreground">
                      ${wallet.marginBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Unrealized PnL</span>
                    <span className={cn('font-mono', wallet.unrealizedPnl >= 0 ? 'text-long' : 'text-short')}>
                      {wallet.unrealizedPnl >= 0 ? '+' : ''}${wallet.unrealizedPnl.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="flex-1 rounded-lg bg-primary py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90">
                    Deposit
                  </button>
                  <button className="flex-1 rounded-lg border border-border py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
                    Withdraw
                  </button>
                </div>
                <button
                  onClick={onDisconnectWallet}
                  className="mt-2 w-full rounded-lg py-2 text-xs text-muted-foreground transition-colors hover:text-short"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={onConnectWallet}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 glow-primary"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </header>
  );
}
