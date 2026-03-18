use chrono::Utc;
use tracing::{debug, info, warn};

use crate::orderbook::OrderBook;
use crate::types::*;

// ============================================================
//                    MATCHING ENGINE
// ============================================================

/// The matching engine processes incoming orders against the orderbook.
///
/// Matching algorithm:
/// 1. Incoming order is the "taker"
/// 2. Match against resting orders (makers) using price-time priority
/// 3. Execute trades at the maker's price
/// 4. If taker has remaining quantity, place on book (GTC) or cancel (IOC/FOK)
///
/// Fee model:
/// - Maker fee: charged to the resting order (provides liquidity)
/// - Taker fee: charged to the incoming order (takes liquidity)
pub struct MatchingEngine {
    pub book: OrderBook,
    trades: Vec<Trade>,
}

impl MatchingEngine {
    pub fn new(config: MarketConfig) -> Self {
        info!(market = %config.id, "Matching engine initialized");
        MatchingEngine {
            book: OrderBook::new(config),
            trades: Vec::new(),
        }
    }

    /// Submit an order to the engine. Returns the result with any trades generated.
    pub fn submit_order(&mut self, mut order: Order) -> OrderResult {
        debug!(
            order_id = %order.id,
            side = %order.side,
            order_type = ?order.order_type,
            price = %order.price,
            quantity = %order.quantity,
            tif = ?order.time_in_force,
            "Order submitted"
        );

        // Validate order
        if let Err(reason) = self.validate_order(&order) {
            warn!(order_id = %order.id, reason = %reason, "Order rejected");
            order.status = OrderStatus::Rejected;
            return OrderResult {
                order_id: order.id,
                status: OrderStatus::Rejected,
                trades: vec![],
                events: vec![EngineEvent::OrderRejected {
                    order_id: order.id,
                    reason,
                }],
                remaining: order.remaining,
            };
        }

        // Check PostOnly: reject if it would match
        if order.time_in_force == TimeInForce::PostOnly {
            if self.would_match(&order) {
                order.status = OrderStatus::Rejected;
                return OrderResult {
                    order_id: order.id,
                    status: OrderStatus::Rejected,
                    trades: vec![],
                    events: vec![EngineEvent::OrderRejected {
                        order_id: order.id,
                        reason: "PostOnly order would match immediately".to_string(),
                    }],
                    remaining: order.remaining,
                };
            }
        }

        // Match the order
        let mut trades = Vec::new();
        let mut events = Vec::new();

        self.match_order(&mut order, &mut trades, &mut events);

        // Handle remaining quantity based on TimeInForce
        match order.time_in_force {
            TimeInForce::GTC | TimeInForce::PostOnly => {
                if !order.remaining.is_zero() && order.order_type == OrderType::Limit {
                    // Place remainder on book
                    if order.remaining < order.quantity {
                        order.status = OrderStatus::PartiallyFilled;
                    }
                    events.push(EngineEvent::OrderPlaced {
                        order_id: order.id,
                        market: order.market.clone(),
                        side: order.side,
                        price: order.price,
                        quantity: order.remaining,
                    });
                    let order_clone = order.clone();
                    self.book.place_order(order_clone);
                } else if order.remaining.is_zero() {
                    order.status = OrderStatus::Filled;
                    events.push(EngineEvent::OrderFilled { order_id: order.id });
                }
            }
            TimeInForce::IOC => {
                if order.remaining.is_zero() {
                    order.status = OrderStatus::Filled;
                    events.push(EngineEvent::OrderFilled { order_id: order.id });
                } else if order.remaining < order.quantity {
                    // Partially filled, cancel the rest
                    order.status = OrderStatus::Cancelled;
                    events.push(EngineEvent::OrderCancelled {
                        order_id: order.id,
                        remaining: order.remaining,
                    });
                } else {
                    order.status = OrderStatus::Cancelled;
                    events.push(EngineEvent::OrderCancelled {
                        order_id: order.id,
                        remaining: order.remaining,
                    });
                }
            }
            TimeInForce::FOK => {
                if order.remaining.is_zero() {
                    order.status = OrderStatus::Filled;
                    events.push(EngineEvent::OrderFilled { order_id: order.id });
                } else {
                    // FOK should have been caught before matching, but just in case
                    order.status = OrderStatus::Cancelled;
                    events.push(EngineEvent::OrderCancelled {
                        order_id: order.id,
                        remaining: order.quantity, // full quantity since FOK is all or nothing
                    });
                    trades.clear(); // rollback trades (shouldn't happen with proper FOK)
                }
            }
        }

        let status = order.status;
        let remaining = order.remaining;
        let order_id = order.id;

        // Store trades
        self.trades.extend(trades.clone());

        info!(
            order_id = %order_id,
            status = ?status,
            trades = trades.len(),
            remaining = %remaining,
            "Order processed"
        );

        OrderResult {
            order_id,
            status,
            trades,
            events,
            remaining,
        }
    }

