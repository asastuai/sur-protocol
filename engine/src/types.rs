use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

// ============================================================
//                     PRICE & QUANTITY
// ============================================================

/// Fixed-point price with 6 decimal places (matches USDC precision).
/// Example: 50_000_000_000 = $50,000.000000
/// Max representable: ~18,446,744,073,709 (~$18.4 trillion)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Price(pub u64);

/// Fixed-point quantity with 8 decimal places.
/// Example: 100_000_000 = 1.00000000 BTC
/// Allows sub-satoshi precision for other assets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Quantity(pub u64);

impl Price {
    pub const DECIMALS: u32 = 6;
    pub const SCALE: u64 = 10u64.pow(Self::DECIMALS);
    pub const ZERO: Price = Price(0);

    /// Create price from a float (for convenience in tests)
    pub fn from_f64(value: f64) -> Self {
        Price((value * Self::SCALE as f64) as u64)
    }

    /// Convert to f64 (for display only, NOT for calculations)
    pub fn to_f64(self) -> f64 {
        self.0 as f64 / Self::SCALE as f64
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }
}

impl Quantity {
    pub const DECIMALS: u32 = 8;
    pub const SCALE: u64 = 10u64.pow(Self::DECIMALS);
    pub const ZERO: Quantity = Quantity(0);

    pub fn from_f64(value: f64) -> Self {
        Quantity((value * Self::SCALE as f64) as u64)
    }

    pub fn to_f64(self) -> f64 {
        self.0 as f64 / Self::SCALE as f64
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn saturating_sub(self, other: Quantity) -> Quantity {
        Quantity(self.0.saturating_sub(other.0))
    }

    pub fn min(self, other: Quantity) -> Quantity {
        Quantity(self.0.min(other.0))
    }
}

impl std::ops::Sub for Quantity {
    type Output = Quantity;
    fn sub(self, rhs: Quantity) -> Quantity {
        Quantity(self.0 - rhs.0)
    }
}

impl std::ops::Add for Quantity {
    type Output = Quantity;
    fn add(self, rhs: Quantity) -> Quantity {
        Quantity(self.0 + rhs.0)
    }
}

impl std::ops::AddAssign for Quantity {
    fn add_assign(&mut self, rhs: Quantity) {
        self.0 += rhs.0;
    }
}

impl fmt::Display for Price {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${:.6}", self.to_f64())
    }
}

impl fmt::Display for Quantity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:.8}", self.to_f64())
    }
}

// ============================================================
//                       MARKET
// ============================================================

/// Trading pair identifier
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MarketId(pub String);

impl MarketId {
    pub fn new(base: &str, quote: &str) -> Self {
        MarketId(format!("{}-{}", base, quote))
    }
}

impl fmt::Display for MarketId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Market configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketConfig {
    pub id: MarketId,
    pub base_asset: String,       // e.g., "BTC"
    pub quote_asset: String,      // e.g., "USD"
    pub tick_size: Price,         // minimum price increment
    pub lot_size: Quantity,       // minimum quantity increment
    pub min_quantity: Quantity,   // minimum order size
    pub max_quantity: Quantity,   // maximum order size
    pub max_leverage: u32,       // e.g., 20 = 20x
    pub maker_fee_bps: u32,      // basis points (2 = 0.02%)
    pub taker_fee_bps: u32,      // basis points (6 = 0.06%)
}

impl MarketConfig {
    /// Create BTC-USD perp market with standard config
    pub fn btc_usd_default() -> Self {
        MarketConfig {
            id: MarketId::new("BTC", "USD"),
            base_asset: "BTC".to_string(),
            quote_asset: "USD".to_string(),
            tick_size: Price(100),              // $0.000100 = 0.01 cent
            lot_size: Quantity(1_000),          // 0.00001000 BTC
            min_quantity: Quantity(10_000),     // 0.00010000 BTC (~$5 at $50k)
            max_quantity: Quantity(1_000_000_000_000), // 10,000 BTC
            max_leverage: 20,
            maker_fee_bps: 2,                  // 0.02%
            taker_fee_bps: 6,                  // 0.06%
        }
    }

    /// Create ETH-USD perp market
    pub fn eth_usd_default() -> Self {
        MarketConfig {
            id: MarketId::new("ETH", "USD"),
            base_asset: "ETH".to_string(),
            quote_asset: "USD".to_string(),
            tick_size: Price(100),
            lot_size: Quantity(10_000),         // 0.00010000 ETH
            min_quantity: Quantity(100_000),    // 0.00100000 ETH (~$3 at $3k)
            max_quantity: Quantity(10_000_000_000_000), // 100,000 ETH
            max_leverage: 20,
            maker_fee_bps: 2,
            taker_fee_bps: 6,
        }
    }
}

// ============================================================
//                        ORDERS
// ============================================================

/// Order side
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Side::Buy => write!(f, "BUY"),
            Side::Sell => write!(f, "SELL"),
        }
    }
}

