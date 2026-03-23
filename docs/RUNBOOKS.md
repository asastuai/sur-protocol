# SUR Protocol - Emergency Runbooks

Procedimientos operativos para responder a alertas P0/P1 del sistema de monitoreo.

---

## P0 — CRITICAL (respuesta inmediata)

### RB-01: Oracle Price Stale Critical

**Alerta:** `OraclePriceStaleCritical` — precio stale > 30s
**Impacto:** Protocolo congelado — no trades, no liquidaciones
**Tiempo de respuesta:** < 2 minutos

**Pasos:**
1. Verificar estado del oracle keeper:
   ```bash
   ssh oracle-keeper "systemctl status sur-oracle"
   ```
2. Si el proceso está caído, reiniciar:
   ```bash
   ssh oracle-keeper "systemctl restart sur-oracle"
   ```
3. Si el proceso está vivo pero no pushea, verificar RPC:
   ```bash
   cast block-number --rpc-url $BASE_RPC_URL
   ```
4. Verificar balance ETH del oracle keeper (necesita pagar Pyth update fees):
   ```bash
   cast balance $ORACLE_KEEPER_ADDRESS --rpc-url $BASE_RPC_URL
   ```
5. Si el keeper no tiene ETH, fondear inmediatamente desde hot wallet
6. Si Pyth está caído (verificar status.pyth.network), activar fallback a Chainlink:
   ```bash
   # No se puede cambiar en caliente — el keeper debería usar CL automáticamente
   # Si no hay ningún feed disponible, considerar pause via guardian
   ```

**Escalación:** Si no se resuelve en 5 min → guardian pause via Timelock

---

### RB-02: Engine Circuit Breaker Active

**Alerta:** `EngineCircuitBreakerActive`
**Impacto:** Liquidaciones congeladas — posiciones underwater acumulándose
**Tiempo de respuesta:** < 5 minutos

**Pasos:**
1. **NO entrar en pánico** — el circuit breaker se auto-resetea después del cooldown (5 min default)
2. Verificar qué causó la activación:
   ```bash
   cast call $ENGINE_ADDRESS "circuitBreakerTriggeredAt()(uint256)" --rpc-url $BASE_RPC_URL
   cast call $ENGINE_ADDRESS "liquidatedInWindow(bytes32)(uint256)" $BTC_MARKET_ID --rpc-url $BASE_RPC_URL
   ```
3. Revisar logs del keeper para ver si hubo un flash crash o manipulación
4. Si el cooldown ya pasó y sigue activo, el owner puede resetear manualmente:
   ```bash
   # Via Timelock (48h delay) — solo si es urgente, usar guardian pause
   cast calldata "resetCircuitBreaker()"
   ```
5. Monitorear OI y precios durante los próximos 15 minutos post-reset

**Escalación:** Si se re-activa 3+ veces en 1 hora → investigar posible ataque, considerar pause

---

### RB-03: Oracle Circuit Breaker Active

**Alerta:** `OracleCircuitBreakerActive`
**Impacto:** Price feeds congelados — todo el protocolo paralizado
**Tiempo de respuesta:** < 2 minutos

**Pasos:**
1. Verificar el precio que triggeó el CB:
   ```bash
   cast call $ORACLE_ADDRESS "oracleCircuitBreakerTriggeredAt()(uint256)" --rpc-url $BASE_RPC_URL
   cast call $ORACLE_ADDRESS "isOracleHealthy()(bool)" --rpc-url $BASE_RPC_URL
   ```
2. Verificar precio real en CoinGecko/Binance — ¿el movimiento es legítimo?
3. Si es un movimiento real del mercado (>10% en minutos), esperar auto-recovery:
   - El CB requiere `requiredGoodPricesForReset` (default 3) precios consecutivos dentro del rango
4. Si es un precio corrupto/manipulado:
   - **Guardian pause** inmediato en OracleRouter y PerpEngine
   - Investigar la fuente del precio corrupto
5. Si el CB no se auto-resetea y el movimiento fue legítimo, el owner puede:
   ```bash
   # Queue via Timelock
   cast calldata "resetOracleCircuitBreaker()"
   ```

**Escalación:** Si se sospecha manipulación → pause total + post-mortem

---

