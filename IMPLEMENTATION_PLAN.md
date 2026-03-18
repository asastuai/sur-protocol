# SUR Protocol — Plan de Implementación para Agente

## CONTEXTO

Sos un agente de código trabajando en el proyecto SUR Protocol, el primer DEX de perpetuos argentino. El proyecto tiene dos componentes principales:

1. **Smart Contracts** (Solidity, Foundry framework) — en `contracts/`
2. **Matching Engine** (Rust) — en `engine/`

Tu objetivo es: hacer que TODO compile, que TODOS los tests pasen, y que el proyecto esté listo para deploy en Base Sepolia testnet.

---

## PASO 0: PRERREQUISITOS

Verificar e instalar las herramientas necesarias ANTES de tocar el código:

### Foundry (para Smart Contracts)
```bash
# Verificar si Foundry está instalado
forge --version

# Si NO está instalado:
curl -L https://foundry.paradigm.xyz | bash
source ~/.bashrc  # o source ~/.zshrc
foundryup

# Verificar instalación
forge --version   # debe mostrar forge 0.2.x o superior
cast --version
anvil --version
```

### Rust (para Matching Engine)
```bash
# Verificar si Rust está instalado
rustc --version
cargo --version

# Si NO está instalado:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Verificar
rustc --version   # debe ser 1.75+ (edition 2021)
cargo --version
```

### Node.js (para herramientas auxiliares)
```bash
node --version    # debe ser 20+
```

### Git
```bash
git --version
```

---

## PASO 1: EXTRAER EL PROYECTO

```bash
# Ir al directorio de trabajo
cd ~/projects  # o donde quieras el proyecto

# Extraer el tarball
tar -xzf sur-protocol.tar.gz

# Entrar al proyecto
cd sur-protocol

# Inicializar git
git init
git add .
git commit -m "Initial commit: SUR Protocol Phase 1 complete"
```

---

## PASO 2: SETUP DE SMART CONTRACTS (Foundry)

Este es el paso más crítico. Los smart contracts deben compilar limpiamente.

### 2.1 Instalar dependencias de Foundry

```bash
cd contracts

# Instalar forge-std (framework de testing)
forge install foundry-rs/forge-std --no-commit

# Verificar que se instaló
ls lib/forge-std/src/Test.sol
```

**IMPORTANTE:** El proyecto NO usa OpenZeppelin. Todas las interfaces están definidas localmente en `src/interfaces/`. No instalar OpenZeppelin.

### 2.2 Compilar los contratos

```bash
forge build
```

**Si hay errores de compilación:** Los problemas más probables son:

1. **Import paths incorrectos**: Verificar que `remappings.txt` tiene:
   ```
   forge-std/=lib/forge-std/src/
   ```
   
2. **Versión de solc**: El proyecto usa `solc 0.8.24`. Verificar en `foundry.toml`:
   ```toml
   solc_version = "0.8.24"
   ```

3. **Interfaz mismatch**: Si ves errores tipo "function not found" o "wrong number of arguments", es porque un test usa una firma de función que no coincide con el contrato. En ese caso, leer el contrato source y ajustar el test.

### 2.3 Estructura de contratos para referencia

```
contracts/src/
├── PerpVault.sol              # Custodia de USDC. deposit/withdraw/internalTransfer
├── PerpEngine.sol             # Posiciones, PnL, margen, liquidaciones. El contrato más grande
├── OrderSettlement.sol        # Puente: verifica firmas EIP-712, ejecuta trades
├── Liquidator.sol             # Permissionless: cualquiera puede liquidar posiciones
├── InsuranceFund.sol          # Absorbe bad debt, paga keeper rewards
├── OracleRouter.sol           # Pyth (primary) + Chainlink (fallback), normalización de precios
├── interfaces/
│   ├── ISurInterfaces.sol     # FUENTE ÚNICA de verdad para IPerpVault, IPerpEngine, IInsuranceFund
│   ├── IERC20.sol             # Minimal ERC20
│   ├── IPyth.sol              # Pyth oracle interface
│   └── IChainlink.sol         # Chainlink aggregator interface
└── libraries/
    └── SurMath.sol            # Fixed-point math (WAD = 1e18) — NO SE USA en los contratos actuales
                               # pero existe para uso futuro

contracts/test/
├── PerpVault.t.sol            # 40 tests unitarios del vault
├── PerpEngine.t.sol           # 36 tests del engine (posiciones, PnL, liquidación)
├── OracleRouter.t.sol         # 32 tests de oráculos (Pyth, Chainlink, normalización)
├── Integration.t.sol          # 5 tests END-TO-END (el más importante)
├── invariant/
│   ├── Invariant.t.sol        # 4 invariantes que el fuzzer verifica
│   └── InvariantHandler.sol   # Acciones aleatorias para el fuzzer
└── mocks/
    ├── MockUSDC.sol           # ERC20 con mint abierto (6 decimales)
    ├── MockPyth.sol           # Pyth simulado para testing
    └── MockChainlink.sol      # Chainlink simulado para testing
```