/// Order type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    /// Limit order: execute at specified price or better
    Limit,
    /// Market order: execute immediately at best available price
    Market,
}

/// Time-in-force policy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeInForce {
    /// Good-til-cancelled: stays on book until filled or cancelled
    GTC,
    /// Immediate-or-cancel: fill what you can, cancel the rest
    IOC,
    /// Fill-or-kill: fill entirely or cancel entirely
    FOK,
    /// Post-only: reject if would immediately match (makers only)
    PostOnly,
}

/// Order status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    /// Order is live on the book
    Open,
    /// Order has been partially filled
    PartiallyFilled,
    /// Order has been completely filled
    Filled,
    /// Order was cancelled by user
    Cancelled,
    /// Order was rejected (e.g., PostOnly that would match)
    Rejected,
    /// Order expired
    Expired,
}

/// Unique order identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OrderId(pub Uuid);

impl OrderId {
    pub fn new() -> Self {
        OrderId(Uuid::new_v4())
    }
}

impl fmt::Display for OrderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", &self.0.to_string()[..8])
    }
}

/// A trading order
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: OrderId,
    pub market: MarketId,
    pub trader: String,           // Ethereum address (0x...)
    pub side: Side,
    pub order_type: OrderType,
    pub price: Price,             // 0 for market orders
    pub quantity: Quantity,        // original quantity
    pub remaining: Quantity,       // unfilled quantity
    pub time_in_force: TimeInForce,
    pub status: OrderStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub hidden: bool,             // hidden orders don't appear in public orderbook
    // pub signature: String,      // EIP-712 signature (Phase 1)
}

impl Order {
    /// Create a new limit order
    pub fn new_limit(
        market: MarketId,
        trader: String,
        side: Side,
        price: Price,
        quantity: Quantity,
        tif: TimeInForce,
    ) -> Self {
        let now = Utc::now();
        Order {
            id: OrderId::new(),
            market,
            trader,
            side,
            order_type: OrderType::Limit,
            price,
            quantity,
            remaining: quantity,
            time_in_force: tif,
            status: OrderStatus::Open,
            created_at: now,
            updated_at: now,
            hidden: false,
        }
    }

    /// Create a new hidden limit order (invisible on the public orderbook)
    pub fn new_hidden_limit(
        market: MarketId,
        trader: String,
        side: Side,
        price: Price,
        quantity: Quantity,
        tif: TimeInForce,
    ) -> Self {
        let mut order = Self::new_limit(market, trader, side, price, quantity, tif);
        order.hidden = true;
        order
    }

    /// Create a new market order
    pub fn new_market(
        market: MarketId,
        trader: String,
        side: Side,
        quantity: Quantity,
    ) -> Self {
        let now = Utc::now();
        Order {
            id: OrderId::new(),
            market,
            trader,
            side,
            order_type: OrderType::Market,
            price: Price::ZERO,
            quantity,
            remaining: quantity,
            time_in_force: TimeInForce::IOC,
            status: OrderStatus::Open,
            created_at: now,
            updated_at: now,
            hidden: false,
        }
    }

    /// How much of this order has been filled
    pub fn filled_quantity(&self) -> Quantity {
        self.quantity - self.remaining
    }

    /// Is this order fully filled?
    pub fn is_filled(&self) -> bool {
        self.remaining.is_zero()
    }

    /// Is this order still active on the book?
    pub fn is_active(&self) -> bool {
        matches!(self.status, OrderStatus::Open | OrderStatus::PartiallyFilled)
    }

    /// Can this buy order match against the given ask price?
    pub fn can_match_at(&self, other_price: Price) -> bool {
        match self.order_type {
            OrderType::Market => true,
            OrderType::Limit => match self.side {
                Side::Buy => self.price >= other_price,   // willing to pay >= ask
                Side::Sell => self.price <= other_price,  // willing to sell <= bid
            },
        }
    }
}

impl fmt::Display for Order {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "[{}] {} {} {} @ {} (remaining: {}, status: {:?})",
            self.id, self.side, self.remaining, self.market, self.price, self.remaining, self.status
        )
    }
}

// ============================================================
//                        TRADES
// ============================================================

/// Unique trade identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TradeId(pub Uuid);

impl TradeId {
    pub fn new() -> Self {
        TradeId(Uuid::new_v4())
    }
}

/// A matched trade between maker and taker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: TradeId,
    pub market: MarketId,
    pub price: Price,              // execution price (always maker's price)
    pub quantity: Quantity,         // executed quantity
    pub maker_order_id: OrderId,
    pub taker_order_id: OrderId,
    pub maker_trader: String,
    pub taker_trader: String,
    pub maker_side: Side,          // maker's side
    pub taker_side: Side,          // taker's side
    pub maker_fee: u64,            // fee in USDC units (6 decimals)
    pub taker_fee: u64,
    pub timestamp: DateTime<Utc>,
}

