# SUR Protocol

### First agent-native perpetual futures DEX. Settlement gating by Proof-of-Context in active integration.

**[→ Live at sur-protocol.vercel.app](https://sur-protocol.vercel.app)**

[![Base L2](https://img.shields.io/badge/Base-Sepolia%20%2F%20Mainnet-0052FF.svg)](https://sur-protocol.vercel.app)
[![Foundry](https://img.shields.io/badge/tests-531%20passing-brightgreen.svg)](https://book.getfoundry.sh/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8-363636.svg)](https://soliditylang.org/)
[![EIP-712](https://img.shields.io/badge/orders-EIP--712-orange.svg)](https://eips.ethereum.org/EIPS/eip-712)
[![PoC](https://img.shields.io/badge/settlement%20gate-PoC%20in%20integration-orange.svg)](https://github.com/asastuai/proof-of-context)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](./LICENSE)

*Member of the [Aletheia](https://github.com/asastuai/aletheia) stack. Designed to consume [`f_i`](https://github.com/asastuai/proof-of-context)-typed attestations from [Vigil](https://github.com/asastuai/vigil) once integration completes. Today, the on-chain `FreshnessTypes` event schema is landed; horizon enforcement at clear-time is the active integration surface.*

---

## What it is

SUR is a perpetual futures DEX where AI agents are first-class participants and where settlement is being progressively wired against typed attestations from the Aletheia verification spine.

The DEX is hybrid by architecture: off-chain matching for latency, on-chain settlement and custody on Base L2 for non-custodial guarantees. EIP-712 signed orders. USDC collateral. Pyth + Chainlink oracle feeds with deviation checks. **12 Solidity contracts. 531 passing Foundry tests.**

The agent-native part is what differentiates SUR from other perp DEXs:

- An **MCP server** so LLM agents interact with SUR natively through the Model Context Protocol
- An **intent engine** for agent-readable order construction
- An **agent-facing API** shaped for agent-side state machines
- An **SDK** built around agent execution patterns rather than human UIs
- A **typed-attestation event schema** (`FreshnessTypes` library) that downstream contracts and indexers use to gate on freshness — the wiring of horizon enforcement into the settlement gate is in active integration
- A **risk guardian** for per-user anti-liquidation defense that will consume Vigil `f_i` attestations once that integration completes

Other perp DEXs let agents call APIs. SUR is being built so agents can post typed claims about *why* they are trading and bind settlement to those claims being valid.

---

## Roadmap — How SUR consumes Proof of Context

This section describes the integration target, not the current state. Where the README distinguishes between landed and pending, the badge and this section are the source of truth.

SUR is a consumer in the Aletheia verification stack. Its settlement layer is being wired to accept attestations typed by the [Proof of Context](https://github.com/asastuai/proof-of-context) framework, which formalizes four freshness dimensions and a settlement gate that enforces them at clear-time.

**`f_i` — input freshness.** Emitted by [Vigil](https://github.com/asastuai/vigil) and other risk producers. Target flow: an agent submits an order whose decision was conditioned on a Vigil signal (oracle health, MEV exposure, liquidation cascade risk); the `f_i` attestation is bound to the order metadata; the settlement gate verifies the signature and the horizon at clear-time; if the attestation aged past horizon, the order does not settle.

**`f_m` — model freshness.** For orders whose decision was conditioned on inference output. Currently informational. Full enforcement pending Phase 3 of [`proof-of-context-impl`](https://github.com/asastuai/proof-of-context-impl) (InferenceReceipt module).

**Execution-context-root.** A Merkle root binding the order's causal antecedents — operator, market, oracle round consumed, signer key. The same primitive PoC names. SUR is the target first production consumer.

### Status of the integration today

| Surface | Status |
| --- | --- |
| `libraries/FreshnessTypes.sol` — type constants + canonical event signatures | ✅ Landed |
| Cross-contract `FreshnessRejected` / `FreshnessCheckPassed` event indexing | ✅ Schema canonical |
| `OrderSettlement` enforcement of `f_i` horizons at clear-time | 🚧 In active integration |
| `A2ADarkPool` real-time freshness check from a verified producer | 🚧 In active integration |
| SDK / agent-api off-chain Vigil signature verification before submission | 🚧 In active integration |
| `risk-guardian` consumption of Vigil `f_i` for pre-trade gating | 🚧 Designed; binding planned |

The full mapping is in [`docs/proof-of-context-mapping.md`](docs/proof-of-context-mapping.md) and [`docs/MAPPING_4_freshness_event_schema.md`](docs/MAPPING_4_freshness_event_schema.md).

---

## Architecture

Hybrid — off-chain matching + on-chain settlement.

| Layer | Where | Why |
| --- | --- | --- |
| Order book | Off-chain (API + engine) | Latency + UX |
| Matching | Off-chain (engine, Rust) | Throughput |
| Settlement | On-chain (Base L2) | Finality + audit |
| Custody | On-chain (`PerpVault`) | Non-custodial |
| Margin + liquidation | On-chain (`PerpEngine` + `Liquidator`) | Risk transparency |
| Price feeds | On-chain oracle router | Pyth + Chainlink fallback |
| Settlement gate | On-chain event schema landed; horizon enforcement in integration | PoC alignment |
| Agent interface | Off-chain (MCP, intent engine, agent-api, SDK) | Native agent execution |

---

## Monorepo structure

```
sur-protocol/
├── contracts/          # Solidity smart contracts (Foundry, 531 tests)
├── engine/             # Matching engine (Rust)
├── api/                # Backend API (Node.js / TypeScript)
├── web/                # Trading frontend (Next.js)
├── demo/               # Live demo → sur-protocol.vercel.app
│
├── agent-api/          # Agent-facing order interface
├── intent-engine/      # Intent → order construction for agents
├── mcp-server/         # Model Context Protocol server (LLM agents)
├── sdk/                # TypeScript SDK shaped for agent execution
│
├── keeper/             # Permissionless liquidation keeper
├── oracle-keeper/      # Oracle update keeper
├── risk-engine/        # Live position-risk computation
├── risk-guardian/      # Per-user anti-liquidation agent (Vigil binding planned)
├── funding-bot/        # Funding rate maintenance
├── trading-bot/        # Reference market-making agent
├── copytrade-bot/      # Reference copytrade agent
├── backtester/         # Strategy backtesting harness
│
├── monitoring/         # Ops + observability
├── deploy/             # Deploy scripts and addresses
└── docs/               # Specs and protocol documentation
```

---

## Core contracts (settlement layer)

| Contract | Purpose | Status |
| --- | --- | --- |
| `PerpVault.sol` | USDC collateral custody, deposits, withdrawals | ✅ Complete |
| `PerpEngine.sol` | Position management, PnL, margin, liquidation | ✅ Complete |
| `PerpEngineView.sol` | Read-only view lens (bytecode-size optimization) | ✅ Complete |
| `OrderSettlement.sol` | Batch trade settlement with EIP-712 signatures | ✅ Complete |
| `Liquidator.sol` | Permissionless liquidation, keeper rewards, batch mode | ✅ Complete |
| `InsuranceFund.sol` | Bad debt absorption, fund health tracking | ✅ Complete |
| `AutoDeleveraging.sol` | Last-resort ADL when insurance fund depletes | ✅ Complete |
| `OracleRouter.sol` | Pyth + Chainlink feeds, deviation checks, normalization | ✅ Complete |
| `CollateralManager.sol` | Yield-bearing collateral with haircut + liquidation snapshots | ✅ Complete |
| `TradingVault.sol` | Pooled trading vaults (copy-trading / HLP-style) | ✅ Complete |
| `A2ADarkPool.sol` | Agent-to-agent OTC matching | ✅ Complete |
| `SurTimelock.sol` | Governance timelock with prospective-only admin updates | ✅ Complete |

Libraries: `SurMath.sol` (WAD fixed-point math) and `FreshnessTypes.sol` (canonical PoC event schema).

---

## Agent execution layer

The pieces that make SUR a venue agents can post into without a human in the loop.

| Component | What it does | Status |
| --- | --- | --- |
| **Agent API** | Order submission, balance queries, position tracking — shaped for agent-side state machines | ✅ Live |
| **Intent Engine** | Translates agent intents (parametric or natural language) into EIP-712 orders | ✅ Live |
| **MCP Server** | Exposes SUR as tools for any MCP-aware LLM agent (Claude, GPT, others) | ✅ Live |
| **SDK** | TypeScript primitives for agent execution: signing, retries, attestation binding (in integration) | ✅ Live |
| **Risk Guardian** | Per-user anti-liquidation agent. Monitors positions and intervenes before the liquidation engine acts. Vigil `f_i` binding planned. | ✅ Live (Aletheia binding in design) |
| **Reference agents** | `trading-bot` (production-shaped market maker), `copytrade-bot` and `funding-bot` (compact reference implementations). Open-source. | ✅ Live |

---

## Quick start

### Prerequisites

* [Foundry](https://book.getfoundry.sh/getting-started/installation) (contracts)
* [Rust](https://rustup.rs/) (matching engine)
* [Node.js 20+](https://nodejs.org/) (API, frontend, agent layer)

### Contracts

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge build
forge test -vvv          # 531 passing
forge test --gas-report
```

### Deploy to Base Sepolia

```bash
forge script script/DeploySur.s.sol:DeploySur \
  --rpc-url base_sepolia --broadcast --verify
```

### Environment

Copy `.env.example` to `.env` and fill in your values. The committed example documents the canonical variables. Aletheia integration variables (Vigil operator public key for off-chain `f_i` verification, etc.) will land in `.env.example` once the integration is wired.

---

## Network

| Network | Status |
| --- | --- |
| Base Sepolia (testnet) | ✅ Live, integrated with frontend |
| Base (mainnet) | Pending audit completion |

---

## Aletheia stack

SUR is the consumer flagship of the Aletheia verification stack. The other repos:

* **[Proof of Context](https://github.com/asastuai/proof-of-context)** — verification spine. The framework whose primitives type SUR's settlement gate.
* **[`proof-of-context-impl`](https://github.com/asastuai/proof-of-context-impl)** — Rust reference implementation of the spine primitives.
* **[Vigil](https://github.com/asastuai/vigil)** — risk producer. Emits Ed25519-signed `f_i` attestations targeted by SUR's risk guardian and settlement gate.
* **[TrustLayer](https://github.com/asastuai/TrustLayer)** — agent reputation aggregator.
* **[PayClaw](https://github.com/asastuai/payclaw)** — agent wallet SDK (npm).
* **[BaseOracle](https://github.com/asastuai/BaseOracle)** — pay-per-query market data.

## Adjacent research

* **[Hermetic Foundations of Aletheia](https://github.com/asastuai/aletheia/blob/main/BRIDGE.md)** — conceptual motivation for why the freshness dimensions (`f_c`, `f_m`, `f_i`, `f_s`) are well-named and not arbitrary.
* **[Kybalion](https://github.com/asastuai/kybalion)** — Hermetic Computing research framework (Rust). Independent of Aletheia; bridges to it through the document above.

---

## Origins

SUR was first prototyped as a perpetual futures venue for emerging-market traders with limited access to non-custodial derivatives. Buenos Aires was the starting context, not the limit. The architecture survived its repositioning toward the agent economy because the underlying primitives — non-custodial collateral, EIP-712 signed orders, oracle-routed price feeds, hybrid matching — are equally load-bearing for both audiences. The agent-native layer was added because that is where the volume is going, not because the original thesis broke.

---

## License

[BUSL-1.1](./LICENSE) (Business Source License). The `LICENSE` file is the canonical text from MariaDB's BSL 1.1 distribution. Converts to a permissive license after the change date specified in the file.

---

## Commercial use and licensing

SUR is available for commercial licensing under several structures (non-exclusive, exclusive, full IP acquisition, acquihire). What is included in any licensed package goes beyond the public repository: production deployment configs, ops runbooks, knowledge-transfer hours with the author, and private-repo access for the licensee's internal operations.

**Who buys this.** Teams launching a perp DEX on a new L2, white-label providers packaging perp infrastructure, exchanges adding derivatives, or investors funding portfolio companies that need the tech stack. Serious inbound welcome. Anonymous or rushed approaches will not be engaged.

**Contact.** `juancmaisu@outlook.com`. Preferred subject line: "SUR Protocol licensing inquiry". Detailed terms and a technical brief are available on request after an initial exchange.

The author ([Juan Cruz Maisu](https://github.com/asastuai)) is based in Buenos Aires, Argentina, and operates under Argentinian software-export tax regime for international licensing transactions.

---

Built by [Juan Cruz Maisu](https://github.com/asastuai) · Buenos Aires
