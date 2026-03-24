'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Position, Order } from '@/lib/front-types';

interface PositionsPanelProps {
  positions: Position[];
  orders: Order[];
  onClosePosition?: (positionId: string) => void;
  onCancelOrder?: (orderId: string) => void;
}

type TabType = 'positions' | 'orders' | 'history';

export function PositionsPanel({ positions, orders, onClosePosition, onCancelOrder }: PositionsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('positions');
  const totalUnrealizedPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
  const openOrdersCount = orders.filter(o => o.status === 'open').length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-6 border-b border-border px-4">
        <button
          onClick={() => setActiveTab('positions')}
          className={cn('relative py-3 text-sm font-medium transition-colors', activeTab === 'positions' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Positions
          {positions.length > 0 && (
            <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{positions.length}</span>
          )}
          {activeTab === 'positions' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={cn('relative py-3 text-sm font-medium transition-colors', activeTab === 'orders' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Open Orders
          {openOrdersCount > 0 && (
            <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-foreground">{openOrdersCount}</span>
          )}
          {activeTab === 'orders' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={cn('relative py-3 text-sm font-medium transition-colors', activeTab === 'history' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          History
          {activeTab === 'history' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </button>
        {activeTab === 'positions' && positions.length > 0 && (
          <div className="ml-auto text-sm">
            <span className="text-muted-foreground">Total PnL: </span>
            <span className={cn('font-mono font-medium', totalUnrealizedPnl >= 0 ? 'text-long' : 'text-short')}>
              {totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        {activeTab === 'positions' && <PositionsTable positions={positions} onClose={onClosePosition} />}
        {activeTab === 'orders' && <OrdersTable orders={orders} onCancel={onCancelOrder} />}
        {activeTab === 'history' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No trade history available</div>
        )}
      </div>
    </div>
  );
}

function PositionsTable({ positions, onClose }: { positions: Position[]; onClose?: (id: string) => void }) {
  if (positions.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No open positions</div>;
  }

  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="text-left text-xs text-muted-foreground">
          <th className="px-4 py-3 font-medium">Market</th>
          <th className="px-4 py-3 font-medium">Side</th>
          <th className="px-4 py-3 font-medium text-right">Size</th>
          <th className="px-4 py-3 font-medium text-right">Entry Price</th>
          <th className="px-4 py-3 font-medium text-right">Mark Price</th>
          <th className="px-4 py-3 font-medium text-right">Liq. Price</th>
          <th className="px-4 py-3 font-medium text-right">Margin</th>
          <th className="px-4 py-3 font-medium text-right">PnL</th>
          <th className="px-4 py-3 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => (
          <tr key={position.id} className="border-b border-border/50 text-sm transition-colors hover:bg-secondary/30">
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{position.symbol}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{position.leverage}x</span>
              </div>
            </td>
            <td className="px-4 py-3">
              <span className={cn('rounded px-2 py-1 text-xs font-medium', position.side === 'long' ? 'bg-long/20 text-long' : 'bg-short/20 text-short')}>
                {position.side.toUpperCase()}
              </span>
            </td>
            <td className="px-4 py-3 text-right font-mono text-foreground">{position.size.toFixed(4)}</td>
            <td className="px-4 py-3 text-right font-mono text-foreground">${position.entryPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td className="px-4 py-3 text-right font-mono text-foreground">${position.markPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td className="px-4 py-3 text-right font-mono text-short">${position.liquidationPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td className="px-4 py-3 text-right font-mono text-foreground">${position.margin.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td className="px-4 py-3 text-right">
              <div className={cn('font-mono', position.unrealizedPnl >= 0 ? 'text-long' : 'text-short')}>
                <div className="font-medium">{position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)}</div>
                <div className="text-xs opacity-80">({position.unrealizedPnlPercentage >= 0 ? '+' : ''}{position.unrealizedPnlPercentage.toFixed(2)}%)</div>
              </div>
            </td>
            <td className="px-4 py-3 text-right">
              <div className="flex items-center justify-end gap-2">
                <button className="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground">TP/SL</button>
                <button onClick={() => onClose?.(position.id)} className="rounded border border-short/50 px-2 py-1 text-xs text-short transition-colors hover:bg-short hover:text-short-foreground">Close</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrdersTable({ orders, onCancel }: { orders: Order[]; onCancel?: (id: string) => void }) {
  const openOrders = orders.filter(o => o.status === 'open' || o.status === 'partial');

  if (openOrders.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No open orders</div>;
  }

  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="text-left text-xs text-muted-foreground">
          <th className="px-4 py-3 font-medium">Market</th>
          <th className="px-4 py-3 font-medium">Type</th>
          <th className="px-4 py-3 font-medium">Side</th>
          <th className="px-4 py-3 font-medium text-right">Price</th>
          <th className="px-4 py-3 font-medium text-right">Size</th>
          <th className="px-4 py-3 font-medium text-right">Filled</th>
          <th className="px-4 py-3 font-medium text-right">Time</th>
          <th className="px-4 py-3 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((order) => (
          <tr key={order.id} className="border-b border-border/50 text-sm transition-colors hover:bg-secondary/30">
            <td className="px-4 py-3 font-medium text-foreground">{order.symbol}</td>
            <td className="px-4 py-3">
              <span className="rounded bg-secondary px-2 py-1 text-xs text-muted-foreground">{order.type.toUpperCase()}</span>
            </td>
            <td className="px-4 py-3">
              <span className={cn('rounded px-2 py-1 text-xs font-medium', order.side === 'buy' ? 'bg-long/20 text-long' : 'bg-short/20 text-short')}>
                {order.side.toUpperCase()}
              </span>
            </td>
            <td className="px-4 py-3 text-right font-mono text-foreground">${order.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td className="px-4 py-3 text-right font-mono text-foreground">{order.size.toFixed(4)}</td>
            <td className="px-4 py-3 text-right font-mono text-muted-foreground">{order.filled.toFixed(4)} / {order.size.toFixed(4)}</td>
            <td className="px-4 py-3 text-right font-mono text-muted-foreground">
              {new Date(order.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </td>
            <td className="px-4 py-3 text-right">
              <button onClick={() => onCancel?.(order.id)} className="rounded border border-short/50 px-2 py-1 text-xs text-short transition-colors hover:bg-short hover:text-short-foreground">Cancel</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
