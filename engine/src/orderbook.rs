use std::collections::{BTreeMap, HashMap, VecDeque};
use std::cmp::Reverse;

use crate::types::*;

// ============================================================
//                     PRICE LEVEL
// ============================================================

/// A single price level in the orderbook.
/// Contains a FIFO queue of orders at the same price.
#[derive(Debug, Clone)]
pub struct PriceLevel {
    pub price: Price,
    pub orders: VecDeque<Order>,
    pub total_quantity: Quantity,
    pub visible_quantity: Quantity,  // excludes hidden orders
}

impl PriceLevel {
    pub fn new(price: Price) -> Self {
        PriceLevel {
            price,
            orders: VecDeque::new(),
            total_quantity: Quantity::ZERO,
            visible_quantity: Quantity::ZERO,
        }
    }

    /// Add an order to the back of this price level (FIFO)
    pub fn add_order(&mut self, order: Order) {
        self.total_quantity += order.remaining;
        if !order.hidden {
            self.visible_quantity += order.remaining;
        }
        self.orders.push_back(order);
    }

    /// Remove the front order (oldest at this price)
    pub fn pop_front(&mut self) -> Option<Order> {
        if let Some(order) = self.orders.pop_front() {
            self.total_quantity = self.total_quantity.saturating_sub(order.remaining);
            if !order.hidden {
                self.visible_quantity = self.visible_quantity.saturating_sub(order.remaining);
            }
            Some(order)
        } else {
            None
        }
    }

    /// Peek at the front order without removing
    pub fn front(&self) -> Option<&Order> {
        self.orders.front()
    }

    /// Peek mutable at the front order
    pub fn front_mut(&mut self) -> Option<&mut Order> {
        self.orders.front_mut()
    }

    pub fn is_empty(&self) -> bool {
        self.orders.is_empty()
    }

    pub fn len(&self) -> usize {
        self.orders.len()
    }

    /// Remove a specific order by ID, returns it if found
    pub fn remove_order(&mut self, order_id: &OrderId) -> Option<Order> {
        if let Some(pos) = self.orders.iter().position(|o| o.id == *order_id) {
            let order = self.orders.remove(pos)?;
            self.total_quantity = self.total_quantity.saturating_sub(order.remaining);
            if !order.hidden {
                self.visible_quantity = self.visible_quantity.saturating_sub(order.remaining);
            }
            Some(order)
        } else {
            None
        }
    }

    /// Recalculate total and visible quantity (use after modifying orders in place)
    pub fn recalculate_total(&mut self) {
        self.total_quantity = self.orders.iter().fold(Quantity::ZERO, |acc, o| acc + o.remaining);
        self.visible_quantity = self.orders.iter()
            .filter(|o| !o.hidden)
            .fold(Quantity::ZERO, |acc, o| acc + o.remaining);
    }
}

// ============================================================
//                      ORDERBOOK
// ============================================================

/// A full orderbook for a single market.
///
/// Bids (buy orders): sorted by price DESCENDING (highest bid first)
/// Asks (sell orders): sorted by price ASCENDING (lowest ask first)
///
/// Within each price level, orders are FIFO (first in, first out).
///
/// This gives us price-time priority matching:
/// 1. Best price first
/// 2. Earliest order first (at same price)
#[derive(Debug)]
pub struct OrderBook {
    pub market: MarketId,
    pub config: MarketConfig,

    /// Buy orders: Reverse<Price> gives us descending order in BTreeMap
    pub(crate) bids: BTreeMap<Reverse<Price>, PriceLevel>,

    /// Sell orders: natural ascending order in BTreeMap
    pub(crate) asks: BTreeMap<Price, PriceLevel>,

    /// Quick lookup: order_id -> (side, price) for O(1) cancellation
    order_index: HashMap<OrderId, (Side, Price)>,

    /// Statistics
    pub trade_count: u64,
    pub order_count: u64,
}