    /// Cancel an existing order
    pub fn cancel_order(&mut self, order_id: &OrderId) -> Option<Order> {
        if let Some(mut order) = self.book.cancel_order(order_id) {
            order.status = OrderStatus::Cancelled;
            order.updated_at = Utc::now();
            info!(order_id = %order_id, remaining = %order.remaining, "Order cancelled");
            Some(order)
        } else {
            warn!(order_id = %order_id, "Cancel failed: order not found");
            None
        }
    }

    /// Get all trades
    pub fn trades(&self) -> &[Trade] {
        &self.trades
    }

    /// Get recent trades (last N)
    pub fn recent_trades(&self, n: usize) -> &[Trade] {
        let len = self.trades.len();
        if n >= len {
            &self.trades
        } else {
            &self.trades[len - n..]
        }
    }

    // ============================================================
    //                    PRIVATE METHODS
    // ============================================================

    /// Validate an incoming order
    fn validate_order(&self, order: &Order) -> Result<(), String> {
        if order.quantity.is_zero() {
            return Err("Quantity cannot be zero".to_string());
        }

        if order.order_type == OrderType::Limit && order.price.is_zero() {
            return Err("Limit order must have a price".to_string());
        }

        if order.quantity < self.book.config.min_quantity {
            return Err(format!(
                "Quantity {} below minimum {}",
                order.quantity, self.book.config.min_quantity
            ));
        }

        if order.quantity > self.book.config.max_quantity {
            return Err(format!(
                "Quantity {} exceeds maximum {}",
                order.quantity, self.book.config.max_quantity
            ));
        }

        // Check lot size alignment
        if order.quantity.0 % self.book.config.lot_size.0 != 0 {
            return Err(format!(
                "Quantity {} not aligned to lot size {}",
                order.quantity, self.book.config.lot_size
            ));
        }

        // Check tick size alignment for limit orders
        if order.order_type == OrderType::Limit {
            if order.price.0 % self.book.config.tick_size.0 != 0 {
                return Err(format!(
                    "Price {} not aligned to tick size {}",
                    order.price, self.book.config.tick_size
                ));
            }
        }

        // Self-trade prevention: check if trader has orders on opposite side
        // (simplified - full implementation would check per-order)

        Ok(())
    }

    /// Check if an order would immediately match (for PostOnly check)
    fn would_match(&self, order: &Order) -> bool {
        match order.side {
            Side::Buy => {
                if let Some(best_ask) = self.book.best_ask() {
                    order.can_match_at(best_ask)
                } else {
                    false
                }
            }
            Side::Sell => {
                if let Some(best_bid) = self.book.best_bid() {
                    // For a sell, it can match if its price <= best bid
                    order.price <= best_bid
                } else {
                    false
                }
            }
        }
    }