### RB-04: Contract Paused (Settlement/Liquidator)

**Alerta:** `ContractPaused`
**Impacto:** Settlement pausado = no trades. Liquidator pausado = no liquidaciones
**Tiempo de respuesta:** < 5 minutos

**Pasos:**
1. Verificar quién pausó y cuándo (revisar eventos on-chain):
   ```bash
   cast logs --from-block -1000 --address $CONTRACT_ADDRESS "PauseStatusChanged(bool)" --rpc-url $BASE_RPC_URL
   ```
2. Si fue el guardian (emergencia legítima):
   - Investigar la causa raíz
   - Verificar que el guardian comunicó al equipo (Telegram/Discord)
3. Si fue inesperado:
   - Verificar que no hay una ownership transfer en curso (posible ataque)
   - Revisar transacciones recientes del owner/guardian
4. Para despausar (requiere owner = Timelock):
   ```bash
   # Queue en Timelock via Safe
   cast calldata "unpause()"
   # Esperar delay (48h mainnet, 24h testnet)
   # Execute
   ```

**NOTA:** El guardian puede pausar sin delay, pero solo el owner (Timelock) puede despausar.

---

### RB-05: Vault Unhealthy

**Alerta:** `VAULT UNHEALTHY — actual USDC < accounted`
**Impacto:** CRITICAL — discrepancia contable, posible exploit
**Tiempo de respuesta:** INMEDIATO

**Pasos:**
1. **Guardian pause ALL** — PerpVault, PerpEngine, OrderSettlement, Liquidator
2. Verificar la discrepancia:
   ```bash
   cast call $VAULT_ADDRESS "healthCheck()(bool,uint256,uint256)" --rpc-url $BASE_RPC_URL
   ```
3. Revisar transacciones recientes del vault:
   ```bash
   cast logs --from-block -500 --address $VAULT_ADDRESS --rpc-url $BASE_RPC_URL
   ```
4. Verificar si hay un exploit en curso:
   - ¿Algún operador ejecutó transfers inesperados?
   - ¿Algún contrato tiene bug que permite withdraw sin actualizar balances?
5. **NO despausar** hasta identificar la causa raíz
6. Contactar al equipo de seguridad inmediatamente

**Escalación:** Post-mortem obligatorio. Si hay exploit confirmado → war room.

---

### RB-06: Settlement Failures Critical

**Alerta:** `SettlementFailuresCritical` — > 3 failures en 5 min
**Impacto:** Trades de usuarios no se liquidan — fondos potencialmente stuck
**Tiempo de respuesta:** < 3 minutos

**Pasos:**
1. Verificar estado del API server:
   ```bash
   curl -s http://api-server:3001/health | jq
   ```
2. Verificar nonce del settlement keeper:
   ```bash
   cast nonce $SETTLEMENT_KEEPER_ADDRESS --rpc-url $BASE_RPC_URL
   ```
3. Si hay nonce stuck (transacción pendiente):
   ```bash
   # Enviar tx de reemplazo con gas más alto
   cast send --nonce $STUCK_NONCE --gas-price $(cast gas-price --rpc-url $BASE_RPC_URL | awk '{print $1 * 2}') ...
   ```
4. Verificar si el contrato está pausado:
   ```bash
   cast call $SETTLEMENT_ADDRESS "paused()(bool)" --rpc-url $BASE_RPC_URL
   ```
5. Si todo está OK pero las TXs fallan, verificar gas limits y estado del chain

---

## P1 — URGENT (responder en minutos)

### RB-07: Liquidation Failures High

**Alerta:** `LiquidationFailuresHigh` — > 5 failures en 5 min
**Impacto:** Posiciones underwater acumulándose → riesgo de socialized losses

**Pasos:**
1. Verificar estado del liquidation keeper:
   ```bash
   ssh keeper "systemctl status sur-liquidator"
   ssh keeper "journalctl -u sur-liquidator --since '5 min ago'"
   ```
2. Verificar balance ETH del keeper
3. Verificar si el engine o liquidator están pausados
4. Verificar si el circuit breaker está activo (puede causar failures legítimos)
5. Si el keeper tiene gas y los contratos no están pausados:
   - Revisar logs para errores específicos
   - Puede ser un revert por cambio de precio entre check y execution (normal en alta vol)