impl Trade {
    /// Calculate the USDC notional value of this trade
    /// notional = price * quantity / (price_scale * qty_scale) * usdc_scale
    pub fn notional_usdc(&self) -> u64 {
        // price is 6 decimals, quantity is 8 decimals
        // notional in USDC (6 decimals) = price * quantity / 10^8
        ((self.price.0 as u128 * self.quantity.0 as u128) / Quantity::SCALE as u128) as u64
    }
}

impl fmt::Display for Trade {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Trade {} @ {} x {} | maker: {} ({}) | taker: {} ({})",
            self.market, self.price, self.quantity,
            &self.maker_trader[..8], self.maker_side,
            &self.taker_trader[..8], self.taker_side,
        )
    }
}

// ============================================================
//                    ENGINE EVENTS
// ============================================================

/// Events emitted by the matching engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EngineEvent {
    /// Order was accepted and placed on the book
    OrderPlaced {
        order_id: OrderId,
        market: MarketId,
        side: Side,
        price: Price,
        quantity: Quantity,
    },
    /// A trade was executed
    TradeExecuted(Trade),
    /// Order was cancelled
    OrderCancelled {
        order_id: OrderId,
        remaining: Quantity,
    },
    /// Order was rejected
    OrderRejected {
        order_id: OrderId,
        reason: String,
    },
    /// Order was fully filled (removed from book)
    OrderFilled {
        order_id: OrderId,
    },
}

// ============================================================
//                    RESULT TYPE
// ============================================================

/// Result of submitting an order to the engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResult {
    pub order_id: OrderId,
    pub status: OrderStatus,
    pub trades: Vec<Trade>,
    pub events: Vec<EngineEvent>,
    pub remaining: Quantity,
}

// ============================================================
//                      TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_from_f64() {
        let price = Price::from_f64(50_000.50);
        assert_eq!(price.0, 50_000_500_000);
        assert!((price.to_f64() - 50_000.50).abs() < 0.000001);
    }

    #[test]
    fn test_quantity_from_f64() {
        let qty = Quantity::from_f64(1.5);
        assert_eq!(qty.0, 150_000_000);
        assert!((qty.to_f64() - 1.5).abs() < 0.00000001);
    }

    #[test]
    fn test_price_ordering() {
        let p1 = Price::from_f64(100.0);
        let p2 = Price::from_f64(200.0);
        assert!(p1 < p2);
    }

    #[test]
    fn test_order_creation() {
        let order = Order::new_limit(
            MarketId::new("BTC", "USD"),
            "0xAlice".to_string(),
            Side::Buy,
            Price::from_f64(50_000.0),
            Quantity::from_f64(1.0),
            TimeInForce::GTC,
        );

        assert_eq!(order.side, Side::Buy);
        assert_eq!(order.remaining, order.quantity);
        assert_eq!(order.status, OrderStatus::Open);
        assert!(order.is_active());
        assert!(!order.is_filled());
    }

    #[test]
    fn test_market_order_is_ioc() {
        let order = Order::new_market(
            MarketId::new("BTC", "USD"),
            "0xBob".to_string(),
            Side::Sell,
            Quantity::from_f64(0.5),
        );

        assert_eq!(order.time_in_force, TimeInForce::IOC);
        assert_eq!(order.price, Price::ZERO);
    }

    #[test]
    fn test_can_match_buy_limit() {
        let buy = Order::new_limit(
            MarketId::new("BTC", "USD"),
            "0xAlice".to_string(),
            Side::Buy,
            Price::from_f64(50_000.0),
            Quantity::from_f64(1.0),
            TimeInForce::GTC,
        );

        // Buy at 50k can match against ask at 49k (better price)
        assert!(buy.can_match_at(Price::from_f64(49_000.0)));
        // Buy at 50k can match against ask at 50k (equal)
        assert!(buy.can_match_at(Price::from_f64(50_000.0)));
        // Buy at 50k CANNOT match against ask at 51k (too expensive)
        assert!(!buy.can_match_at(Price::from_f64(51_000.0)));
    }

    #[test]
    fn test_trade_notional() {
        let trade = Trade {
            id: TradeId::new(),
            market: MarketId::new("BTC", "USD"),
            price: Price::from_f64(50_000.0),
            quantity: Quantity::from_f64(2.0),
            maker_order_id: OrderId::new(),
            taker_order_id: OrderId::new(),
            maker_trader: "0xMaker".to_string(),
            taker_trader: "0xTaker".to_string(),
            maker_side: Side::Sell,
            taker_side: Side::Buy,
            maker_fee: 0,
            taker_fee: 0,
            timestamp: Utc::now(),
        };

        // 50,000 * 2.0 = 100,000 USDC = 100_000_000_000 in 6 decimals
        assert_eq!(trade.notional_usdc(), 100_000_000_000);
    }

    #[test]
    fn test_market_config_btc() {
        let config = MarketConfig::btc_usd_default();
        assert_eq!(config.id.0, "BTC-USD");
        assert_eq!(config.max_leverage, 20);
        assert_eq!(config.maker_fee_bps, 2);
        assert_eq!(config.taker_fee_bps, 6);
    }
}