    /// Core matching algorithm: match an incoming order against the book
    fn match_order(
        &mut self,
        taker: &mut Order,
        trades: &mut Vec<Trade>,
        events: &mut Vec<EngineEvent>,
    ) {
        // FOK check: verify enough liquidity exists before matching
        if taker.time_in_force == TimeInForce::FOK {
            if !self.can_fill_entirely(taker) {
                return; // Don't match anything for FOK
            }
        }

        match taker.side {
            Side::Buy => self.match_buy(taker, trades, events),
            Side::Sell => self.match_sell(taker, trades, events),
        }
    }

    /// Match a buy order against asks (ascending price)
    fn match_buy(
        &mut self,
        taker: &mut Order,
        trades: &mut Vec<Trade>,
        events: &mut Vec<EngineEvent>,
    ) {
        while !taker.remaining.is_zero() {
            // Check if there's an ask we can match against
            let can_match = match self.book.peek_best_ask() {
                Some(maker) => taker.can_match_at(maker.price),
                None => false,
            };

            if !can_match {
                break;
            }

            // Get maker details before mutating
            let maker = self.book.peek_best_ask().unwrap();
            let exec_price = maker.price; // trade executes at maker's price
            let maker_id = maker.id;
            let maker_trader = maker.trader.clone();
            let fill_qty = taker.remaining.min(maker.remaining);

            // Calculate fees
            let notional = (exec_price.0 as u128 * fill_qty.0 as u128) / Quantity::SCALE as u128;
            let maker_fee =
                (notional * self.book.config.maker_fee_bps as u128 / 10_000) as u64;
            let taker_fee =
                (notional * self.book.config.taker_fee_bps as u128 / 10_000) as u64;

            // Create trade
            let trade = Trade {
                id: TradeId::new(),
                market: taker.market.clone(),
                price: exec_price,
                quantity: fill_qty,
                maker_order_id: maker_id,
                taker_order_id: taker.id,
                maker_trader,
                taker_trader: taker.trader.clone(),
                maker_side: Side::Sell,
                taker_side: Side::Buy,
                maker_fee,
                taker_fee,
                timestamp: Utc::now(),
            };

            debug!(
                trade_id = %trade.id,
                price = %exec_price,
                qty = %fill_qty,
                "Trade executed"
            );

            events.push(EngineEvent::TradeExecuted(trade.clone()));
            trades.push(trade);

            // Update taker
            taker.remaining = taker.remaining - fill_qty;
            taker.updated_at = Utc::now();

            // Update maker on book
            if let Some(filled_order) = self.book.fill_best_ask(fill_qty) {
                events.push(EngineEvent::OrderFilled {
                    order_id: filled_order.id,
                });
            }

            self.book.trade_count += 1;
        }
    }

    /// Match a sell order against bids (descending price)
    fn match_sell(
        &mut self,
        taker: &mut Order,
        trades: &mut Vec<Trade>,
        events: &mut Vec<EngineEvent>,
    ) {
        while !taker.remaining.is_zero() {
            let can_match = match self.book.peek_best_bid() {
                Some(maker) => {
                    match taker.order_type {
                        OrderType::Market => true,
                        OrderType::Limit => taker.price <= maker.price,
                    }
                }
                None => false,
            };

            if !can_match {
                break;
            }

            let maker = self.book.peek_best_bid().unwrap();
            let exec_price = maker.price;
            let maker_id = maker.id;
            let maker_trader = maker.trader.clone();
            let fill_qty = taker.remaining.min(maker.remaining);

            let notional = (exec_price.0 as u128 * fill_qty.0 as u128) / Quantity::SCALE as u128;
            let maker_fee =
                (notional * self.book.config.maker_fee_bps as u128 / 10_000) as u64;
            let taker_fee =
                (notional * self.book.config.taker_fee_bps as u128 / 10_000) as u64;

            let trade = Trade {
                id: TradeId::new(),
                market: taker.market.clone(),
                price: exec_price,
                quantity: fill_qty,
                maker_order_id: maker_id,
                taker_order_id: taker.id,
                maker_trader,
                taker_trader: taker.trader.clone(),
                maker_side: Side::Buy,
                taker_side: Side::Sell,
                maker_fee,
                taker_fee,
                timestamp: Utc::now(),
            };

            debug!(
                trade_id = %trade.id,
                price = %exec_price,
                qty = %fill_qty,
                "Trade executed"
            );

            events.push(EngineEvent::TradeExecuted(trade.clone()));
            trades.push(trade);

            taker.remaining = taker.remaining - fill_qty;
            taker.updated_at = Utc::now();

            if let Some(filled_order) = self.book.fill_best_bid(fill_qty) {
                events.push(EngineEvent::OrderFilled {
                    order_id: filled_order.id,
                });
            }

            self.book.trade_count += 1;
        }
    }

