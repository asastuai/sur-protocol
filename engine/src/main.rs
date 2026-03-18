pub mod types;
pub mod orderbook;
pub mod matching;

use types::*;
use matching::MatchingEngine;

fn main() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("sur_engine=debug")
        .init();

    println!("╔════════════════════════════════════════════╗");
    println!("║        SUR Protocol - Matching Engine      ║");
    println!("║     First Argentine Perp DEX on Base L2    ║");
    println!("╚════════════════════════════════════════════╝");
    println!();

    // Create BTC-USD perpetual market
    let config = MarketConfig::btc_usd_default();
    let mut engine = MatchingEngine::new(config);

    println!("📊 Market: BTC-USD Perpetual");
    println!("   Maker fee: 0.02% | Taker fee: 0.06%");
    println!("   Max leverage: 20x");
    println!();

    // === Simulate a trading session ===

    println!("━━━ Building the orderbook ━━━");
    println!();

    // Market makers place resting orders
    let makers = vec![
        ("0xMaker1", Side::Sell, 50_200.0, 2.0),
        ("0xMaker1", Side::Sell, 50_100.0, 1.5),
        ("0xMaker2", Side::Sell, 50_050.0, 0.5),
        ("0xMaker2", Side::Buy, 49_950.0, 0.5),
        ("0xMaker1", Side::Buy, 49_900.0, 1.5),
        ("0xMaker3", Side::Buy, 49_800.0, 3.0),
    ];

    for (trader, side, price, qty) in makers {
        let order = match side {
            Side::Buy => Order::new_limit(
                MarketId::new("BTC", "USD"),
                trader.to_string(),
                Side::Buy,
                Price::from_f64(price),
                Quantity::from_f64(qty),
                TimeInForce::GTC,
            ),
            Side::Sell => Order::new_limit(
                MarketId::new("BTC", "USD"),
                trader.to_string(),
                Side::Sell,
                Price::from_f64(price),
                Quantity::from_f64(qty),
                TimeInForce::GTC,
            ),
        };
        let result = engine.submit_order(order);
        println!("  {} {:>4} {:.1} BTC @ ${:.0} → {:?}",
            trader, format!("{}", side), qty, price, result.status);
    }

    println!();
    println!("{}", engine.book);

    // === Aggressive taker comes in ===

    println!("━━━ Taker sweeps the asks ━━━");
    println!();

    let taker_order = Order::new_limit(
        MarketId::new("BTC", "USD"),
        "0xTaker1".to_string(),
        Side::Buy,
        Price::from_f64(50_200.0),
        Quantity::from_f64(3.0),
        TimeInForce::GTC,
    );

    let result = engine.submit_order(taker_order);
    println!("  0xTaker1 BUY 3.0 BTC @ $50,200 (limit)");
    println!("  Status: {:?}", result.status);
    println!("  Trades: {}", result.trades.len());

    for (i, trade) in result.trades.iter().enumerate() {
        println!("    Trade {}: {:.4} BTC @ {} (maker: {}, fee: ${:.2} + ${:.2})",
            i + 1,
            trade.quantity.to_f64(),
            trade.price,
            &trade.maker_trader[..8],
            trade.maker_fee as f64 / 1_000_000.0,
            trade.taker_fee as f64 / 1_000_000.0,
        );
    }

    if !result.remaining.is_zero() {
        println!("  Remaining: {} BTC resting on book", result.remaining);
    }

    println!();
    println!("{}", engine.book);

    // === Market sell ===

    println!("━━━ Market sell into bids ━━━");
    println!();

    let market_sell = Order::new_market(
        MarketId::new("BTC", "USD"),
        "0xTaker2".to_string(),
        Side::Sell,
        Quantity::from_f64(2.0),
    );

    let result = engine.submit_order(market_sell);
    println!("  0xTaker2 SELL 2.0 BTC @ MARKET");
    println!("  Status: {:?}", result.status);

    for (i, trade) in result.trades.iter().enumerate() {
        println!("    Trade {}: {:.4} BTC @ {}",
            i + 1,
            trade.quantity.to_f64(),
            trade.price,
        );
    }

    println!();
    println!("{}", engine.book);

    // === Summary ===

    println!("━━━ Session Summary ━━━");
    println!();
    println!("  Total trades executed: {}", engine.trades().len());
    println!("  Active orders on book: {}", engine.book.active_order_count());

    if let Some((bid, ask, _spread)) = engine.book.spread() {
        println!("  Best bid: {} | Best ask: {}", bid, ask);
    }

    let total_notional: u64 = engine.trades().iter().map(|t| t.notional_usdc()).sum();
    println!("  Total volume (notional): ${:.2}", total_notional as f64 / 1_000_000.0);
    println!();
    println!("🌎 SUR Protocol - Matching engine ready.");
}
