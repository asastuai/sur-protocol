# 🔧 DIAGNÓSTICO Y CORRECCIONES — Aster Trading Bot v1.1

## Fecha del análisis: 25 Feb 2026
## Datos: 14 horas de paper trading, 145 trades, 376 señales

---

## 🚨 DIAGNÓSTICO: 5 Problemas Críticos Identificados

### PROBLEMA #1: OVERTRADING MASIVO
**Gravedad: 🔴 CRÍTICA**

- **145 trades en 14 horas = 10.4 trades/hora = 1 trade cada 6 minutos**
- Tiempo promedio entre trades: **1.8 minutos** — está entrando casi inmediatamente después de cerrar
- 11 trades abiertos **menos de 10 segundos** después del cierre anterior
- El cooldown de 60 segundos es insuficiente

**Consecuencia:** El bot está churning (moliendo) las fees. $21.26 en fees representa el **4.25% del capital** en un solo día. Si extrapolamos, son ~$600/mes solo en fees. Con este volumen, necesitás un edge altísimo solo para cubrir costos.

**FIX:**
```typescript
// En src/config.ts — cambiar:
signalCooldown: 60_000    // ❌ ACTUAL: 1 minuto
// Por:
signalCooldown: 300_000   // ✅ NUEVO: 5 minutos mínimo entre trades
```

---

### PROBLEMA #2: STOPS DEMASIADO AJUSTADOS (1x ATR)
**Gravedad: 🔴 CRÍTICA**

- ATR promedio al momento de señal: **$64.10**
- ATR como % del precio: **0.098%**
- Distancia promedio SL/TP real: **0.139%**
- Con x15 leverage, el noise normal del mercado te saca en segundos

**El número más revelador:** 33 trades (22.8%) duraron menos de 60 segundos. De esos, 24 fueron losses (73%). El bot entra y es barrido por el spread o un wick antes de que el trade se pueda desarrollar.

**Trades < 2 minutos: 66 trades (45.5%) con PnL de -$12.95** — Casi la mitad del trading fue ruido.

**FIX:**
```typescript
// En src/config.ts — cambiar:
SL_ATR_MULT: 1.0    // ❌ ACTUAL: SL a 1x ATR ($64)
TP_ATR_MULT: 2.0    // ❌ ACTUAL: TP a 2x ATR ($128)
// Por:
SL_ATR_MULT: 2.0    // ✅ NUEVO: SL a 2x ATR ($128) — más espacio para respirar
TP_ATR_MULT: 3.5    // ✅ NUEVO: TP a 3.5x ATR ($224) — mantiene R:R de 1:1.75
```

**Explicación:** En 1m candles, el ATR es muy chico (~$64 en BTC a $65K). Un stop a $64 del entry es básicamente 0.1% — con x15, cualquier wick de $70 te liquida. Necesitamos 2x ATR mínimo para sobrevivir el noise.

---

### PROBLEMA #3: SHORTS DESTRUYEN LA PERFORMANCE
**Gravedad: 🟡 ALTA**

- LONGS: 99 trades, **45.5% WR**, PnL: -$0.28 (casi breakeven)
- SHORTS: 46 trades, **30.4% WR**, PnL: **-$9.50** (desastre)

BTC subió 7.1% durante la sesión ($64,762 → $69,348). El bot estaba shorteando un rally de 7%. Los shorts con 30% WR destruyeron toda la sesión.

**FIX — Opción A (conservadora):** Deshabilitar shorts cuando el precio está en tendencia alcista fuerte:
```typescript
// En momentum-scalp.ts, agregar filtro de tendencia macro:
// Si el precio subió >1% en las últimas 4 horas, no tomar shorts
const priceChange4h = (currentPrice - candles1m[candles1m.length - 240]?.close) / candles1m[candles1m.length - 240]?.close;
if (priceChange4h > 0.01 && signal.side === 'SHORT') {
    return; // Skip short in strong uptrend
}
```

**FIX — Opción B (agresiva):** Solo tradear LONGs hasta que el bot sea profitable:
```typescript
// En config.ts, agregar:
ALLOWED_SIDES: 'LONG_ONLY'  // o 'BOTH' o 'SHORT_ONLY'
```

