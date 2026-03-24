'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { TradeFormData, Market } from '@/lib/front-types';

interface TradeFormProps {
  market: Market;
  availableBalance: number;
  onSubmit?: (data: TradeFormData) => void;
}

const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20, 50, 100];

export function TradeForm({ market, availableBalance, onSubmit }: TradeFormProps) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [size, setSize] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [leverage, setLeverage] = useState(10);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showTpSl, setShowTpSl] = useState(false);
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [stopLoss, setStopLoss] = useState<string>('');

  const sizeValue = parseFloat(size) || 0;
  const priceValue = orderType === 'market' ? market.price : (parseFloat(price) || market.price);
  const notionalValue = sizeValue * priceValue;
  const requiredMargin = notionalValue / leverage;
  const fee = notionalValue * 0.0005;
  const maxSize = (availableBalance * leverage) / priceValue;

  const handleSizePercentage = useCallback((percentage: number) => {
    const calculatedSize = (maxSize * percentage) / 100;
    setSize(calculatedSize.toFixed(4));
  }, [maxSize]);

  const handleSubmit = useCallback(() => {
    if (!size || sizeValue <= 0) return;
    onSubmit?.({
      side,
      orderType,
      size: sizeValue,
      price: orderType === 'limit' ? parseFloat(price) : undefined,
      leverage,
      reduceOnly,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
    });
  }, [side, orderType, size, sizeValue, price, leverage, reduceOnly, takeProfit, stopLoss, onSubmit]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-medium text-foreground">Place Order</span>
        <div className="flex items-center gap-1 rounded-md bg-secondary p-0.5">
          <button
            onClick={() => setOrderType('market')}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-all',
              orderType === 'market' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Market
          </button>
          <button
            onClick={() => setOrderType('limit')}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-all',
              orderType === 'limit' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Limit
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setSide('long')}
            className={cn(
              'flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all',
              side === 'long' ? 'bg-long text-long-foreground glow-long' : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
          >
            Long
          </button>
          <button
            onClick={() => setSide('short')}
            className={cn(
              'flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all',
              side === 'short' ? 'bg-short text-short-foreground glow-short' : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
          >
            Short
          </button>
        </div>

        <div className="mb-4 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Available</span>
          <span className="font-mono text-foreground">
            {availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD
          </span>
        </div>

        {orderType === 'limit' && (
          <div className="mb-3">
            <label className="mb-1.5 block text-xs text-muted-foreground">Price</label>
            <div className="relative">
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={market.price.toString()}
                className="w-full rounded-lg border border-border bg-input px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USD</span>
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="mb-1.5 block text-xs text-muted-foreground">Size</label>
          <div className="relative">
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="0.0000"
              className="w-full rounded-lg border border-border bg-input px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{market.baseAsset}</span>
          </div>
        </div>

        <div className="mb-4 flex gap-2">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => handleSizePercentage(pct)}
              className="flex-1 rounded border border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              {pct}%
            </button>
          ))}
        </div>

        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Leverage</label>
            <span className="font-mono text-sm font-medium text-primary">{leverage}x</span>
          </div>
          <input
            type="range"
            min="1"
            max="100"
            value={leverage}
            onChange={(e) => setLeverage(parseInt(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-lg"
          />
          <div className="mt-2 flex justify-between">
            {LEVERAGE_OPTIONS.map((lev) => (
              <button
                key={lev}
                onClick={() => setLeverage(lev)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  leverage === lev ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {lev}x
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Reduce Only</span>
          <button
            onClick={() => setReduceOnly(!reduceOnly)}
            className={cn('relative h-5 w-9 rounded-full transition-colors', reduceOnly ? 'bg-primary' : 'bg-secondary')}
          >
            <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform', reduceOnly ? 'left-[18px]' : 'left-0.5')} />
          </button>
        </div>

        <button
          onClick={() => setShowTpSl(!showTpSl)}
          className="mb-3 flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
        >
          <span>Take Profit / Stop Loss</span>
          <svg className={cn('h-4 w-4 transition-transform', showTpSl && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showTpSl && (
          <div className="mb-4 space-y-3">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Take Profit</label>
              <input type="number" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="Price" className="w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-long focus:outline-none focus:ring-1 focus:ring-long" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Stop Loss</label>
              <input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="Price" className="w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-short focus:outline-none focus:ring-1 focus:ring-short" />
            </div>
          </div>
        )}

        <div className="mb-4 space-y-2 rounded-lg bg-secondary/50 p-3 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Entry Price</span>
            <span className="font-mono text-foreground">${priceValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Notional Value</span>
            <span className="font-mono text-foreground">${notionalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Required Margin</span>
            <span className="font-mono text-foreground">${requiredMargin.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Est. Fee</span>
            <span className="font-mono text-foreground">${fee.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-4">
        <button
          onClick={handleSubmit}
          disabled={!size || sizeValue <= 0 || requiredMargin > availableBalance}
          className={cn(
            'w-full rounded-lg py-3 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50',
            side === 'long' ? 'bg-long text-long-foreground hover:opacity-90 glow-long' : 'bg-short text-short-foreground hover:opacity-90 glow-short'
          )}
        >
          {side === 'long' ? 'Long' : 'Short'} {market.baseAsset}
        </button>
      </div>
    </div>
  );
}
