// ============================================================
// backtester/gen-data.ts — Generate synthetic BTC-like data
// For testing when no network. Delete on VPS (use real data).
// ============================================================

interface Candle {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
  quoteVolume: number; trades: number;
  takerBuyBaseVol: number; takerBuyQuoteVol: number; isClosed: boolean;
}

export function generateSyntheticData(days: number): { c1m: Candle[]; c5m: Candle[] } {
  const c1m: Candle[] = [];
  const c5m: Candle[] = [];

  let price = 87000; // BTC ~87k start
  const startTime = Date.now() - (days + 2) * 86_400_000; // extra warmup
  const totalMinutes = (days + 2) * 1440;

  // Random walk with trend shifts
  let trend = 0.00003; // uptrend
  let volatility = 0.0005; // 0.05% per minute
  let phase = 'trend'; // trend, chop, breakout

  for (let m = 0; m < totalMinutes; m++) {
    // Shift market regime every 3-6h
    if (m % 240 === 0) {
      const r = Math.random();
      if (r < 0.35) { phase = 'trend'; trend = (Math.random() > 0.5 ? 1 : -1) * (0.00003 + Math.random() * 0.00005); volatility = 0.0004; }
      else if (r < 0.65) { phase = 'chop'; trend = 0; volatility = 0.0003; }
      else { phase = 'breakout'; trend = (Math.random() > 0.5 ? 1 : -1) * 0.0001; volatility = 0.0008; }
    }

    // Occasional spikes (simulate news events)
    let spike = 0;
    if (Math.random() < 0.002) spike = (Math.random() - 0.5) * price * 0.005; // 0.5% spike

    // Generate candle
    const openTime = startTime + m * 60_000;
    const open = price;
    const change = price * (trend + (Math.random() - 0.5) * volatility * 2) + spike;
    const close = open + change;
    const highDelta = Math.abs(change) * (1 + Math.random());
    const lowDelta = Math.abs(change) * (1 + Math.random());
    const high = Math.max(open, close) + highDelta;
    const low = Math.min(open, close) - lowDelta;
    const volume = 50 + Math.random() * 200;

    c1m.push({
      openTime, open, high, low, close,
      volume, closeTime: openTime + 59_999,
      quoteVolume: volume * close, trades: Math.floor(100 + Math.random() * 500),
      takerBuyBaseVol: volume * (0.4 + Math.random() * 0.2),
      takerBuyQuoteVol: 0, isClosed: true,
    });

    price = close;

    // Build 5m candles
    if ((m + 1) % 5 === 0 && c1m.length >= 5) {
      const batch = c1m.slice(-5);
      c5m.push({
        openTime: batch[0].openTime,
        open: batch[0].open,
        high: Math.max(...batch.map(c => c.high)),
        low: Math.min(...batch.map(c => c.low)),
        close: batch[batch.length - 1].close,
        volume: batch.reduce((s, c) => s + c.volume, 0),
        closeTime: batch[batch.length - 1].closeTime,
        quoteVolume: batch.reduce((s, c) => s + c.quoteVolume, 0),
        trades: batch.reduce((s, c) => s + c.trades, 0),
        takerBuyBaseVol: batch.reduce((s, c) => s + c.takerBuyBaseVol, 0),
        takerBuyQuoteVol: 0, isClosed: true,
      });
    }
  }

  return { c1m, c5m };
}