---

### PROBLEMA #4: CONDICIONES DE ENTRADA DEMASIADO RELAJADAS
**Gravedad: 🟡 ALTA**

- 376 señales generadas en 14 horas = 27 señales/hora
- 80.3% de señales son 4/5 condiciones — el mínimo permitido
- Solo 19.7% son señales "fuertes" (5/5)
- El bot entra en casi cualquier señal débil

**FIX:** Subir el mínimo a 5/5 condiciones, O agregar filtros adicionales:
```typescript
// En src/config.ts — cambiar:
MIN_SIGNALS_REQUIRED: 4    // ❌ ACTUAL: entra con 4 de 5
// Por:
MIN_SIGNALS_REQUIRED: 5    // ✅ NUEVO: solo entra con 5 de 5
```

**Alternativa mejor — agregar filtro de BB Width (volatilidad mínima):**
```typescript
// Solo entrar cuando BB Width > 0.3 (mercado tiene volatilidad suficiente)
// BB Width promedio fue 0.53 — muchas señales fueron en BB Width < 0.2 (mercado plano)
const minBBWidth = 0.25;
if (ind.bbWidth < minBBWidth) {
    return { type: 'NONE', ... }; // Skip en mercado plano
}
```

---

### PROBLEMA #5: NO HAY FILTRO ANTI-CHOP (mercado lateral)
**Gravedad: 🟡 ALTA**

- Horas 09-11 UTC: 30 trades, 26.7% WR, PnL: **-$6.19**
- El mercado estaba choppy (lateral) y el bot seguía tradeando sin parar

**FIX — Agregar "chop filter":**
```typescript
// Si las últimas 20 candles tienen un rango < 1.5x ATR, el mercado es choppy
const recentCandles = candles1m.slice(-20);
const rangeHigh = Math.max(...recentCandles.map(c => c.high));
const rangeLow = Math.min(...recentCandles.map(c => c.low));
const range = rangeHigh - rangeLow;

if (range < ind.atr * 1.5) {
    // Market is choppy, skip
    return { type: 'NONE', ... };
}
```

---

## ✅ RESUMEN DE CAMBIOS — Config Actualizado

```typescript
// ═══ ANTES vs DESPUÉS ═══

// Cooldown entre trades
signalCooldown: 60_000     →  300_000    // 1min → 5min

// Stop Loss / Take Profit
SL_ATR_MULT: 1.0           →  2.0       // 1x → 2x ATR
TP_ATR_MULT: 2.0           →  3.5       // 2x → 3.5x ATR

// Condiciones mínimas
MIN_SIGNALS_REQUIRED: 4    →  5         // 4/5 → 5/5

// Position sizing (reducir por SL más amplio)
POSITION_SIZE_PCT: 5       →  3         // 5% → 3% del capital

// Leverage (reducir para compensar SL más lejos)
DEFAULT_LEVERAGE: 15       →  12
LOW_VOL_LEVERAGE: 20       →  15
HIGH_VOL_LEVERAGE: 10      →  8

// NUEVO: Filtros adicionales
BB_WIDTH_MIN: 0.25          // No tradear en mercado plano
TREND_FILTER: true          // No shortear en uptrend > 1%/4h
CHOP_FILTER: true           // No tradear en chop (range < 1.5x ATR)
MAX_TRADES_PER_HOUR: 4      // Hard cap de frecuencia
```

---

## 📊 IMPACTO ESTIMADO DE LOS CAMBIOS

| Métrica | Antes | Proyectado |
|---------|-------|-----------|
| Trades/día | ~145 | ~25-40 |
| Win rate | 40.7% | 50-60% |
| Profit factor | 0.78 | 1.3-1.8 |
| Fees/día | $21.26 | $4-7 |
| Avg trade duration | 4.1 min | 10-20 min |
| Daily PnL | -$9.78 | +$2-8 (estimated) |