### 2.4 Cadena de permisos entre contratos

Esto es CRÍTICO para entender cómo se conectan:

```
PerpVault.operators:
  ├── PerpEngine       (puede hacer internalTransfer para margen y PnL)
  └── OrderSettlement  (puede hacer internalTransfer para cobrar fees)

PerpEngine.operators:
  ├── OrderSettlement  (puede llamar openPosition para ejecutar trades)
  ├── Liquidator       (puede llamar liquidatePosition)
  ├── OracleRouter     (puede llamar updateMarkPrice)
  └── owner/deployer   (para setup inicial)

InsuranceFund.operators:
  └── Liquidator       (puede registrar bad debt y pagar keeper rewards)
```

### 2.5 API de cada contrato (firmas exactas)

**PerpVault:**
- `constructor(address _usdc, address _owner, uint256 _depositCap)`
- `deposit(uint256 amount)` — usuario deposita USDC
- `withdraw(uint256 amount)` — usuario retira USDC
- `internalTransfer(address from, address to, uint256 amount)` — SOLO operadores
- `balances(address) → uint256` — balance de una cuenta
- `setOperator(address, bool)` — SOLO owner

**PerpEngine:**
- `constructor(address _vault, address _owner, address _feeRecipient, address _insuranceFund)`
- `addMarket(string name, uint256 initialMarginBps, uint256 maintenanceMarginBps, uint256 maxPositionSize, uint256 fundingIntervalSecs)` — SOLO owner
- `updateMarkPrice(bytes32 marketId, uint256 markPrice, uint256 indexPrice)` — SOLO operadores
- `openPosition(bytes32 marketId, address trader, int256 sizeDelta, uint256 price)` — SOLO operadores
- `closePosition(bytes32 marketId, address trader, uint256 price)` — SOLO operadores
- `liquidatePosition(bytes32 marketId, address trader, address keeper)` — SOLO operadores
- `isLiquidatable(bytes32 marketId, address trader) → bool` — view
- `getPosition(bytes32, address) → (int256 size, uint256 entry, uint256 margin, int256 pnl, uint256 marginRatio)` — view
- `positions(bytes32, address) → (int256 size, uint256 entryPrice, uint256 margin, int256 lastFunding, uint256 lastUpdated)` — raw storage
- Market ID se calcula: `keccak256(abi.encodePacked("BTC-USD"))` para un mercado llamado "BTC-USD"

**OrderSettlement:**
- `constructor(address _engine, address _vault, address _feeRecipient, address _owner)`
- `settleOne(MatchedTrade calldata trade)` — SOLO operadores
- `settleBatch(MatchedTrade[] calldata trades)` — SOLO operadores
- `ORDER_TYPEHASH` y `DOMAIN_SEPARATOR` — para firmas EIP-712
- La firma NO incluye marginAmount (el engine la calcula automáticamente)

**Liquidator:**
- `constructor(address _engine, address _insuranceFund, address _owner)`
- `liquidate(bytes32 marketId, address trader)` — CUALQUIERA puede llamar
- `liquidateBatch(bytes32[] marketIds, address[] traders)` — batch, skips silencioso

**InsuranceFund:**
- `constructor(address _vault, address _owner)`
- `recordBadDebt(bytes32 marketId, address trader, uint256 amount)` — SOLO operadores
- `payKeeperReward(address keeper, uint256 amount)` — SOLO operadores
- `balance() → uint256` — view

**OracleRouter:**
- `constructor(address _pyth, address _engine, address _owner)`
- `configureFeed(bytes32 marketId, bytes32 pythFeedId, address chainlinkFeed, uint256 maxStaleness, uint256 maxDeviation, uint256 maxConfidence)` — SOLO owner
- `pushPrice(bytes32 marketId)` — SOLO operadores
- `pushPriceWithPyth(bytes32 marketId, bytes[] pythUpdateData)` — SOLO operadores, payable

**Constantes importantes:**
- Precios: 6 decimales (USDC precision). $50,000 = `50_000_000_000`
- Tamaños: 8 decimales (SIZE_PRECISION). 1 BTC = `100_000_000`
- Funding: 18 decimales (FUNDING_PRECISION)
- BPS: 10,000 = 100%. 500 BPS = 5%

---

## PASO 3: CORRER LOS TESTS

### 3.1 Tests unitarios