impl OrderBook {
    pub fn new(config: MarketConfig) -> Self {
        let market = config.id.clone();
        OrderBook {
            market,
            config,
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            order_index: HashMap::new(),
            trade_count: 0,
            order_count: 0,
        }
    }

    // ============================================================
    //                    BOOK QUERIES
    // ============================================================

    /// Best bid price (highest buy order)
    pub fn best_bid(&self) -> Option<Price> {
        self.bids.iter().next().map(|(Reverse(p), _)| *p)
    }

    /// Best ask price (lowest sell order)
    pub fn best_ask(&self) -> Option<Price> {
        self.asks.iter().next().map(|(p, _)| *p)
    }

    /// Spread between best bid and best ask
    pub fn spread(&self) -> Option<(Price, Price, u64)> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) if ask > bid => {
                Some((bid, ask, ask.0 - bid.0))
            }
            (Some(bid), Some(ask)) => Some((bid, ask, 0)),
            _ => None,
        }
    }

    /// Mid price: (best_bid + best_ask) / 2
    pub fn mid_price(&self) -> Option<Price> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => Some(Price((bid.0 + ask.0) / 2)),
            _ => None,
        }
    }

    /// Total number of active orders
    pub fn active_order_count(&self) -> usize {
        self.order_index.len()
    }

    /// Total bid depth (quantity)
    pub fn total_bid_depth(&self) -> Quantity {
        self.bids.values().fold(Quantity::ZERO, |acc, lvl| acc + lvl.total_quantity)
    }

    /// Total ask depth (quantity)
    pub fn total_ask_depth(&self) -> Quantity {
        self.asks.values().fold(Quantity::ZERO, |acc, lvl| acc + lvl.total_quantity)
    }

    /// Get top N bid levels (for orderbook display — hidden orders excluded)
    pub fn top_bids(&self, n: usize) -> Vec<(Price, Quantity, usize)> {
        self.bids
            .iter()
            .filter(|(_, level)| !level.visible_quantity.is_zero())
            .take(n)
            .map(|(Reverse(price), level)| (*price, level.visible_quantity, level.orders.iter().filter(|o| !o.hidden).count()))
            .collect()
    }

    /// Get top N ask levels (hidden orders excluded from display)
    pub fn top_asks(&self, n: usize) -> Vec<(Price, Quantity, usize)> {
        self.asks
            .iter()
            .filter(|(_, level)| !level.visible_quantity.is_zero())
            .take(n)
            .map(|(price, level)| (*price, level.visible_quantity, level.orders.iter().filter(|o| !o.hidden).count()))
            .collect()
    }

    /// Check if an order exists
    pub fn has_order(&self, order_id: &OrderId) -> bool {
        self.order_index.contains_key(order_id)
    }

    // ============================================================
    //                   ORDER MANAGEMENT
    // ============================================================

    /// Place an order on the book (after matching has been attempted)
    pub fn place_order(&mut self, order: Order) {
        let side = order.side;
        let price = order.price;
        let order_id = order.id;

        match side {
            Side::Buy => {
                self.bids
                    .entry(Reverse(price))
                    .or_insert_with(|| PriceLevel::new(price))
                    .add_order(order);
            }
            Side::Sell => {
                self.asks
                    .entry(price)
                    .or_insert_with(|| PriceLevel::new(price))
                    .add_order(order);
            }
        }

        self.order_index.insert(order_id, (side, price));
        self.order_count += 1;
    }

    /// Cancel an order by ID. Returns the cancelled order if found.
    pub fn cancel_order(&mut self, order_id: &OrderId) -> Option<Order> {
        let (side, price) = self.order_index.remove(order_id)?;

        let order = match side {
            Side::Buy => {
                let level = self.bids.get_mut(&Reverse(price))?;
                let order = level.remove_order(order_id)?;
                if level.is_empty() {
                    self.bids.remove(&Reverse(price));
                }
                order
            }
            Side::Sell => {
                let level = self.asks.get_mut(&price)?;
                let order = level.remove_order(order_id)?;
                if level.is_empty() {
                    self.asks.remove(&price);
                }
                order
            }
        };

        Some(order)
    }

    /// Get the front order on the bid side (best bid, oldest)
    pub fn peek_best_bid(&self) -> Option<&Order> {
        self.bids.iter().next().and_then(|(_, level)| level.front())
    }

    /// Get the front order on the ask side (best ask, oldest)
    pub fn peek_best_ask(&self) -> Option<&Order> {
        self.asks.iter().next().and_then(|(_, level)| level.front())
    }

    /// Pop the best bid order (removes from book)
    pub fn pop_best_bid(&mut self) -> Option<Order> {
        let best_price = self.bids.iter().next().map(|(k, _)| *k)?;

        let level = self.bids.get_mut(&best_price)?;
        let order = level.pop_front()?;
        self.order_index.remove(&order.id);

        if level.is_empty() {
            self.bids.remove(&best_price);
        }

        Some(order)
    }

    /// Pop the best ask order (removes from book)
    pub fn pop_best_ask(&mut self) -> Option<Order> {
        let best_price = *self.asks.iter().next().map(|(k, _)| k)?;

        let level = self.asks.get_mut(&best_price)?;
        let order = level.pop_front()?;
        self.order_index.remove(&order.id);

        if level.is_empty() {
            self.asks.remove(&best_price);
        }

        Some(order)
    }

    /// Update the remaining quantity of the best bid's front order.
    /// If fully filled, removes it from the book.
    /// Returns the order if it was removed.
    pub fn fill_best_bid(&mut self, filled_qty: Quantity) -> Option<Order> {
        let best_price = *self.bids.iter().next().map(|(k, _)| k)?;
        let level = self.bids.get_mut(&best_price)?;
        let front = level.front_mut()?;

        front.remaining = front.remaining.saturating_sub(filled_qty);
        front.updated_at = chrono::Utc::now();
        level.total_quantity = level.total_quantity.saturating_sub(filled_qty);

        if front.remaining.is_zero() {
            let mut order = level.pop_front()?;
            order.status = OrderStatus::Filled;
            self.order_index.remove(&order.id);

            if level.is_empty() {
                self.bids.remove(&best_price);
            }

            Some(order)
        } else {
            let front = level.front_mut()?;
            front.status = OrderStatus::PartiallyFilled;
            None
        }
    }

    /// Update the remaining quantity of the best ask's front order.
    pub fn fill_best_ask(&mut self, filled_qty: Quantity) -> Option<Order> {
        let best_price = *self.asks.iter().next().map(|(k, _)| k)?;
        let level = self.asks.get_mut(&best_price)?;
        let front = level.front_mut()?;

        front.remaining = front.remaining.saturating_sub(filled_qty);
        front.updated_at = chrono::Utc::now();
        level.total_quantity = level.total_quantity.saturating_sub(filled_qty);

        if front.remaining.is_zero() {
            let mut order = level.pop_front()?;
            order.status = OrderStatus::Filled;
            self.order_index.remove(&order.id);

            if level.is_empty() {
                self.asks.remove(&best_price);
            }

            Some(order)
        } else {
            let front = level.front_mut()?;
            front.status = OrderStatus::PartiallyFilled;
            None
        }
    }

    /// Number of price levels on each side
    pub fn depth(&self) -> (usize, usize) {
        (self.bids.len(), self.asks.len())
    }
}

