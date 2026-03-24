'use client';

import { useEffect, useRef, useMemo, useState } from 'react';
import type { CandlestickData } from '@/lib/front-types';

interface TradingChartProps {
  data: CandlestickData[];
  symbol: string;
}

export function TradingChart({ data, symbol }: TradingChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [hoveredCandle, setHoveredCandle] = useState<CandlestickData | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const { minPrice, maxPrice, priceRange } = useMemo(() => {
    if (data.length === 0) return { minPrice: 0, maxPrice: 0, priceRange: 0 };
    const prices = data.flatMap(d => [d.high, d.low]);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const padding = (max - min) * 0.1;
    return { minPrice: min - padding, maxPrice: max + padding, priceRange: max - min + padding * 2 };
  }, [data]);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width, height: rect.height });
      }
    };
    updateDimensions();
    const resizeObserver = new ResizeObserver(updateDimensions);
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dimensions.width === 0 || data.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    ctx.scale(dpr, dpr);

    const { width, height } = dimensions;
    const padding = { top: 20, right: 80, bottom: 30, left: 10 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.clearRect(0, 0, width, height);

    // Grid lines - subtle
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;

    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (chartHeight / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const price = maxPrice - (priceRange / gridLines) * i;
      ctx.fillStyle = 'rgba(160, 160, 170, 0.5)';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(price.toFixed(2), width - padding.right + 8, y + 4);
    }

    // Candlesticks
    const candleWidth = Math.max(2, (chartWidth / data.length) * 0.7);
    const gap = chartWidth / data.length;

    data.forEach((candle, i) => {
      const x = padding.left + i * gap + gap / 2;
      const isGreen = candle.close >= candle.open;

      const yHigh = padding.top + ((maxPrice - candle.high) / priceRange) * chartHeight;
      const yLow = padding.top + ((maxPrice - candle.low) / priceRange) * chartHeight;
      const yOpen = padding.top + ((maxPrice - candle.open) / priceRange) * chartHeight;
      const yClose = padding.top + ((maxPrice - candle.close) / priceRange) * chartHeight;

      // Wick - using our GitHub-style colors
      ctx.strokeStyle = isGreen ? 'rgba(63, 185, 80, 0.8)' : 'rgba(248, 81, 73, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Body
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

      if (isGreen) {
        ctx.shadowColor = 'rgba(63, 185, 80, 0.3)';
        ctx.fillStyle = 'rgba(63, 185, 80, 0.9)';
      } else {
        ctx.shadowColor = 'rgba(248, 81, 73, 0.3)';
        ctx.fillStyle = 'rgba(248, 81, 73, 0.9)';
      }
      ctx.shadowBlur = 4;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      ctx.shadowBlur = 0;
    });

    // Volume bars
    const maxVolume = Math.max(...data.map(d => d.volume));
    const volumeHeight = chartHeight * 0.15;

    data.forEach((candle, i) => {
      const x = padding.left + i * gap + gap / 2;
      const barHeight = (candle.volume / maxVolume) * volumeHeight;
      const y = height - padding.bottom - barHeight;
      const isGreen = candle.close >= candle.open;

      ctx.fillStyle = isGreen ? 'rgba(63, 185, 80, 0.2)' : 'rgba(248, 81, 73, 0.2)';
      ctx.fillRect(x - candleWidth / 2, y, candleWidth, barHeight);
    });

    // Crosshair
    if (mousePos.x > padding.left && mousePos.x < width - padding.right &&
        mousePos.y > padding.top && mousePos.y < height - padding.bottom) {
      ctx.strokeStyle = 'rgba(100, 100, 120, 0.4)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.moveTo(mousePos.x, padding.top);
      ctx.lineTo(mousePos.x, height - padding.bottom);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(padding.left, mousePos.y);
      ctx.lineTo(width - padding.right, mousePos.y);
      ctx.stroke();

      ctx.setLineDash([]);

      const cursorPrice = maxPrice - ((mousePos.y - padding.top) / chartHeight) * priceRange;
      ctx.fillStyle = 'rgba(100, 100, 120, 0.9)';
      ctx.fillRect(width - padding.right, mousePos.y - 10, padding.right - 4, 20);
      ctx.fillStyle = 'white';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(cursorPrice.toFixed(2), width - padding.right + 4, mousePos.y + 4);
    }
  }, [data, dimensions, maxPrice, priceRange, mousePos]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x, y });

    const padding = { left: 10, right: 80 };
    const chartWidth = dimensions.width - padding.left - padding.right;
    const gap = chartWidth / data.length;
    const candleIndex = Math.floor((x - padding.left) / gap);

    if (candleIndex >= 0 && candleIndex < data.length) {
      setHoveredCandle(data[candleIndex]);
    } else {
      setHoveredCandle(null);
    }
  };

  const handleMouseLeave = () => {
    setMousePos({ x: 0, y: 0 });
    setHoveredCandle(null);
  };

  const currentCandle = hoveredCandle || data[data.length - 1];
  const priceChange = currentCandle ? currentCandle.close - currentCandle.open : 0;
  const priceChangePercent = currentCandle && currentCandle.open ? (priceChange / currentCandle.open) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">O</span>
            <span className="font-mono text-sm text-foreground">{currentCandle?.open.toFixed(2) || '-'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">H</span>
            <span className="font-mono text-sm text-foreground">{currentCandle?.high.toFixed(2) || '-'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">L</span>
            <span className="font-mono text-sm text-foreground">{currentCandle?.low.toFixed(2) || '-'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">C</span>
            <span className={`font-mono text-sm ${priceChange >= 0 ? 'text-long' : 'text-short'}`}>
              {currentCandle?.close.toFixed(2) || '-'}
            </span>
          </div>
          <div className={`font-mono text-sm ${priceChange >= 0 ? 'text-long' : 'text-short'}`}>
            {priceChange >= 0 ? '+' : ''}{priceChangePercent.toFixed(2)}%
          </div>
        </div>
        <div className="flex items-center gap-2">
          {['1m', '5m', '15m', '1h', '4h', '1d'].map((tf) => (
            <button
              key={tf}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                tf === '15m' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0"
          style={{ width: '100%', height: '100%' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
}