```bash
cd contracts

# Correr TODOS los tests
forge test -vvv

# Si fallan, correr uno por uno para aislar:
forge test --match-contract PerpVaultTest -vvv
forge test --match-contract PerpEngineTest -vvv
forge test --match-contract OracleRouterTest -vvv
forge test --match-contract IntegrationTest -vvv
forge test --match-contract InvariantTest -vvv
```

### 3.2 Guía de troubleshooting de tests

**Error: "forge-std/Test.sol not found"**
→ Ejecutar: `forge install foundry-rs/forge-std --no-commit`

**Error: "function X not found in contract Y"**
→ La interfaz en el test no coincide con el contrato real. Verificar las firmas exactas listadas arriba en la sección 2.5.

**Error: "InsufficientBalance" o "revert"**
→ Probablemente falta fondear alguna cuenta en el setUp(). Los tests necesitan:
- Traders con USDC depositado en vault
- Insurance fund con balance (para cubrir payouts de profits)
- Engine necesita ser operador en vault
- Settlement/Liquidator necesitan ser operadores en engine

**Error: "StalePrice"**
→ El engine rechaza precios viejos. Después de `vm.warp()`, hay que actualizar el markPrice con `engine.updateMarkPrice()`.

**Error en OracleRouter test: "Price not set"**
→ MockPyth necesita que se setee el precio antes de leerlo: `mockPyth.setPrice(feedId, price, conf, expo, block.timestamp)`

### 3.3 REGLA PRIORITARIA

El test **Integration.t.sol** es el más importante. Si ese pasa, el protocolo funciona end-to-end. Priorizarlo sobre los unit tests individuales. El `test_fullLifecycle()` hace:

1. Deploy todos los contratos
2. Configura permisos
3. Alice y Bob firman órdenes EIP-712
4. Settlement ejecuta el trade
5. Verifica posiciones, margen, fees
6. Price se mueve a $55k
7. Verifica PnL
8. Bob es liquidado (keeper cobra reward)
9. Alice cierra con ganancia
10. Oracle push price
11. Alice retira USDC
12. Verifica invariantes globales

### 3.4 Tests Invariant

```bash
# Correr invariant tests (el fuzzer hace secuencias aleatorias)
forge test --match-contract InvariantTest -vvv

# Aumentar profundidad para más cobertura
forge test --match-contract InvariantTest --invariant-depth 100 -vvv
```

Las 4 invariantes verificadas:
1. **Vault Solvency**: USDC real >= totalDeposits
2. **Deposit/Withdraw Conservation**: USDC = totalDeposited - totalWithdrawn
3. **No Negative Balances**: sum(balances) <= totalDeposits
4. **Health Check**: vault.healthCheck() nunca falla

---

## PASO 4: ARREGLAR ERRORES DE COMPILACIÓN/TESTS

Si hay errores, esta es la estrategia de resolución:

### Prioridad 1: Compilación
1. Leer el error exacto de `forge build`
2. Si es un import path → verificar que `lib/forge-std` existe
3. Si es un type mismatch → verificar las firmas en ISurInterfaces.sol vs el contrato real
4. Si es un function not found → el test puede estar usando una API vieja