// ============================================================
//                        DISPLAY
// ============================================================

impl std::fmt::Display for OrderBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "═══ {} OrderBook ═══", self.market)?;

        // Asks (reversed so highest is at top)
        let asks: Vec<_> = self.top_asks(10);
        for (price, qty, count) in asks.iter().rev() {
            writeln!(f, "  ASK  {:>14}  {:>14}  ({} orders)", price, qty, count)?;
        }

        // Spread
        if let Some((bid, ask, spread_raw)) = self.spread() {
            let spread_pct = if bid.0 > 0 {
                (spread_raw as f64 / bid.0 as f64) * 100.0
            } else {
                0.0
            };
            writeln!(f, "  ──── SPREAD: {} ({:.4}%) ────", Price(spread_raw), spread_pct)?;
        } else {
            writeln!(f, "  ──── NO SPREAD ────")?;
        }

        // Bids
        for (price, qty, count) in self.top_bids(10) {
            writeln!(f, "  BID  {:>14}  {:>14}  ({} orders)", price, qty, count)?;
        }

        writeln!(f, "═══ Orders: {} | Trades: {} ═══", self.active_order_count(), self.trade_count)?;
        Ok(())
    }
}

// ============================================================
//                        TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_book() -> OrderBook {
        OrderBook::new(MarketConfig::btc_usd_default())
    }

    fn buy_limit(price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            "0xAlice".to_string(),
            Side::Buy,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::GTC,
        )
    }

    fn sell_limit(price: f64, qty: f64) -> Order {
        Order::new_limit(
            MarketId::new("BTC", "USD"),
            "0xBob".to_string(),
            Side::Sell,
            Price::from_f64(price),
            Quantity::from_f64(qty),
            TimeInForce::GTC,
        )
    }

    #[test]
    fn test_empty_book() {
        let book = make_book();
        assert!(book.best_bid().is_none());
        assert!(book.best_ask().is_none());
        assert!(book.spread().is_none());
        assert_eq!(book.active_order_count(), 0);
    }

    #[test]
    fn test_place_bid() {
        let mut book = make_book();
        book.place_order(buy_limit(50_000.0, 1.0));

        assert_eq!(book.best_bid(), Some(Price::from_f64(50_000.0)));
        assert!(book.best_ask().is_none());
        assert_eq!(book.active_order_count(), 1);
    }

    #[test]
    fn test_place_ask() {
        let mut book = make_book();
        book.place_order(sell_limit(51_000.0, 2.0));

        assert!(book.best_bid().is_none());
        assert_eq!(book.best_ask(), Some(Price::from_f64(51_000.0)));
        assert_eq!(book.active_order_count(), 1);
    }

    #[test]
    fn test_best_bid_is_highest() {
        let mut book = make_book();
        book.place_order(buy_limit(49_000.0, 1.0));
        book.place_order(buy_limit(50_000.0, 1.0));
        book.place_order(buy_limit(48_000.0, 1.0));

        assert_eq!(book.best_bid(), Some(Price::from_f64(50_000.0)));
    }

    #[test]
    fn test_best_ask_is_lowest() {
        let mut book = make_book();
        book.place_order(sell_limit(52_000.0, 1.0));
        book.place_order(sell_limit(51_000.0, 1.0));
        book.place_order(sell_limit(53_000.0, 1.0));

        assert_eq!(book.best_ask(), Some(Price::from_f64(51_000.0)));
    }

    #[test]
    fn test_spread() {
        let mut book = make_book();
        book.place_order(buy_limit(50_000.0, 1.0));
        book.place_order(sell_limit(50_100.0, 1.0));

        let (bid, ask, spread) = book.spread().unwrap();
        assert_eq!(bid, Price::from_f64(50_000.0));
        assert_eq!(ask, Price::from_f64(50_100.0));
        assert_eq!(spread, Price::from_f64(100.0).0);
    }

    #[test]
    fn test_mid_price() {
        let mut book = make_book();
        book.place_order(buy_limit(50_000.0, 1.0));
        book.place_order(sell_limit(50_100.0, 1.0));

        let mid = book.mid_price().unwrap();
        assert_eq!(mid, Price::from_f64(50_050.0));
    }

    #[test]
    fn test_cancel_order() {
        let mut book = make_book();
        let order = buy_limit(50_000.0, 1.0);
        let id = order.id;

        book.place_order(order);
        assert_eq!(book.active_order_count(), 1);

        let cancelled = book.cancel_order(&id);
        assert!(cancelled.is_some());
        assert_eq!(book.active_order_count(), 0);
        assert!(book.best_bid().is_none());
    }

    #[test]
    fn test_cancel_nonexistent() {
        let mut book = make_book();
        let result = book.cancel_order(&OrderId::new());
        assert!(result.is_none());
    }

    #[test]
    fn test_fifo_within_price_level() {
        let mut book = make_book();
        let order1 = buy_limit(50_000.0, 1.0);
        let order2 = buy_limit(50_000.0, 2.0);
        let id1 = order1.id;

        book.place_order(order1);
        book.place_order(order2);

        // First order should be at the front
        let front = book.peek_best_bid().unwrap();
        assert_eq!(front.id, id1);
        assert_eq!(front.quantity, Quantity::from_f64(1.0));
    }

    #[test]
    fn test_pop_best_bid() {
        let mut book = make_book();
        let order1 = buy_limit(50_000.0, 1.0);
        let order2 = buy_limit(50_000.0, 2.0);
        let id1 = order1.id;
        let id2 = order2.id;

        book.place_order(order1);
        book.place_order(order2);

        let popped = book.pop_best_bid().unwrap();
        assert_eq!(popped.id, id1);
        assert_eq!(book.active_order_count(), 1);

        let popped2 = book.pop_best_bid().unwrap();
        assert_eq!(popped2.id, id2);
        assert_eq!(book.active_order_count(), 0);
    }

    #[test]
    fn test_fill_best_ask_partial() {
        let mut book = make_book();
        book.place_order(sell_limit(51_000.0, 2.0));

        // Partial fill
        let removed = book.fill_best_ask(Quantity::from_f64(0.5));
        assert!(removed.is_none()); // Not fully filled

        let front = book.peek_best_ask().unwrap();
        assert_eq!(front.remaining, Quantity::from_f64(1.5));
        assert_eq!(front.status, OrderStatus::PartiallyFilled);
    }

    #[test]
    fn test_fill_best_ask_complete() {
        let mut book = make_book();
        book.place_order(sell_limit(51_000.0, 1.0));

        let removed = book.fill_best_ask(Quantity::from_f64(1.0));
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().status, OrderStatus::Filled);
        assert!(book.best_ask().is_none());
    }

    #[test]
    fn test_top_bids_asks() {
        let mut book = make_book();
        book.place_order(buy_limit(49_000.0, 1.0));
        book.place_order(buy_limit(50_000.0, 2.0));
        book.place_order(sell_limit(51_000.0, 3.0));
        book.place_order(sell_limit(52_000.0, 4.0));

        let bids = book.top_bids(5);
        assert_eq!(bids.len(), 2);
        assert_eq!(bids[0].0, Price::from_f64(50_000.0)); // highest first

        let asks = book.top_asks(5);
        assert_eq!(asks.len(), 2);
        assert_eq!(asks[0].0, Price::from_f64(51_000.0)); // lowest first
    }

    #[test]
    fn test_total_depth() {
        let mut book = make_book();
        book.place_order(buy_limit(50_000.0, 1.0));
        book.place_order(buy_limit(49_000.0, 2.5));

        assert_eq!(book.total_bid_depth(), Quantity::from_f64(3.5));
        assert_eq!(book.total_ask_depth(), Quantity::ZERO);
    }

    #[test]
    fn test_display() {
        let mut book = make_book();
        book.place_order(buy_limit(50_000.0, 1.0));
        book.place_order(sell_limit(50_100.0, 0.5));

        let display = format!("{}", book);
        assert!(display.contains("BTC-USD"));
        assert!(display.contains("SPREAD"));
    }
}
