# SUR Protocol — Technical Overview & Accomplishments

> **Decentralized Perpetual Futures Exchange on Base L2**
> Built for speed, security, and institutional-grade reliability.

---

## Executive Summary

SUR Protocol is a fully on-chain perpetual futures DEX deployed on Base (Coinbase's L2). It enables traders to open leveraged long/short positions on BTC, ETH, and other assets with up to 20x leverage — all non-custodial, transparent, and censorship-resistant.

The protocol has been built from the ground up: smart contracts, backend infrastructure, oracle system, liquidation engine, and a professional trading interface — all by a single engineering team in under 3 months.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                     │
│         Vercel · Real-time charts · Paper trading         │
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket (EIP-712 auth)
┌────────────────────────▼────────────────────────────────┐
│                   API / Order Engine                      │
│     Rate limiting · CORS · Input validation · Prometheus  │
└──┬──────────┬──────────┬──────────┬─────────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│Oracle│ │Liquidat│ │Funding │ │ Supabase │
│Keeper│ │  Keeper│ │  Bot   │ │    DB    │
└──┬───┘ └───┬────┘ └───┬────┘ └──────────┘
   │         │          │
   ▼         ▼          ▼
┌─────────────────────────────────────────────────────────┐
│              Smart Contracts (Solidity 0.8.28)            │
│  PerpVault · PerpEngine · OrderSettlement · Liquidator    │
│  InsuranceFund · OracleRouter · SurTimelock               │
│              Base L2 (Chain ID 8453)                      │
└─────────────────────────────────────────────────────────┘
```

---

## Smart Contracts (7 Core Contracts)

| Contract | Purpose |
|----------|---------|
| **PerpVault** | Holds trader collateral (USDC). Deposit/withdraw with accounting. |
| **PerpEngine** | Core trading engine. Manages positions, margin, PnL, funding. Circuit breaker built-in. |
| **OrderSettlement** | Matches and settles orders on-chain. Validates signatures and margin. |
| **Liquidator** | Liquidates undercollateralized positions. Rewards keepers. |
| **InsuranceFund** | Backstop for socialized losses. Auto-replenished from fees. |
| **OracleRouter** | Pyth Network price feeds with staleness checks and multi-source support. |
| **SurTimelock** | 48-hour timelock for admin operations. Guardian emergency pause. Self-governing. |

### Contract Security Features

- **Pause mechanism** on 7/7 contracts — emergency halt in seconds
- **Circuit breakers** — automatic trading halt on extreme price moves
- **2-step ownership transfer** — prevents accidental ownership loss
- **Timelock (48h)** — all admin changes are publicly visible before execution
- **Gnosis Safe multisig** — no single point of failure for protocol control
- **Immutable core logic** — PerpEngine and OrderSettlement have constructor-set owners (cannot be changed post-deploy)

### Test Coverage

- **302 Foundry tests** passing (unit + integration + stress + adversarial)
- **13 adversarial chaos tests** (+1000 fuzz) — flash crashes, dust rounding attacks, 500 simultaneous positions, insurance depletion, cross-margin cascades
- **1 load test** — 100 DAU full day simulation (72 trades, 62 liquidations, vault solvency exact)
- **9 liquidation stress tests** — cascade scenarios, 50x leverage, oscillating prices, batch liquidations
- **4 invariant tests** — 256 runs x 50 depth per property (vault solvency, conservation, no-negatives, health)

---

## Backend Infrastructure (4 Services)

### API / WebSocket Server
- WebSocket-based order engine with **EIP-712 signature authentication**
- **Rate limiting**: 10 msg/sec per client, 200 max connections, 64KB message limit
- **CORS whitelist** — configurable allowed origins (no wildcard)
- **Input validation** on all order fields (address, market, side, size, signature, expiry)
- **Private key validation** on startup — prevents misconfiguration
- Health endpoint with JSON stats

### Oracle Keeper
- Pushes **Pyth Network** prices on-chain every 5 seconds
- **Hermes failover** — sequential fallback across multiple endpoints
- **10-second timeout** per request with automatic recovery
- Staleness detection and alerting

### Liquidation Keeper
- Scans positions continuously for undercollateralized accounts
- **RPC retry with exponential backoff** — survives temporary outages
- **Transaction receipt validation** — confirms on-chain success
- Settlement batch re-queue limit (max 3 retries, then drop with error)

### Funding Bot
- Calculates and applies funding rates every 8 hours
- **Binance reference comparison** — validates rates against centralized exchange
- **OI imbalance detection** with extreme rate warnings
- Receipt status checking — skips on revert

### Cross-Service Features

- **Multi-RPC fallback** — `viem fallback()` with auto-ranking across all services
- **Prometheus metrics** — `/metrics` endpoint on every service (API :3002, Keeper :3010, Oracle :3011, Funding :3012)
- **Health checks** — HTTP health server on each service with JSON stats
- **Supabase retry** — `dbRetry()` with exponential backoff (2 retries) for all DB operations

### Backend Test Coverage

| Service | Tests |
|---------|-------|
| API | 48 |
| Keeper | 19 |
| Oracle | 31 |
| Funding | 21 |
| **Total** | **119 tests, all passing** |

Plus: WebSocket load test (100 concurrent connections with auth + order throughput, p95/avg latency reporting).

---

## Frontend (Next.js 14 + App Router)

### Trading Interface
- **Real-time orderbook** with depth visualization
- **TradingView-style charts** via lightweight-charts (dynamic import for performance)
- **5 order types**: Market, Limit, Stop Market, Stop Limit, OCO (One-Cancels-Other)
- **Inline TP/SL editing** — click to modify take-profit/stop-loss on open positions
- **Paper trading engine** — full simulation with positions, PnL, margin tracking
- **Real Binance funding rates** — fetched every 30s, displayed with estimated cost per 8h

### Performance
- **Zustand state management** — migrated from Context+useReducer for optimized per-slice subscriptions
- **Code splitting** — App Router auto-splits pages, charts loaded via dynamic `import()`
- **Web Worker** for backtester Monte Carlo simulations
- **React.memo + useMemo** on expensive components (Chart, OrderPanel, PositionsPanel)

### UI/UX
- **Dark & light mode** — CSS variable theming, flash-free via inline `<head>` script, persisted to localStorage
- **Fully responsive** — tabbed mobile trading view, hamburger navigation, horizontal-scroll tables
- **Shared component library** — Button (6 variants, 4 sizes), Input (label/suffix/error), Modal (focus trap, ESC close)
- **Loading skeletons** — shimmer placeholders while data loads
- **Keyboard shortcuts** — B/S (side), M/L (type), 1-4 (size %), Enter (submit), ? (help overlay)

### Portfolio & Risk Management
- **Risk dashboard** — margin utilization bar, account leverage, long/short/net exposure, margin level, concentration %
- **Color-coded warnings** — green/yellow/red thresholds for margin health
- **Position management** — real-time PnL, editable TP/SL, one-click close

### Accessibility (WCAG Compliance)
- Skip-to-content link
- `aria-labels` on all icon buttons
- `aria-expanded` on menus and dropdowns
- Focus trap in modals (Tab/Shift+Tab cycles)
- `role="dialog"`, `role="region"`, `role="list"` where appropriate
- `htmlFor` on all form inputs
- Keyboard-accessible checkboxes and toggles

### Additional Pages
- **Backtester** — Monte Carlo strategy simulation with 5m/15m/1h/4h candle resolution
- **Agents** — AI trading agent marketplace
- **Vaults** — Yield strategies
- **Copy Trading** — Mirror top traders
- **Leaderboard** — Trader rankings
- **Developers** — Agent SDK, API & MCP documentation

---

## Security Posture

### Operational Security
- **5 separate wallets** for different roles (deployer, operator, keeper, oracle, guardian)
- **Gnosis Safe multisig** — protocol ownership behind multi-signature wallet
- **48-hour timelock** — all admin operations publicly visible before execution
- **Guardian key** — emergency-only pause capability (cannot upgrade or withdraw)

### Smart Contract Security
- **Internal audit complete** — 69 findings (7 critical, 16 high), ALL fixed
- Pause mechanism on all contracts
- Circuit breakers for extreme market conditions (engine + oracle)
- EIP-1153 transient storage reentrancy protection
- Integer overflow protection (Solidity 0.8.28)
- L2 Sequencer Uptime Feed check (Chainlink)
- 2-step ownership on ALL contracts
- Ownership transfer scripts ready (→ Timelock → Safe)
- Funding rate capped at 0.1% per interval
- Insurance fund keeper reward caps ($1K/call, $10K/day)

### Backend Security
- EIP-712 WebSocket authentication
- Rate limiting (per-IP + per-address)
- CORS whitelist (no wildcard `*`)
- Input validation on all endpoints
- Private key validation on startup
- RPC failover with circuit breaker pattern

### Monitoring & Incident Response
- **Prometheus + Grafana + Alertmanager** — full monitoring stack
- **15 alert rules** across P0/P1/P2 severity
- **16-panel Grafana dashboard** — real-time protocol health
- **Incident response plan** — 8 playbooks covering contract exploits, oracle failure, liquidation cascades, service outages, RPC failures, frontend issues, database issues, key compromise
- **Communication templates** — pre-written Discord and Twitter incident notifications
- **Recovery procedures** — documented restart order, unpause sequence, database recovery

### Bug Bounty Program
- **Immunefi-format** bug bounty scope document ready
- **12 contracts** in scope
- **$250–$50,000** reward tiers by severity
- Ready to submit when protocol goes live

---

## Deployment Readiness

### Completed

| Category | Status |
|----------|--------|
| Smart contracts (11) | Compiled, tested (302 tests), internal audit complete (69 findings, all fixed) |
| Mainnet deploy script | Ready (DeployMainnet.s.sol) |
| Ownership transfer script | Ready (TransferOwnership.s.sol) |
| Backend services (4) | Coded, tested (119 tests) |
| Frontend | Live on Vercel |
| Monitoring stack | Docker Compose ready, on-chain health checks |
| Incident response | 10 runbooks + 8 playbooks documented |
| Bug bounty | Scope document ready (Immunefi format) |
| Post-deploy verification | 10-section automated script |
| Adversarial testing | 13 chaos tests + 100 DAU load test |
| Internal security audit | 69 findings, all addressed |

### Remaining for Mainnet

| Task | Effort |
|------|--------|
| External smart contract audit (Tier-1 firm) | 2-4 weeks |
| Fix external audit findings | 1-2 weeks |
| Testnet public beta | 1-2 weeks |
| Gnosis Safe setup (3/5 multisig) | 1 day |
| DNS + production domain | 1 day |

---

## Technical Metrics

| Metric | Value |
|--------|-------|
| Smart contracts | 11 (7 core + 4 auxiliary) |
| Contract tests | 302 passing |
| Backend services | 4 (API, Oracle, Keeper, Funding) |
| Backend tests | 119 passing |
| Frontend pages | 16+ |
| Order types | 5 (Market, Limit, Stop Market, Stop Limit, OCO) |
| Max leverage | 20x |
| Supported markets | BTC/USD, ETH/USD (extensible) |
| Oracle latency | ~5 second updates (Pyth Network) |
| WS load tested | 100 concurrent connections |
| Monitoring alerts | 15 rules (P0/P1/P2) |
| Incident playbooks | 8 |
| Accessibility | WCAG-compliant (aria, focus trap, keyboard nav) |
| Theme support | Dark + Light mode |
| Mobile responsive | Full trading on mobile |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Solidity 0.8.28, Foundry |
| L2 Chain | Base (Coinbase) |
| Oracles | Pyth Network |
| Backend | TypeScript, Node.js, viem |
| Database | Supabase (PostgreSQL) |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| State Management | Zustand |
| Wallet | RainbowKit + wagmi |
| Charts | lightweight-charts (TradingView) |
| Monitoring | Prometheus, Grafana, Alertmanager |
| Hosting | Vercel (frontend), Railway (backend) |
| Multisig | Gnosis Safe |
| CI/CD | Vercel auto-deploy, Foundry CI |

---

## What Sets SUR Apart

1. **Full-stack ownership** — contracts, backend, frontend, monitoring — all built in-house with deep understanding of every layer
2. **Security-first approach** — timelock, multisig, circuit breakers, pause mechanisms, incident response, bug bounty — all before mainnet launch
3. **Production-grade infrastructure** — not a hackathon project. Multi-RPC failover, rate limiting, retry logic, health checks, Prometheus metrics
4. **Institutional-grade testing** — 421 total tests (302 contract + 119 backend), adversarial chaos tests, 100 DAU load test, invariant fuzzing
5. **Complete trading experience** — 5 order types including OCO, inline TP/SL editing, keyboard shortcuts, mobile responsive, dark/light mode, accessibility
6. **Built on Base** — Coinbase's L2 for low fees, fast finality, and access to the Coinbase ecosystem

---

*SUR Protocol — where DeFi meets institutional-grade perpetual futures trading.*