6. Liquidación manual si es crítico:
   ```bash
   cast send $LIQUIDATOR_ADDRESS "liquidate(bytes32,address)" $MARKET_ID $TRADER_ADDRESS --rpc-url $BASE_RPC_URL --private-key $KEEPER_PK
   ```

---

### RB-08: Ownership Transfer Pending

**Alerta:** `OwnershipTransferPending`
**Impacto:** INFO/WARNING — puede ser normal (Timelock operation) o sospechoso

**Pasos:**
1. Verificar qué contrato tiene pendingOwner:
   ```bash
   cast call $CONTRACT_ADDRESS "pendingOwner()(address)" --rpc-url $BASE_RPC_URL
   ```
2. Verificar si el pendingOwner es el Timelock (esperado durante setup)
3. Si el pendingOwner es una dirección desconocida:
   - **ALERTA ROJA** — posible ownership takeover
   - Guardian pause inmediato
   - Investigar cómo se llamó transferOwnership
4. Si es esperado, verificar que acceptOwnership se ejecute dentro del timeframe previsto

---

### RB-09: Insurance Coverage Dropping Fast

**Alerta:** `InsuranceCoverageDroppingFast`
**Impacto:** Insurance fund depletiéndose — posible bad debt inminente

**Pasos:**
1. Verificar coverage ratio actual:
   ```bash
   cast call $VAULT_ADDRESS "balances(address)(uint256)" $INSURANCE_FUND_ADDRESS --rpc-url $BASE_RPC_URL
   ```
2. Verificar si hay una cascada de liquidaciones en curso
3. Si coverage < 1%:
   - Considerar pause del engine para frenar nuevas posiciones
   - Evaluar inyección de capital al insurance fund
4. Revisar si el circuit breaker debería estar activo

---

### RB-10: Keeper Gas Burn Rate High

**Alerta:** `KeeperGasBurnRateHigh` o `OracleGasBurnRateHigh`
**Impacto:** Keeper wallets se van a quedar sin gas

**Pasos:**
1. Verificar balances actuales de todos los keepers:
   ```bash
   for addr in $KEEPER_ADDRESSES; do
     echo "$addr: $(cast balance $addr --ether --rpc-url $BASE_RPC_URL) ETH"
   done
   ```
2. Si algún keeper < 0.005 ETH, fondear inmediatamente
3. Investigar por qué el gas burn es alto:
   - ¿Muchas liquidaciones? (normal en alta volatilidad)
   - ¿Loop de reintentos? (bug en keeper)
   - ¿Gas price spike en L2? (verificar base fee)

---

## Procedimiento General: Guardian Emergency Pause

El guardian (hot wallet) puede pausar cualquier contrato registrado en el Timelock sin delay.

```bash
# Pausar un contrato específico
cast send $TIMELOCK_ADDRESS "emergencyPause(address)" $TARGET_CONTRACT \
  --rpc-url $BASE_RPC_URL --private-key $GUARDIAN_PK

# Pausar todo
for contract in $VAULT $ENGINE $SETTLEMENT $LIQUIDATOR $ORACLE $INSURANCE; do
  cast send $TIMELOCK_ADDRESS "emergencyPause(address)" $contract \
    --rpc-url $BASE_RPC_URL --private-key $GUARDIAN_PK
done
```

**IMPORTANTE:** El guardian solo puede PAUSAR. Para DESPAUSAR se necesita el owner (Timelock) con delay de 48h.

---

## Contactos de Emergencia

| Rol | Contacto | Cuando |
|-----|----------|--------|
| Guardian Operator | [TBD - hot wallet holder] | Cualquier P0 |
| Safe Signers | [TBD - multisig signers] | Despausar, ownership changes |
| Oracle Team | [TBD] | Oracle failures |
| Infra/DevOps | [TBD] | Service down, keeper issues |

---

## Post-Mortem Template

Después de cada incidente P0:
1. **Timeline:** Cuándo se detectó, cuándo se respondió, cuándo se resolvió
2. **Root Cause:** Qué causó el incidente
3. **Impact:** Usuarios afectados, fondos en riesgo
4. **Response:** Qué se hizo para mitigar
5. **Action Items:** Qué cambios previenen recurrencia
