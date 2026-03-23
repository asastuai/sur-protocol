# SUR Protocol - Incident Response Plan & Runbook

> **Last Updated:** 2026-03-19
> **Owner:** SUR Protocol Core Team
> **Chain:** Base L2 (Chain ID 8453)

---

## Table of Contents

1. [Severity Levels & SLAs](#1-severity-levels--slas)
2. [Escalation Matrix](#2-escalation-matrix)
3. [Incident Playbooks](#3-incident-playbooks)
4. [Communication Templates](#4-communication-templates)
5. [Post-Incident Review Process](#5-post-incident-review-process)
6. [Emergency Contacts & Tools Checklist](#6-emergency-contacts--tools-checklist)
7. [Recovery Procedures](#7-recovery-procedures)

---

## 1. Severity Levels & SLAs

| Severity | Definition | Response Time | Update Cadence | Resolution Target |
|----------|-----------|---------------|----------------|-------------------|
| **P0 - Critical** | Active exploit, funds at risk, complete protocol halt | **5 minutes** | Every 15 min | ASAP (war room) |
| **P1 - High** | Partial outage, liquidation failures, oracle stale >60s, insurance fund below threshold | **15 minutes** | Every 30 min | 2 hours |
| **P2 - Medium** | Single backend service degraded, elevated error rates, RPC intermittent failures | **1 hour** | Every 2 hours | 8 hours |
| **P3 - Low** | UI cosmetic issues, non-critical monitoring gaps, slow queries | **4 hours** | Daily | 48 hours |

### Automatic Escalation Rules

- P2 unresolved for 4 hours escalates to P1.
- P1 unresolved for 2 hours escalates to P0.
- Any on-chain pause event auto-triggers P0.
- Circuit breaker activation auto-triggers P1.

---

## 2. Escalation Matrix

| Level | Role | Responsibilities | Notification Method |
|-------|------|-----------------|---------------------|
| **L1 - On-Call Engineer** | Backend / infra engineer | Initial triage, execute runbook, escalate if needed | PagerDuty / Telegram |
| **L2 - Protocol Lead** | Senior smart contract engineer | Contract-level decisions, pause/unpause authority | Telegram + Phone |
| **L3 - Multisig Signers** | Gnosis Safe signers (4/7 quorum) | Execute emergency transactions, timelock bypass via guardian | Telegram group + Phone |
| **L4 - Project Lead** | Founder / CTO | External comms approval, strategic decisions | Phone (always reachable) |
| **External** | Security auditor / white-hat | Exploit analysis, patch review | Pre-arranged secure channel |

### On-Call Rotation

- 7-day rotations, handoff every Monday 00:00 UTC.
- On-call engineer must acknowledge pages within 5 minutes.
- Secondary on-call as backup if primary does not acknowledge within 10 minutes.

---

## 3. Incident Playbooks

---

### 3.1 Oracle Failure (Stale Prices)

**Severity:** P1 (P0 if positions are being liquidated on stale prices)

**Detection:**
```promql
sur_oracle_price_staleness_seconds > 30
```
```bash
# Check Oracle Keeper health
curl -s http://sur-oracle:3011/metrics | grep sur_oracle_price_staleness_seconds
curl -s http://sur-oracle:3011/metrics | grep sur_oracle_pushes_failed_total
```

**Impact:** Incorrect liquidations, wrong PnL calculations, arbitrage against the protocol.

**Steps:**

1. **Verify the issue:**
   ```bash
   # Check Pyth Hermes API directly
   curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" | jq .

   # Check OracleRouter on-chain
   cast call $ORACLE_ROUTER "getLastPrice(bytes32)(uint256,uint256)" $BTC_MARKET_ID --rpc-url $BASE_RPC
   ```

2. **If Pyth Hermes is down:**
   ```bash
   # Switch to backup Hermes endpoint
   # Railway dashboard > oracle-keeper > Variables
   HERMES_URL=https://hermes-beta.pyth.network
   railway service restart oracle-keeper
   ```

3. **If prices are stale on-chain (>120s):**
   ```bash
   # Pause PerpEngine and OrderSettlement
   cast send $PERP_ENGINE "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
   cast send $ORDER_SETTLEMENT "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
   ```

4. **Recovery:** See [Section 7.1 - Oracle Recovery](#71-oracle-recovery).

---

### 3.2 Smart Contract Exploit / Suspicious Activity

**Severity:** P0

**Steps:**

1. **IMMEDIATELY pause all contracts (guardian key):**
   ```bash
   cast send $PERP_ENGINE "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC &
   cast send $PERP_VAULT "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC &
   cast send $ORDER_SETTLEMENT "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC &
   cast send $LIQUIDATOR "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC &
   cast send $INSURANCE_FUND "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC &
   wait
   ```

2. **Stop all backend services:**
   ```bash
   railway service stop api
   railway service stop keeper
   railway service stop oracle-keeper
   railway service stop funding-bot
   ```

3. **Assess damage:**
   ```bash
   cast call $PERP_VAULT "totalAssets()(uint256)" --rpc-url $BASE_RPC
   cast call $INSURANCE_FUND "totalReserves()(uint256)" --rpc-url $BASE_RPC
   ```

4. **Identify attack vector** via Basescan / Tenderly transaction traces.

5. **Do NOT unpause until** root cause is identified, fix is reviewed, and multisig approves.

---

### 3.3 Liquidation Cascade / Insurance Fund Depletion

**Severity:** P1 (P0 if insurance fund is emptied)

**Detection:**
```promql
increase(sur_keeper_liquidations_total[5m]) > 20
increase(sur_keeper_liquidations_failed_total[5m]) > 5
```

**Steps:**

1. Monitor insurance fund: `cast call $INSURANCE_FUND "totalReserves()(uint256)" --rpc-url $BASE_RPC`
2. If < 20%: tighten circuit breaker parameters.
3. If keeper overwhelmed: restart with higher gas settings.
4. If insurance depleted (P0): pause OrderSettlement to halt new positions.
5. Replenish via multisig + timelock.

---

### 3.4 Backend Service Down

#### API (P1 - users cannot trade)
```bash
railway logs api --tail 100
railway service restart api
curl -s http://sur-api:3002/metrics | grep sur_api_ws_connections
```

If under DDoS: set `MAX_MESSAGES_PER_SEC=5`, `MAX_WS_CONNECTIONS=100`, restart.

#### Keeper (P1 - no liquidations)
```bash
railway logs keeper --tail 100
railway service restart keeper
# If stuck nonce:
cast nonce $KEEPER_ADDRESS --rpc-url $BASE_RPC
cast send $KEEPER_ADDRESS --value 0 --nonce $STUCK_NONCE --private-key $KEEPER_KEY --rpc-url $BASE_RPC
```

#### Oracle Keeper (P1 - prices go stale)
```bash
# Test Hermes
curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
# Switch endpoint if down
HERMES_URL=https://hermes-beta.pyth.network
railway service restart oracle-keeper
```

#### Funding Bot (P2 - rates stale but safe)
```bash
railway logs funding-bot --tail 100
railway service restart funding-bot
```

---

### 3.5 RPC Provider Failure

**Severity:** P2 (P1 if all fallbacks fail)

1. Test each RPC: `cast block-number --rpc-url $URL`
2. All services use viem `fallback()` with auto-ranking — verify failover is working.
3. If all RPCs down: check https://status.base.org, pause contracts if needed.
4. Add emergency RPC via `RPC_URLS_FALLBACK` env var on all services.

---

### 3.6 Frontend / Vercel Outage

**Severity:** P2

1. Check Vercel dashboard and https://www.vercel-status.com/
2. Rollback: `vercel rollback --project sur-protocol`
3. Communicate that protocol + funds are safe; point users to Basescan.

---

### 3.7 Database (Supabase) Outage

**Severity:** P1

1. Check https://status.supabase.com
2. On-chain state is unaffected. Keeper and Oracle continue independently.
3. After recovery: restart API, verify order book matches on-chain state.

---

### 3.8 Key Compromise

**Severity:** P0

| Key | Blast Radius | Action |
|-----|-------------|--------|
| **Gnosis Safe signer** | Full protocol control (behind timelock) | Convene signers, rotate via Safe UI (4/7 quorum) |
| **Guardian key** | Emergency pause only | Rotate via timelock (48h delay) |
| **Keeper/Bot keys** | Can spend gas | Drain ETH, new key, update Railway |

---

## 4. Communication Templates

### Discord - Incident Active
```
@everyone

**[INCIDENT] - {Brief Description}**

We are currently investigating an issue affecting {affected component}.

**Status:** Investigating
**Impact:** {What users are experiencing}
**Funds:** {Safe / At risk / Being assessed}

Updates every {15/30} minutes. Timestamp: {UTC time}
```

### Discord - Incident Resolved
```
**[RESOLVED] - {Brief Description}**

All systems are operational.

**Root Cause:** {Brief explanation}
**Duration:** {Start} - {End} ({total})
**Funds:** All user funds are safe.

Post-mortem within 72 hours.
```

### Twitter/X
```
Active: We're aware of an issue affecting {component}. {Funds are safe.} Updates in Discord.
Resolved: Issue resolved. Root cause: {summary}. Duration: {X}. Post-mortem: {link}
```

---

## 5. Post-Incident Review Process

| Milestone | Deadline |
|-----------|----------|
| Incident resolved | T+0 |
| Internal debrief | T+24h |
| Written post-mortem draft | T+48h |
| Public post-mortem (P0/P1) | T+72h |
| Action items completed | T+2 weeks |

---

## 6. Emergency Contacts & Tools Checklist

### Contract Addresses (Base L2)

> **Fill in after deployment and store securely. Keep a printed offline copy.**

```
PERP_VAULT=0x...
PERP_ENGINE=0x...
ORDER_SETTLEMENT=0x...
LIQUIDATOR=0x...
INSURANCE_FUND=0x...
ORACLE_ROUTER=0x...
SUR_TIMELOCK=0x...
GNOSIS_SAFE=0x...
```

### Tools

| Tool | Purpose | URL |
|------|---------|-----|
| Railway | Backend services | https://railway.app/dashboard |
| Vercel | Frontend | https://vercel.com/dashboard |
| Supabase | Database | https://app.supabase.com |
| Basescan | On-chain inspection | https://basescan.org |
| Tenderly | Tx debugging | https://dashboard.tenderly.co |
| Gnosis Safe | Multisig | https://app.safe.global |
| Grafana | Metrics | http://localhost:3030 |
| Base Status | L2 status | https://status.base.org |

### Prometheus Endpoints

| Service | Endpoint |
|---------|----------|
| API | `http://sur-api:3002/metrics` |
| Keeper | `http://sur-keeper:3010/metrics` |
| Oracle | `http://sur-oracle:3011/metrics` |
| Funding | `http://sur-funding:3012/metrics` |

---

## 7. Recovery Procedures

### 7.1 Oracle Recovery

1. Verify prices are fresh: `cast call $ORACLE_ROUTER "getLastPrice(bytes32)" $MARKET_ID --rpc-url $BASE_RPC`
2. Check circuit breaker: `cast call $PERP_ENGINE "circuitBreakerActive()(bool)" --rpc-url $BASE_RPC`
3. Unpause in order: PerpEngine first, then OrderSettlement.
4. Monitor closely for 30 minutes.

### 7.2 Full Protocol Recovery (After P0)

**Restart order:**
```bash
# 1. Oracle Keeper first (prices must be live)
railway service restart oracle-keeper && sleep 30

# 2. Funding Bot
railway service restart funding-bot

# 3. Keeper (liquidation bot)
railway service restart keeper

# 4. API last (re-enables user access)
railway service restart api
```

**Unpause order:**
```bash
cast send $PERP_ENGINE "unpause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
cast send $LIQUIDATOR "unpause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
cast send $PERP_VAULT "unpause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
cast send $INSURANCE_FUND "unpause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
# OrderSettlement LAST - this re-enables trading
cast send $ORDER_SETTLEMENT "unpause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
```

### 7.3 Database Recovery

1. Check Supabase point-in-time recovery.
2. On-chain state is source of truth — rebuild from contract events if needed.

---

## Appendix: Emergency Pause Quick Reference

```
PAUSE ALL CONTRACTS:
  cast send $PERP_ENGINE "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
  cast send $PERP_VAULT "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
  cast send $ORDER_SETTLEMENT "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
  cast send $LIQUIDATOR "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC
  cast send $INSURANCE_FUND "pause()" --private-key $GUARDIAN_KEY --rpc-url $BASE_RPC

STOP ALL SERVICES:
  railway service stop api
  railway service stop keeper
  railway service stop oracle-keeper
  railway service stop funding-bot

UNPAUSE ORDER (after resolution):
  1. oracle-keeper restart + verify prices
  2. unpause PerpEngine
  3. unpause Liquidator
  4. restart keeper
  5. unpause PerpVault + InsuranceFund
  6. restart funding-bot
  7. unpause OrderSettlement (trading resumes)
  8. restart api (users reconnect)
```