    /// Check if a FOK order can be filled entirely
    fn can_fill_entirely(&self, order: &Order) -> bool {
        let mut remaining = order.remaining;

        match order.side {
            Side::Buy => {
                for (price, level) in self.book.asks.iter() {
                    if !order.can_match_at(*price) {
                        break;
                    }
                    for maker in level.orders.iter() {
                        let fill = remaining.min(maker.remaining);
                        remaining = remaining - fill;
                        if remaining.is_zero() {
                            return true;
                        }
                    }
                }
            }
            Side::Sell => {
                for (std::cmp::Reverse(price), level) in self.book.bids.iter() {
                    match order.order_type {
                        OrderType::Market => {}
                        OrderType::Limit => {
                            if order.price > *price {
                                break;
                            }
                        }
                    }
                    for maker in level.orders.iter() {
                        let fill = remaining.min(maker.remaining);
                        remaining = remaining - fill;
                        if remaining.is_zero() {
                            return true;
                        }
                    }
                }
            }
        }

        remaining.is_zero()
    }
}

// ============================================================
//                        TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> MatchingEngine {
        MatchingEngine::new(MarketConfig::btc_usd_default())
    }

    fn buy_limit(trader: &str, price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Buy,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::GTC,
        )
    }

    fn sell_limit(trader: &str, price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Sell,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::GTC,
        )
    }

    fn buy_market(trader: &str, qty: f64) -> Order {
        Order::new_market(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Buy,
            Quantity::from_f64(qty),
        )
    }

    fn sell_market(trader: &str, qty: f64) -> Order {
        Order::new_market(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Sell,
            Quantity::from_f64(qty),
        )
    }

    fn buy_ioc(trader: &str, price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Buy,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::IOC,
        )
    }

    fn buy_fok(trader: &str, price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Buy,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::FOK,
        )
    }

    fn buy_post_only(trader: &str, price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            trader.to_string(),
            Side::Buy,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::PostOnly,
        )
    }

    // ============================================================
    //                BASIC LIMIT ORDER TESTS
    // ============================================================

    #[test]
    fn test_limit_buy_no_match_rests_on_book() {
        let mut eng = engine();
        let result = eng.submit_order(buy_limit("0xAlice", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Open);
        assert_eq!(result.trades.len(), 0);
        assert_eq!(result.remaining, Quantity::from_f64(1.0));
        assert_eq!(eng.book.best_bid(), Some(Price::from_f64(50_000.0)));
    }

    #[test]
    fn test_limit_sell_no_match_rests_on_book() {
        let mut eng = engine();
        let result = eng.submit_order(sell_limit("0xBob", 51_000.0, 2.0));

        assert_eq!(result.status, OrderStatus::Open);
        assert_eq!(result.trades.len(), 0);
        assert_eq!(eng.book.best_ask(), Some(Price::from_f64(51_000.0)));
    }

    #[test]
    fn test_exact_match_buy_into_sell() {
        let mut eng = engine();

        // Place sell at 50k
        eng.submit_order(sell_limit("0xBob", 50_000.0, 1.0));

        // Buy at 50k should match
        let result = eng.submit_order(buy_limit("0xAlice", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.remaining, Quantity::ZERO);

        let trade = &result.trades[0];
        assert_eq!(trade.price, Price::from_f64(50_000.0));
        assert_eq!(trade.quantity, Quantity::from_f64(1.0));
        assert_eq!(trade.maker_side, Side::Sell);
        assert_eq!(trade.taker_side, Side::Buy);

        // Book should be empty
        assert!(eng.book.best_bid().is_none());
        assert!(eng.book.best_ask().is_none());
    }

    #[test]
    fn test_exact_match_sell_into_buy() {
        let mut eng = engine();

        eng.submit_order(buy_limit("0xAlice", 50_000.0, 1.0));
        let result = eng.submit_order(sell_limit("0xBob", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
        assert!(eng.book.best_bid().is_none());
    }

    #[test]
    fn test_partial_fill_taker_larger() {
        let mut eng = engine();

        // Maker sells 0.5 BTC
        eng.submit_order(sell_limit("0xBob", 50_000.0, 0.5));

        // Taker buys 1.0 BTC - only 0.5 gets filled
        let result = eng.submit_order(buy_limit("0xAlice", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::PartiallyFilled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].quantity, Quantity::from_f64(0.5));
        assert_eq!(result.remaining, Quantity::from_f64(0.5));

        // Remaining 0.5 should be on book as bid
        assert_eq!(eng.book.best_bid(), Some(Price::from_f64(50_000.0)));
        assert!(eng.book.best_ask().is_none());
    }

    #[test]
    fn test_partial_fill_taker_smaller() {
        let mut eng = engine();

        // Maker sells 2.0 BTC
        eng.submit_order(sell_limit("0xBob", 50_000.0, 2.0));

        // Taker buys 0.5 BTC
        let result = eng.submit_order(buy_limit("0xAlice", 50_000.0, 0.5));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].quantity, Quantity::from_f64(0.5));

        // Maker should have 1.5 remaining on book
        let ask = eng.book.peek_best_ask().unwrap();
        assert_eq!(ask.remaining, Quantity::from_f64(1.5));
    }

    // ============================================================
    //           PRICE-TIME PRIORITY TESTS
    // ============================================================

    #[test]
    fn test_price_priority_buy_gets_best_ask() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller1", 51_000.0, 1.0));
        eng.submit_order(sell_limit("0xSeller2", 50_000.0, 1.0)); // better price
        eng.submit_order(sell_limit("0xSeller3", 52_000.0, 1.0));

        let result = eng.submit_order(buy_limit("0xBuyer", 52_000.0, 1.0));

        // Should match at 50,000 (best ask)
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].price, Price::from_f64(50_000.0));
        assert_eq!(result.trades[0].maker_trader, "0xSeller2");
    }

    #[test]
    fn test_time_priority_fifo() {
        let mut eng = engine();

        // Two sells at same price - first should get matched first
        let sell1 = sell_limit("0xSeller1", 50_000.0, 1.0);
        let sell2 = sell_limit("0xSeller2", 50_000.0, 1.0);

        eng.submit_order(sell1);
        eng.submit_order(sell2);

        let result = eng.submit_order(buy_limit("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.trades[0].maker_trader, "0xSeller1"); // FIFO
    }

    #[test]
    fn test_multi_level_matching() {
        let mut eng = engine();

        // Multiple price levels
        eng.submit_order(sell_limit("0xS1", 50_000.0, 0.5));
        eng.submit_order(sell_limit("0xS2", 50_100.0, 0.5));
        eng.submit_order(sell_limit("0xS3", 50_200.0, 0.5));

        // Buy sweeps through multiple levels
        let result = eng.submit_order(buy_limit("0xBuyer", 50_200.0, 1.2));

        assert_eq!(result.trades.len(), 3);
        assert_eq!(result.trades[0].price, Price::from_f64(50_000.0));
        assert_eq!(result.trades[0].quantity, Quantity::from_f64(0.5));
        assert_eq!(result.trades[1].price, Price::from_f64(50_100.0));
        assert_eq!(result.trades[1].quantity, Quantity::from_f64(0.5));
        assert_eq!(result.trades[2].price, Price::from_f64(50_200.0));
        assert_eq!(result.trades[2].quantity, Quantity::from_f64(0.2));

        // 0.3 remaining at 50,200 should still be on the book
        assert_eq!(eng.book.best_ask(), Some(Price::from_f64(50_200.0)));
    }

    // ============================================================
    //              MARKET ORDER TESTS
    // ============================================================

    #[test]
    fn test_market_buy() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 1.0));
        let result = eng.submit_order(buy_market("0xBuyer", 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].price, Price::from_f64(50_000.0));
    }

    #[test]
    fn test_market_buy_no_liquidity() {
        let mut eng = engine();

        // Market buy with no asks - should be cancelled (IOC)
        let result = eng.submit_order(buy_market("0xBuyer", 1.0));

        assert_eq!(result.status, OrderStatus::Cancelled);
        assert_eq!(result.trades.len(), 0);
    }

    #[test]
    fn test_market_buy_partial_liquidity() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 0.5));
        let result = eng.submit_order(buy_market("0xBuyer", 1.0));

        // Market orders are IOC, so partially filled then cancelled
        assert_eq!(result.status, OrderStatus::Cancelled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].quantity, Quantity::from_f64(0.5));
    }

    #[test]
    fn test_market_sell() {
        let mut eng = engine();

        eng.submit_order(buy_limit("0xBuyer", 50_000.0, 1.0));
        let result = eng.submit_order(sell_market("0xSeller", 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
    }

    // ============================================================
    //                IOC / FOK / POST-ONLY
    // ============================================================

    #[test]
    fn test_ioc_partial_fill_cancels_rest() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 0.3));
        let result = eng.submit_order(buy_ioc("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Cancelled);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].quantity, Quantity::from_f64(0.3));
        // Should NOT be on the book
        assert!(eng.book.best_bid().is_none());
    }

    #[test]
    fn test_ioc_full_fill() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 1.0));
        let result = eng.submit_order(buy_ioc("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
    }

    #[test]
    fn test_fok_all_or_nothing_success() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 1.0));
        let result = eng.submit_order(buy_fok("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Filled);
        assert_eq!(result.trades.len(), 1);
    }

    #[test]
    fn test_fok_insufficient_liquidity_cancels() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 0.5));
        let result = eng.submit_order(buy_fok("0xBuyer", 50_000.0, 1.0));

        // FOK: not enough liquidity, so nothing executes
        assert_eq!(result.status, OrderStatus::Cancelled);
        assert_eq!(result.trades.len(), 0);

        // Maker should still be on the book untouched
        assert_eq!(eng.book.best_ask(), Some(Price::from_f64(50_000.0)));
        let ask = eng.book.peek_best_ask().unwrap();
        assert_eq!(ask.remaining, Quantity::from_f64(0.5));
    }

    #[test]
    fn test_post_only_rejected_when_would_match() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 50_000.0, 1.0));

        // PostOnly buy at 50k would match -> rejected
        let result = eng.submit_order(buy_post_only("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Rejected);
        assert_eq!(result.trades.len(), 0);

        // Maker untouched
        assert_eq!(eng.book.best_ask(), Some(Price::from_f64(50_000.0)));
    }

    #[test]
    fn test_post_only_accepted_when_no_match() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xSeller", 51_000.0, 1.0));

        // PostOnly buy at 50k won't match -> goes to book
        let result = eng.submit_order(buy_post_only("0xBuyer", 50_000.0, 1.0));

        assert_eq!(result.status, OrderStatus::Open);
        assert_eq!(result.trades.len(), 0);
        assert_eq!(eng.book.best_bid(), Some(Price::from_f64(50_000.0)));
    }

    // ============================================================
    //                   CANCEL TESTS
    // ============================================================

    #[test]
    fn test_cancel_existing_order() {
        let mut eng = engine();
        let result = eng.submit_order(buy_limit("0xAlice", 50_000.0, 1.0));
        let order_id = result.order_id;

        let cancelled = eng.cancel_order(&order_id);
        assert!(cancelled.is_some());
        assert_eq!(cancelled.unwrap().status, OrderStatus::Cancelled);
        assert!(eng.book.best_bid().is_none());
    }

    #[test]
    fn test_cancel_nonexistent() {
        let mut eng = engine();
        let result = eng.cancel_order(&OrderId::new());
        assert!(result.is_none());
    }

    // ============================================================
    //                   FEE TESTS
    // ============================================================

    #[test]
    fn test_fees_calculated_correctly() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xMaker", 50_000.0, 1.0));
        let result = eng.submit_order(buy_limit("0xTaker", 50_000.0, 1.0));

        let trade = &result.trades[0];

        // Notional: 50,000 * 1.0 = 50,000 USDC = 50_000_000_000 in 6 decimals
        // Maker fee: 50,000 * 0.02% = 10 USDC = 10_000_000
        // Taker fee: 50,000 * 0.06% = 30 USDC = 30_000_000
        assert_eq!(trade.maker_fee, 10_000_000); // $10
        assert_eq!(trade.taker_fee, 30_000_000); // $30
    }

    // ============================================================
    //                 VALIDATION TESTS
    // ============================================================

    #[test]
    fn test_reject_zero_quantity() {
        let mut eng = engine();
        let mut order = buy_limit("0xAlice", 50_000.0, 1.0);
        order.quantity = Quantity::ZERO;
        order.remaining = Quantity::ZERO;

        let result = eng.submit_order(order);
        assert_eq!(result.status, OrderStatus::Rejected);
    }

    #[test]
    fn test_reject_limit_zero_price() {
        let mut eng = engine();
        let mut order = buy_limit("0xAlice", 50_000.0, 1.0);
        order.price = Price::ZERO;

        let result = eng.submit_order(order);
        assert_eq!(result.status, OrderStatus::Rejected);
    }

    // ============================================================
    //                COMPLEX SCENARIOS
    // ============================================================

    #[test]
    fn test_multiple_trades_sequence() {
        let mut eng = engine();

        // Build up the book
        eng.submit_order(sell_limit("0xS1", 50_100.0, 1.0));
        eng.submit_order(sell_limit("0xS2", 50_200.0, 1.0));
        eng.submit_order(buy_limit("0xB1", 49_900.0, 1.0));
        eng.submit_order(buy_limit("0xB2", 49_800.0, 1.0));

        assert_eq!(eng.book.active_order_count(), 4);
        assert_eq!(eng.book.best_bid(), Some(Price::from_f64(49_900.0)));
        assert_eq!(eng.book.best_ask(), Some(Price::from_f64(50_100.0)));

        // Aggressive buy sweeps both asks
        let result = eng.submit_order(buy_limit("0xAggBuyer", 50_200.0, 2.0));
        assert_eq!(result.trades.len(), 2);
        assert_eq!(result.status, OrderStatus::Filled);

        // Only bids remain
        assert_eq!(eng.book.active_order_count(), 2);
        assert!(eng.book.best_ask().is_none());
        assert_eq!(eng.book.best_bid(), Some(Price::from_f64(49_900.0)));
    }

    #[test]
    fn test_orderbook_display_after_activity() {
        let mut eng = engine();

        eng.submit_order(sell_limit("0xS1", 50_100.0, 1.0));
        eng.submit_order(sell_limit("0xS2", 50_200.0, 2.0));
        eng.submit_order(buy_limit("0xB1", 49_900.0, 1.5));
        eng.submit_order(buy_limit("0xB2", 49_800.0, 3.0));

        let display = format!("{}", eng.book);
        assert!(display.contains("BTC-USD"));
        println!("{}", display);
    }
}
