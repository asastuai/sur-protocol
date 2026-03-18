# 🚀 Aster DEX — Momentum Scalp Bot

## Para el agente (OpenClaw/Sonnet): Instrucciones de Setup

### Paso 1: Prerequisitos
```bash
# Instalar Bun si no está instalado
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc  # o reiniciar terminal

# Verificar
bun --version
```

### Paso 2: Instalar el proyecto
```bash
cd /ruta/donde/colocar/el/bot
# Copiar todos los archivos del bot aquí

# Instalar dependencias
bun install

# Copiar y configurar .env
cp .env.example .env
# Editar .env con las API keys del usuario
```

### Paso 3: Correr Paper Trading (EMPEZAR ACÁ)
```bash
# Paper trading con BTC (default)
bun run paper

# Paper trading con ETH
bun run paper:eth

# Paper trading con SOL
bun run paper:sol
```

### Paso 4: Monitorear
- El bot imprime status cada 30 segundos
- Los logs se guardan en `./logs/`
- Las trades se logean en CSV en `./logs/trades-YYYY-MM-DD.csv`
- Las señales se logean en `./logs/signals-YYYY-MM-DD.csv`

### Paso 5: Generar Reporte
- Presionar `Ctrl+C` para parar el bot
- Se genera automáticamente un reporte en `./reports/`
- Compartir el reporte con Claude para análisis

### Paso 6: Solo después de 24h+ de paper trading exitoso
```bash
# LIVE TRADING (con dinero real)
bun run live
```

## Estructura del Proyecto

```
aster-bot/
├── index.ts                          # Entry point + CLI
├── package.json                      # Scripts y deps
├── tsconfig.json                     # TypeScript config
├── .env.example                      # Template de configuración
├── .env                              # Config real (NO commitear)
├── src/
│   ├── config.ts                     # Configuración centralizada
│   ├── types.ts                      # Tipos compartidos
│   ├── engines/
│   │   └── momentum-scalp.ts         # Estrategia principal
│   ├── executors/
│   │   ├── paper-executor.ts         # Paper trading (simulado)
│   │   └── live-executor.ts          # Live trading (real)
│   ├── gateway/
│   │   └── aster-gateway.ts          # REST + WebSocket Aster API
│   ├── indicators/
│   │   └── technical.ts              # EMA, RSI, MFI, BB, ATR
│   └── utils/
│       └── logger.ts                 # Logging + reportes
├── logs/                             # Logs diarios (auto-generado)
│   ├── bot-YYYY-MM-DD.log
│   ├── trades-YYYY-MM-DD.csv
│   └── signals-YYYY-MM-DD.csv
└── reports/                          # Reportes (auto-generado)
    ├── report-TIMESTAMP.json
    └── report-TIMESTAMP.txt
```

## Estrategia: Momentum Scalp

### Indicadores
- **EMA Triple** (8/21/48): Cruces para dirección
- **RSI** (14): Momentum y oversold/overbought
- **MFI** (14): Flujo de dinero (volumen-weighted RSI)
- **Bollinger Bands** (20, 2σ): Volatilidad y extremos
- **ATR** (14): Stop Loss / Take Profit dinámicos

### Reglas de Entrada
- LONG: EMA8 > EMA21 + RSI subiendo > 40 + MFI > 50 + Precio > EMA48 + Volumen alto
- SHORT: EMA8 < EMA21 + RSI bajando < 60 + MFI < 50 + Precio < EMA48 + Volumen alto
- Se necesitan 4 de 5 condiciones para abrir

### Risk Management
- SL: 1x ATR desde entrada
- TP: 2x ATR desde entrada (ratio 1:2)
- Trailing Stop: Activa en +1%, trail 0.5%
- Max 2 posiciones simultáneas
- Circuit breaker: -10% diario, -20% semanal
- Leverage adaptivo: x10 (alta vol), x15 (normal), x20 (baja vol)

## Fees en Aster Pro Mode (API)
- Maker: 0.00% (gratis!)
- Taker: 0.02%

## Notas Importantes
1. **SIEMPRE empezar con paper trading** mínimo 24 horas
2. **NUNCA operar sin stop loss** — con x20 leverage un 5% te liquida
3. **Los logs son tu mejor amigo** — revisar signals.csv para entender por qué el bot toma decisiones
4. **Compartir reportes con Claude** para ajuste de parámetros