**Por qué estos cambios deberían funcionar:**
1. **Menos trades = menos fees** — De $21/día a $5/día = $16 ahorrados
2. **SL más ancho = menos barridos por noise** — Los trades sub-60s desaparecen
3. **Solo señales 5/5 = mayor convicción** — Filtra 80% de las señales malas
4. **Sin shorts en uptrend = dejar de pelear la tendencia**
5. **Chop filter = no quemar plata en mercados laterales**

---

## 🔧 CÓDIGO: Cambios Exactos

### 1. Actualizar config.ts

Reemplazar estos valores en `src/config.ts`:

```typescript
// Trading parameters
POSITION_SIZE_PCT: 3,        // era 5
DEFAULT_LEVERAGE: 12,        // era 15
LOW_VOL_LEVERAGE: 15,        // era 20
HIGH_VOL_LEVERAGE: 8,        // era 10

// Risk management
SL_ATR_MULT: 2.0,            // era 1.0
TP_ATR_MULT: 3.5,            // era 2.0
MIN_SIGNALS_REQUIRED: 5,     // era 4
```

### 2. Actualizar momentum-scalp.ts

Agregar estos filtros en el método `evaluate()`, antes de `generateSignal()`:

```typescript
// ═══ NUEVO: Filtros anti-chop y anti-trend ═══

// Filter 1: BB Width minimum (no trade in flat market)
if (indicators.bbWidth < 0.25) {
    this.logger.debug(`⏸️ BB Width ${indicators.bbWidth.toFixed(4)} < 0.25 — skipping (flat market)`);
    return;
}

// Filter 2: Chop filter (20-candle range vs ATR)
const recentCandles = this.candles1m.slice(-20);
const rangeHigh = Math.max(...recentCandles.map(c => c.high));
const rangeLow = Math.min(...recentCandles.map(c => c.low));
const range = rangeHigh - rangeLow;
if (range < indicators.atr * 1.5) {
    this.logger.debug(`⏸️ Chop detected: range $${range.toFixed(0)} < 1.5x ATR $${(indicators.atr * 1.5).toFixed(0)}`);
    return;
}

// Filter 3: Trend filter for shorts (don't short a rally)
if (this.candles1m.length >= 240) {
    const price4hAgo = this.candles1m[this.candles1m.length - 240].close;
    const priceChange4h = (this.currentPrice - price4hAgo) / price4hAgo;
    
    // Block shorts if price up >1% in 4h
    if (priceChange4h > 0.01) {
        // Only allow longs
        const signal = this.generateSignal(indicators);
        if (signal.side === 'SHORT') {
            this.logger.debug(`⏸️ Short blocked: +${(priceChange4h*100).toFixed(2)}% in 4h uptrend`);
            return;
        }
    }
    // Block longs if price down >1% in 4h
    if (priceChange4h < -0.01) {
        const signal = this.generateSignal(indicators);
        if (signal.side === 'LONG') {
            this.logger.debug(`⏸️ Long blocked: ${(priceChange4h*100).toFixed(2)}% in 4h downtrend`);
            return;
        }
    }
}

// Filter 4: Max trades per hour
const oneHourAgo = Date.now() - 3600000;
const recentTradeCount = this.executor.getClosedTradesAfter?.(oneHourAgo) || 0;
if (recentTradeCount >= 4) {
    this.logger.debug(`⏸️ Max trades/hour reached (${recentTradeCount}/4)`);
    return;
}
```

### 3. Actualizar signalCooldown en momentum-scalp.ts

```typescript
private signalCooldown = 300_000; // era 60_000 — ahora 5 minutos
```

---

## 📋 INSTRUCCIONES PARA EL AGENTE

1. **Parar el bot actual** (`Ctrl+C`)
2. Aplicar TODOS los cambios de arriba
3. **Reiniciar paper trading** con los nuevos parámetros
4. **Correr mínimo 12 horas más** con la nueva config
5. **Enviar nuevo reporte** a Claude para segundo análisis
6. **NO ir a live** hasta que el profit factor sea > 1.3 consistentemente

## ⚡ Métricas que necesito en el próximo reporte:
- Trades totales (debería ser 25-40 en 12h, no 145)
- Win rate (target: >50%)
- Profit factor (target: >1.3)
- Cuántos trades fueron filtrados por cada filtro nuevo
- PnL neto después de fees