### Prioridad 2: Integration test
1. `forge test --match-test test_fullLifecycle -vvvv` (4 v's para máximo detalle)
2. Leer el stack trace para ver exactamente dónde revierte
3. Los errores más comunes son:
   - Operador no configurado (falta `setOperator`)
   - Balance insuficiente (falta `_fundTrader` o `_deposit`)
   - Precio stale (falta `updateMarkPrice` después de un `vm.warp`)

### Prioridad 3: Unit tests
1. Correr cada test file por separado
2. Los tests de PerpVault son los más estables (el contrato más simple)
3. Los tests de PerpEngine pueden necesitar ajustes en las assertions de balance
4. Los tests de OracleRouter dependen de MockPyth y MockChainlink

### Regla de oro para fixes:
- NUNCA cambiar la lógica de los contratos source para que un test pase
- SIEMPRE ajustar el test para que coincida con el comportamiento correcto del contrato
- La excepción es si encontrás un bug real en el contrato (ej: math incorrecta)

---

## PASO 5: MATCHING ENGINE (Rust)

```bash
cd engine

# Compilar
cargo build

# Correr tests
cargo test

# Correr con output detallado
cargo test -- --nocapture

# Correr la demo
RUST_LOG=sur_engine=debug cargo run
```

El engine es independiente de los contratos. Compila y testea por separado.

**Errores comunes:**
- Si falta una dependencia: `cargo update`
- Si hay errores de versión de Rust: `rustup update stable`

---

## PASO 6: ENVIRONMENT VARIABLES

```bash
cd ..  # volver a la raíz del proyecto

# Copiar template
cp .env.example .env

# Editar .env con tus valores:
# PRIVATE_KEY=tu_private_key_de_testnet (SIN 0x prefix)
# BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# BASESCAN_API_KEY=tu_api_key_de_basescan
```

**Para obtener las keys:**
1. **Private key**: Crear una wallet nueva en MetaMask, exportar private key. SOLO para testnet.
2. **Base Sepolia ETH**: Ir a https://www.alchemy.com/faucets/base-sepolia para gas
3. **Testnet USDC**: Ir a https://faucet.circle.com/ y pedir USDC en Base Sepolia
4. **Basescan API key**: Registrarse en https://basescan.org/apis

---

## PASO 7: DEPLOY A BASE SEPOLIA

Solo hacer esto DESPUÉS de que todos los tests pasen localmente.

```bash
cd contracts

# Cargar variables de entorno
source ../.env

# Deploy completo + integration test on-chain
forge script script/TestnetIntegration.s.sol:TestnetIntegration \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  -vvvv

# El script va a:
# 1. Deployar los 6 contratos
# 2. Configurar la cadena de permisos
# 3. Agregar mercados BTC-USD y ETH-USD
# 4. Setear precios iniciales
# 5. Testear deposit/withdraw si hay USDC disponible
# 6. Testear open/close position
# 7. Imprimir todas las addresses deployadas
```

**Guardar las addresses que imprime el script.** Las vas a necesitar para el frontend y el backend.

---

## PASO 8: VERIFICACIÓN POST-DEPLOY

```bash
# Verificar que los contratos están en Basescan
# Ir a https://sepolia.basescan.org/address/CONTRACT_ADDRESS

# Verificar que la cadena de permisos funciona
cast call CONTRACT_ADDRESS "owner()" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call VAULT_ADDRESS "operators(address)" ENGINE_ADDRESS --rpc-url $BASE_SEPOLIA_RPC_URL
```

---

## ESTRUCTURA FINAL DEL PROYECTO

```
sur-protocol/
├── .env.example                    # Template de variables de entorno
├── .gitignore
├── README.md                       # Documentación principal
├── setup.sh                        # Script de setup automático
├── docs/
│   └── ARCHITECTURE.md             # Diagramas de arquitectura
├── contracts/                      # Smart Contracts (Solidity + Foundry)
│   ├── foundry.toml                # Config de Foundry
│   ├── remappings.txt              # Import paths
│   ├── lib/                        # Dependencias (forge-std, se instala con forge install)
│   ├── src/                        # Contratos source (7 contratos + 4 interfaces + 1 library)
│   ├── test/                       # Tests (4 unit suites + 1 integration + 1 invariant)
│   └── script/                     # Deploy scripts (2 scripts)
└── engine/                         # Matching Engine (Rust)
    ├── Cargo.toml                  # Dependencias Rust
    ├── src/                        # Source (4 módulos: types, orderbook, matching, main)
    └── benches/                    # Benchmarks (placeholder)
```

## RESUMEN DE COMANDOS

```bash
# === SETUP ===
cd sur-protocol/contracts
forge install foundry-rs/forge-std --no-commit
forge build

# === TESTS ===
forge test -vvv                                          # todos
forge test --match-contract IntegrationTest -vvv         # el más importante
forge test --match-contract InvariantTest -vvv            # fuzzer
forge test --match-contract PerpVaultTest -vvv           # vault
forge test --match-contract PerpEngineTest -vvv          # engine
forge test --match-contract OracleRouterTest -vvv        # oracle

# === MATCHING ENGINE ===
cd ../engine
cargo build
cargo test

# === DEPLOY (después de que tests pasen) ===
cd ../contracts
forge script script/TestnetIntegration.s.sol:TestnetIntegration \
  --rpc-url base_sepolia --broadcast --verify -vvvv
```

---

## NOTAS PARA EL AGENTE

1. **No inventar código nuevo.** Todo el source code está en el tarball. Tu trabajo es hacer que compile y pase tests.
2. **Si un test falla, leer el contrato source primero.** La source of truth son los archivos en `src/`, no los tests.
3. **Los tests pueden necesitar ajustes menores** porque los contratos evolucionaron incrementalmente. Ajustar tests, no contratos.
4. **El Integration test es REY.** Si ese pasa, el protocolo funciona.
5. **Todos los contratos usan ISurInterfaces.sol** como fuente única de interfaces. Si hay mismatch, arreglar desde ahí.
6. **PerpEngine es el contrato más complejo** (808 líneas). Si hay bugs, probablemente estén ahí.
7. **La math financiera usa 6 decimales para precios/USDC y 8 decimales para sizes.** No confundir.
