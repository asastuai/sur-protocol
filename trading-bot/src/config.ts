// ============================================================
// src/config.ts — Configuration & Environment
// ============================================================

export interface Config {
  // API
  ASTER_API_KEY: string;
  ASTER_API_SECRET: string;
  REST_BASE_URL: string;
  WS_BASE_URL: string;

  // Trading
  DEFAULT_LEVERAGE: number;
  LOW_VOL_LEVERAGE: number;
  HIGH_VOL_LEVERAGE: number;
  TRADE_SYMBOL: string;
  POSITION_SIZE_PCT: number;   // % of capital per trade
  STARTING_CAPITAL: number;

  // Indicators
  EMA_FAST: number;
  EMA_MID: number;
  EMA_SLOW: number;
  RSI_PERIOD: number;
  MFI_PERIOD: number;
  BB_PERIOD: number;
  BB_STDDEV: number;
  ATR_PERIOD: number;
  VOLUME_MULT: number;         // Volume confirmation multiplier

  // Risk Management
  SL_ATR_MULT: number;         // SL = entry ± (ATR × this)
  TP_ATR_MULT: number;         // TP = entry ± (ATR × this)
  TRAILING_ACTIVATION_PCT: number;  // Activate trailing at this % profit
  TRAILING_CALLBACK_PCT: number;    // Trail by this %
  MAX_CONCURRENT_POSITIONS: number;
  MAX_DAILY_LOSS_PCT: number;       // Circuit breaker: max daily loss %
  MAX_WEEKLY_LOSS_PCT: number;      // Circuit breaker: max weekly loss %
  MIN_SIGNALS_REQUIRED: number;     // Minimum conditions met (out of 5)

  // Timing
  KLINE_INTERVAL: string;
  WARMUP_CANDLES: number;

  // Logging
  LOG_DIR: string;
  REPORT_DIR: string;
  VERBOSE: boolean;

  // v2.0 — Market Brain
  BRAIN_INTERVAL_MS: number;
  MIN_CONFIDENCE_SCALP: number;
  MIN_CONFIDENCE_MOMENTUM: number;
  MIN_CONFIDENCE_SWING: number;

  // v2.0 — Scalp Engine
  SCALP_SL_ATR_MULT: number;
  SCALP_TP_ATR_MULT: number;
  SCALP_MARGIN_PCT: number;
  SCALP_COOLDOWN_MS: number;
  SCALP_MIN_BB_WIDTH: number;
  SCALP_DEFAULT_LEVERAGE: number;
  SCALP_MAX_PER_HOUR: number;

  // v2.0 — Momentum Engine
  MOMENTUM_SL_ATR_MULT_5M: number;
  MOMENTUM_TP_ATR_MULT_5M: number;
  MOMENTUM_MARGIN_PCT: number;
  MOMENTUM_COOLDOWN_MS: number;
  MOMENTUM_DEFAULT_LEVERAGE: number;
  MOMENTUM_TRAILING_ACTIVATION: number;
  MOMENTUM_TRAILING_CALLBACK: number;

  // v2.0 — Swing Engine
  SWING_MARGIN_FIXED: number;
  SWING_LEVERAGE_MIN: number;
  SWING_LEVERAGE_MAX: number;
  SWING_COOLDOWN_MS: number;
  SWING_TRAILING_ACTIVATION: number;
  SWING_TRAILING_CALLBACK: number;
  SWING_MAX_CONCURRENT: number;

  // v2.0 — Capitulation/Euphoria Detection
  CAPITULATION_RSI_THRESHOLD: number;
  CAPITULATION_MFI_THRESHOLD: number;
  CAPITULATION_CONSEC_RED: number;
  EUPHORIA_RSI_THRESHOLD: number;
  EUPHORIA_MFI_THRESHOLD: number;
  EUPHORIA_CONSEC_GREEN: number;

  // v2.0 — Position Manager
  MAX_TOTAL_EXPOSURE_PCT: number;
  MAX_TOTAL_POSITIONS: number;

  // v3.0 — Brain v2
  STRUCTURE_LOOKBACK_BARS: number;
  DIVERGENCE_LOOKBACK_BARS: number;
  EXHAUSTION_THRESHOLD: number;

  // v3.0 — REVERSAL Engine
  REVERSAL_ENABLED: boolean;
  REVERSAL_MARGIN: number;
  REVERSAL_DEFAULT_LEVERAGE: number;
  REVERSAL_MAX_LEVERAGE: number;
  REVERSAL_SL_ATR_MULT: number;
  REVERSAL_TP_ATR_MULT: number;
  REVERSAL_COOLDOWN_MS: number;
  REVERSAL_MAX_PER_HOUR: number;
  REVERSAL_MIN_EXHAUSTION: number;
  REVERSAL_MIN_CONFIRMATIONS: number;
  REVERSAL_TRAILING_ACTIVATION: number;
  REVERSAL_TRAILING_CALLBACK: number;

  // v3.0 — SNIPER Engine
  SNIPER_ENABLED: boolean;
  SNIPER_MARGIN: number;
  SNIPER_DEFAULT_LEVERAGE: number;
  SNIPER_MAX_LEVERAGE: number;
  SNIPER_MIN_BRAIN_CONFIDENCE: number;
  SNIPER_MIN_LEVEL_STRENGTH: number;
  SNIPER_COOLDOWN_MS: number;
  SNIPER_MAX_PER_HOUR: number;
  SNIPER_MIN_RR_RATIO: number;
  SNIPER_TRAILING_ACTIVATION: number;
  SNIPER_TRAILING_CALLBACK: number;

  // v3.0 — BREAKOUT RETEST Engine
  BREAKOUT_RETEST_ENABLED: boolean;
  BREAKOUT_RETEST_MARGIN: number;
  BREAKOUT_RETEST_DEFAULT_LEVERAGE: number;
  BREAKOUT_RETEST_MAX_LEVERAGE: number;
  BREAKOUT_RETEST_SL_ATR_MULT: number;
  BREAKOUT_RETEST_TP_ATR_MULT: number;
  BREAKOUT_RETEST_COOLDOWN_MS: number;
  BREAKOUT_RETEST_MAX_PER_HOUR: number;
  BREAKOUT_RETEST_MIN_BARS_SINCE_BREAKOUT: number;
  BREAKOUT_RETEST_MAX_BARS_SINCE_BREAKOUT: number;
  BREAKOUT_RETEST_RETEST_ZONE_PCT: number;
  BREAKOUT_RETEST_TRAILING_ACTIVATION: number;
  BREAKOUT_RETEST_TRAILING_CALLBACK: number;

  // v3.0 — GRID Engine
  GRID_ENABLED: boolean;
  GRID_MARGIN: number;
  GRID_DEFAULT_LEVERAGE: number;
  GRID_MAX_LEVERAGE: number;
  GRID_COOLDOWN_MS: number;
  GRID_MAX_CONCURRENT: number;
  GRID_MIN_RANGE_PCT: number;
  GRID_MAX_RANGE_PCT: number;
  GRID_RANGE_LOOKBACK_1M: number;
  GRID_MAX_BRAIN_CONFIDENCE: number;
  GRID_MAX_BB_WIDTH: number;

  // v3.1 — TREND_FOLLOW Engine (NEW)
  TREND_FOLLOW_ENABLED: boolean;
  TREND_FOLLOW_MARGIN: number;
  TREND_FOLLOW_DEFAULT_LEVERAGE: number;
  TREND_FOLLOW_MAX_LEVERAGE: number;
  TREND_FOLLOW_MIN_CONFIDENCE: number;
  TREND_FOLLOW_SL_ATR_MULT: number;
  TREND_FOLLOW_COOLDOWN_MS: number;
  TREND_FOLLOW_MAX_PER_HOUR: number;
  TREND_FOLLOW_TRAILING_ACTIVATION: number;
  TREND_FOLLOW_TRAILING_CALLBACK: number;

  // v4.0 — Structure-First engines
  LEVEL_BOUNCE_MARGIN_ALIGNED: number;
  LEVEL_BOUNCE_MARGIN_COUNTER: number;
  LEVEL_BOUNCE_LEVERAGE_ALIGNED: number;
  LEVEL_BOUNCE_LEVERAGE_COUNTER: number;
  LEVEL_BOUNCE_MIN_LEVEL_STRENGTH: number;
  LEVEL_BOUNCE_MAX_DIST_PCT: number;
  LEVEL_BOUNCE_COOLDOWN_MS: number;
  LEVEL_BOUNCE_MAX_PER_HOUR: number;
  LEVEL_BOUNCE_TRAILING_ACTIVATION: number;
  LEVEL_BOUNCE_TRAILING_CALLBACK: number;

  BREAKOUT_PLAY_RETEST_MARGIN_ALIGNED: number;
  BREAKOUT_PLAY_RETEST_MARGIN_COUNTER: number;
  BREAKOUT_PLAY_CONTINUATION_MARGIN: number;
  BREAKOUT_PLAY_LEVERAGE: number;
  BREAKOUT_PLAY_CONT_LEVERAGE: number;
  BREAKOUT_PLAY_RETEST_ZONE_PCT: number;
  BREAKOUT_PLAY_MIN_BARS: number;
  BREAKOUT_PLAY_MAX_BARS: number;
  BREAKOUT_PLAY_CONT_MIN_VOL: number;
  BREAKOUT_PLAY_COOLDOWN_MS: number;
  BREAKOUT_PLAY_MAX_PER_HOUR: number;
  BREAKOUT_PLAY_TRAILING_ACTIVATION: number;
  BREAKOUT_PLAY_TRAILING_CALLBACK: number;

  EXHAUSTION_REVERSAL_MARGIN_3CONF: number;
  EXHAUSTION_REVERSAL_MARGIN_2CONF: number;
  EXHAUSTION_REVERSAL_MIN_EXHAUSTION: number;
  EXHAUSTION_REVERSAL_MIN_CONFIRMATIONS: number;
  EXHAUSTION_REVERSAL_SL_ATR_MULT: number;
  EXHAUSTION_REVERSAL_TP_ATR_MULT: number;
  EXHAUSTION_REVERSAL_COOLDOWN_MS: number;
  EXHAUSTION_REVERSAL_MAX_PER_HOUR: number;
  EXHAUSTION_REVERSAL_TRAILING_ACTIVATION: number;
  EXHAUSTION_REVERSAL_TRAILING_CALLBACK: number;

  TREND_RIDER_MARGIN: number;
  TREND_RIDER_LEVERAGE: number;
  TREND_RIDER_SL_ATR_MULT: number;
  TREND_RIDER_MAX_EXHAUSTION: number;
  TREND_RIDER_COOLDOWN_MS: number;
  TREND_RIDER_MAX_PER_HOUR: number;
  TREND_RIDER_TRAILING_ACTIVATION: number;
  TREND_RIDER_TRAILING_CALLBACK: number;

  // v6.0 — Macro Filter
  MACRO_FILTER_ENABLED: boolean;
  MACRO_FILTER_INTERVAL_MS: number;
  MACRO_MIN_5M_CANDLES: number;

  // v6.0 — Circuit Breaker
  CB_MAX_CONSEC_SL: number;
  CB_SL_WINDOW_MS: number;
  CB_PAUSE_DURATION_MS: number;
  CB_MAX_TRADES_PER_DAY: number;
  CB_MAX_TRADES_PER_ENGINE: number;
  CB_MAX_DAILY_LOSS_ABS: number;
  CB_LOSS_STREAK_COOLDOWN_MULT: number;

  // v7.0 — Swing Engine (winner config)
  SWING_SL_PCT: number;
  SWING_TP_PCT: number;
  SWING_LEVERAGE: number;
  MAX_POSITIONS_SWING: number;
  BULL_SWING_LONG: boolean;
  HTF_FILTER_ENABLED: boolean;
  CAPITAL: number;              // alias of STARTING_CAPITAL for swing-engine
}

export function loadConfig(): Config {
  return {
    // API credentials (from .env)
    // ASTER_API_KEY is reused as agent wallet address for SUR Protocol
    ASTER_API_KEY: process.env.SUR_AGENT_ADDRESS || process.env.ASTER_API_KEY || '',
    ASTER_API_SECRET: process.env.SUR_AGENT_KEY || process.env.ASTER_API_SECRET || '',
    REST_BASE_URL: process.env.SUR_API_URL || process.env.REST_BASE_URL || 'http://localhost:3003',
    WS_BASE_URL: process.env.SUR_WS_URL || process.env.WS_BASE_URL || 'ws://localhost:3002',

    // Trading parameters
    DEFAULT_LEVERAGE: Number(process.env.DEFAULT_LEVERAGE) || 12,      // v1.1: era 15
    LOW_VOL_LEVERAGE: Number(process.env.LOW_VOL_LEVERAGE) || 15,      // v1.1: era 20
    HIGH_VOL_LEVERAGE: Number(process.env.HIGH_VOL_LEVERAGE) || 8,     // v1.1: era 10
    TRADE_SYMBOL: process.env.TRADE_SYMBOL || 'BTCUSDT',
    POSITION_SIZE_PCT: Number(process.env.POSITION_SIZE_PCT) || 3,     // v1.1: era 5
    STARTING_CAPITAL: Number(process.env.STARTING_CAPITAL) || 1000,

    // Indicator settings
    EMA_FAST: 8,
    EMA_MID: 21,
    EMA_SLOW: 48,
    RSI_PERIOD: 14,
    MFI_PERIOD: 14,
    BB_PERIOD: 20,
    BB_STDDEV: 2,
    ATR_PERIOD: 14,
    VOLUME_MULT: 1.5,

    // Risk management — v1.1 (Opus diagnosis)
    SL_ATR_MULT: 2.0,                  // era 1.0 — más espacio para respirar
    TP_ATR_MULT: 3.5,                  // era 2.0 — mantiene R:R 1:1.75
    TRAILING_ACTIVATION_PCT: 1.5,
    TRAILING_CALLBACK_PCT: 0.5,
    MAX_CONCURRENT_POSITIONS: 2,
    MAX_DAILY_LOSS_PCT: 10,
    MAX_WEEKLY_LOSS_PCT: 20,
    MIN_SIGNALS_REQUIRED: 5,           // era 4 — solo señales 5/5

    // Timing
    KLINE_INTERVAL: '1m',
    WARMUP_CANDLES: 200,

    // Logging
    LOG_DIR: './logs',
    REPORT_DIR: './reports',
    VERBOSE: process.argv.includes('--verbose'),

    // v2.0 — Market Brain — ★ v5.0: lower MOMENTUM confidence irrelevant (disabled), adjust SCALP
    BRAIN_INTERVAL_MS: 180_000,
    MIN_CONFIDENCE_SCALP: 65,    // v5.0: 60→65 — only clear trends
    MIN_CONFIDENCE_MOMENTUM: 65,    // irrelevant — MOMENTUM disabled
    MIN_CONFIDENCE_SWING: 65,       // v5.0: 70→65 — SWING is best engine, let it fire more

    // v2.0 — Scalp Engine — ★ v5.0: Less frequent, bigger TP per trade
    SCALP_SL_ATR_MULT: 2.3,
    SCALP_TP_ATR_MULT: 4.0,            // v5.0: 3.5→4.0 — bigger wins per trade
    SCALP_MARGIN_PCT: 5,
    SCALP_COOLDOWN_MS: 420_000,         // v5.0: 5min→7min — less overtrading
    SCALP_MIN_BB_WIDTH: 0.30,           // v5.0: 0.25→0.30 — stricter chop filter
    SCALP_DEFAULT_LEVERAGE: 10,
    SCALP_MAX_PER_HOUR: 2,

    // v2.0 — Momentum Engine — ★ DISABLED v5.0: -$123 net, PF 0.22, worst engine by far
    MOMENTUM_SL_ATR_MULT_5M: 4.0,
    MOMENTUM_TP_ATR_MULT_5M: 8.0,
    MOMENTUM_MARGIN_PCT: 5,
    MOMENTUM_COOLDOWN_MS: 900_000,
    MOMENTUM_DEFAULT_LEVERAGE: 7,
    MOMENTUM_TRAILING_ACTIVATION: 3.5,
    MOMENTUM_TRAILING_CALLBACK: 2.5,

    // v2.0 — Swing Engine — ★ v5.0: BEST ENGINE (PF 2.18) → more aggressive
    SWING_MARGIN_FIXED: Number(process.env.SWING_MARGIN_FIXED) || 200,
    SWING_LEVERAGE_MIN: 6,       // v5.0: 5→6
    SWING_LEVERAGE_MAX: 8,       // v5.0: 7→8
    SWING_COOLDOWN_MS: 1_200_000,        // v5.0: 30min→20min — more opportunities
    SWING_TRAILING_ACTIVATION: 1.2,      // v5.0: 1.5→1.2 — lock profit earlier
    SWING_TRAILING_CALLBACK: 1.0,        // v5.0: 1.2→1.0 — tighter trail, keep more profit
    SWING_MAX_CONCURRENT: 2,     // v5.0: 1→2 — allow parallel swing positions

    // v2.0 — Capitulation/Euphoria Detection
    CAPITULATION_RSI_THRESHOLD: 22,
    CAPITULATION_MFI_THRESHOLD: 20,
    CAPITULATION_CONSEC_RED: 4,
    EUPHORIA_RSI_THRESHOLD: 78,
    EUPHORIA_MFI_THRESHOLD: 80,
    EUPHORIA_CONSEC_GREEN: 4,

    // v2.0 — Position Manager — ★ v5.0: More aggressive multi-engine
    MAX_TOTAL_EXPOSURE_PCT: 45,   // v5.0: 35%→45% — more capital deployed
    MAX_TOTAL_POSITIONS: 5,       // v5.0: 4→5 — all engines competing

    // v3.0 — Brain v2
    STRUCTURE_LOOKBACK_BARS: 200,
    DIVERGENCE_LOOKBACK_BARS: 25,
    EXHAUSTION_THRESHOLD: 60,

    // v3.0 — REVERSAL Engine
    REVERSAL_ENABLED: true,
    REVERSAL_MARGIN: 100,
    REVERSAL_DEFAULT_LEVERAGE: 8,
    REVERSAL_MAX_LEVERAGE: 10,
    REVERSAL_SL_ATR_MULT: 1.5,
    REVERSAL_TP_ATR_MULT: 5.0,
    REVERSAL_COOLDOWN_MS: 600_000,        // 10 min
    REVERSAL_MAX_PER_HOUR: 3,
    REVERSAL_MIN_EXHAUSTION: 60,
    REVERSAL_MIN_CONFIRMATIONS: 2,
    REVERSAL_TRAILING_ACTIVATION: 1.5,
    REVERSAL_TRAILING_CALLBACK: 0.7,

    // v3.0 — SNIPER Engine
    SNIPER_ENABLED: true,
    SNIPER_MARGIN: 140,
    SNIPER_DEFAULT_LEVERAGE: 6,
    SNIPER_MAX_LEVERAGE: 8,
    SNIPER_MIN_BRAIN_CONFIDENCE: 70,  // v3.2: 75→70 — solo 2 trades en 3 días, muy restrictivo
    SNIPER_MIN_LEVEL_STRENGTH: 35,    // v3.2: 45→35 — ampliar para disparar más
    SNIPER_COOLDOWN_MS: 900_000,      // v3.2: 20min→15min
    SNIPER_MAX_PER_HOUR: 1,
    SNIPER_MIN_RR_RATIO: 2.5,
    SNIPER_TRAILING_ACTIVATION: 3.0,  // v3.2: 2.0→3.0 — trailing cerraba en breakeven
    SNIPER_TRAILING_CALLBACK: 1.0,

    // v3.0 — BREAKOUT RETEST Engine — ★ v5.0: Proven structure, more aggressive
    BREAKOUT_RETEST_ENABLED: true,
    BREAKOUT_RETEST_MARGIN: 250,              // v5.0: $350→$250 — controlled risk, still significant
    BREAKOUT_RETEST_DEFAULT_LEVERAGE: 10,
    BREAKOUT_RETEST_MAX_LEVERAGE: 12,         // v5.0: 10→12 — more aggressive on high conf
    BREAKOUT_RETEST_SL_ATR_MULT: 1.0,
    BREAKOUT_RETEST_TP_ATR_MULT: 5.0,        // v5.0: 6→5 — more realistic TP, higher hit rate
    BREAKOUT_RETEST_COOLDOWN_MS: 300_000,
    BREAKOUT_RETEST_MAX_PER_HOUR: 4,         // v5.0: 6→4 — quality over quantity
    BREAKOUT_RETEST_MIN_BARS_SINCE_BREAKOUT: 5,
    BREAKOUT_RETEST_MAX_BARS_SINCE_BREAKOUT: 30,
    BREAKOUT_RETEST_RETEST_ZONE_PCT: 0.004,
    BREAKOUT_RETEST_TRAILING_ACTIVATION: 2.0, // v5.0: 2.5→2.0 — lock profit earlier
    BREAKOUT_RETEST_TRAILING_CALLBACK: 0.6,   // v5.0: 0.8→0.6 — tighter trail

    // v3.0 — GRID Engine
    GRID_ENABLED: true,
    GRID_MARGIN: 60,
    GRID_DEFAULT_LEVERAGE: 5,
    GRID_MAX_LEVERAGE: 8,
    GRID_COOLDOWN_MS: 180_000,            // 3 min
    GRID_MAX_CONCURRENT: 2,
    GRID_MIN_RANGE_PCT: 0.1,
    GRID_MAX_RANGE_PCT: 1.0,
    GRID_RANGE_LOOKBACK_1M: 60,
    GRID_MAX_BRAIN_CONFIDENCE: 35,
    GRID_MAX_BB_WIDTH: 0.30,

    // v3.1 — TREND_FOLLOW Engine — ★ v5.0: Tighter SL, more aggressive capture
    TREND_FOLLOW_ENABLED: true,
    TREND_FOLLOW_MARGIN: 120,              // v5.0: $100→$120 — slight boost
    TREND_FOLLOW_DEFAULT_LEVERAGE: 7,      // v5.0: 6→7
    TREND_FOLLOW_MAX_LEVERAGE: 8,
    TREND_FOLLOW_MIN_CONFIDENCE: 65,       // v5.0: 60→65 — more selective
    TREND_FOLLOW_SL_ATR_MULT: 1.5,        // v5.0: 2.0→1.5 — CRITICAL: avg SL loss was -$13.53, need tighter
    TREND_FOLLOW_COOLDOWN_MS: 900_000,
    TREND_FOLLOW_MAX_PER_HOUR: 2,
    TREND_FOLLOW_TRAILING_ACTIVATION: 1.5, // v5.0: 2.0→1.5 — lock profit sooner
    TREND_FOLLOW_TRAILING_CALLBACK: 1.0,   // v5.0: 1.2→1.0 — tighter trail

    // ── v4.0: Structure-First engines ──
    LEVEL_BOUNCE_MARGIN_ALIGNED: 100,
    LEVEL_BOUNCE_MARGIN_COUNTER: 75,
    LEVEL_BOUNCE_LEVERAGE_ALIGNED: 8,
    LEVEL_BOUNCE_LEVERAGE_COUNTER: 6,
    LEVEL_BOUNCE_MIN_LEVEL_STRENGTH: 40,
    LEVEL_BOUNCE_MAX_DIST_PCT: 0.3,
    LEVEL_BOUNCE_COOLDOWN_MS: 600_000,
    LEVEL_BOUNCE_MAX_PER_HOUR: 2,
    LEVEL_BOUNCE_TRAILING_ACTIVATION: 2.0,
    LEVEL_BOUNCE_TRAILING_CALLBACK: 1.2,

    BREAKOUT_PLAY_RETEST_MARGIN_ALIGNED: 150,
    BREAKOUT_PLAY_RETEST_MARGIN_COUNTER: 120,
    BREAKOUT_PLAY_CONTINUATION_MARGIN: 120,
    BREAKOUT_PLAY_LEVERAGE: 8,
    BREAKOUT_PLAY_CONT_LEVERAGE: 7,
    BREAKOUT_PLAY_RETEST_ZONE_PCT: 0.004,
    BREAKOUT_PLAY_MIN_BARS: 5,
    BREAKOUT_PLAY_MAX_BARS: 30,
    BREAKOUT_PLAY_CONT_MIN_VOL: 2.0,
    BREAKOUT_PLAY_COOLDOWN_MS: 600_000,
    BREAKOUT_PLAY_MAX_PER_HOUR: 3,
    BREAKOUT_PLAY_TRAILING_ACTIVATION: 2.5,
    BREAKOUT_PLAY_TRAILING_CALLBACK: 1.5,

    EXHAUSTION_REVERSAL_MARGIN_3CONF: 100,
    EXHAUSTION_REVERSAL_MARGIN_2CONF: 75,
    EXHAUSTION_REVERSAL_MIN_EXHAUSTION: 55,
    EXHAUSTION_REVERSAL_MIN_CONFIRMATIONS: 2,
    EXHAUSTION_REVERSAL_SL_ATR_MULT: 1.5,
    EXHAUSTION_REVERSAL_TP_ATR_MULT: 5.0,
    EXHAUSTION_REVERSAL_COOLDOWN_MS: 900_000,
    EXHAUSTION_REVERSAL_MAX_PER_HOUR: 2,
    EXHAUSTION_REVERSAL_TRAILING_ACTIVATION: 2.0,
    EXHAUSTION_REVERSAL_TRAILING_CALLBACK: 1.0,

    TREND_RIDER_MARGIN: 120,               // v5.0: $100→$120
    TREND_RIDER_LEVERAGE: 8,               // v5.0: 7→8
    TREND_RIDER_SL_ATR_MULT: 2.5,         // v5.0: 3.0→2.5 — tighter SL
    TREND_RIDER_MAX_EXHAUSTION: 50,
    TREND_RIDER_COOLDOWN_MS: 900_000,      // v5.0: 20min→15min
    TREND_RIDER_MAX_PER_HOUR: 2,
    TREND_RIDER_TRAILING_ACTIVATION: 2.5,  // v5.0: 3.0→2.5 — lock sooner
    TREND_RIDER_TRAILING_CALLBACK: 1.5,    // v5.0: 2.0→1.5 — tighter

    // v6.0 — Macro Filter
    MACRO_FILTER_ENABLED: true,
    MACRO_FILTER_INTERVAL_MS: 300_000,     // 5 minutes
    MACRO_MIN_5M_CANDLES: 1200,            // ~4 days of 5m candles

    // v6.0 — Circuit Breaker
    CB_MAX_CONSEC_SL: 3,                   // 3 SLs en ventana → pause engine
    CB_SL_WINDOW_MS: 6 * 3_600_000,       // ventana 6h
    CB_PAUSE_DURATION_MS: 12 * 3_600_000, // pausa 12h
    CB_MAX_TRADES_PER_DAY: Number(process.env.CB_MAX_TRADES_PER_DAY) || 10,
    CB_MAX_TRADES_PER_ENGINE: 4,
    CB_MAX_DAILY_LOSS_ABS: Number(process.env.CB_MAX_DAILY_LOSS_ABS) || 60,
    CB_LOSS_STREAK_COOLDOWN_MULT: 2.0,

    // v7.0 — Swing Engine (winner config: Sharpe=3.38, MaxDD=3.55%)
    SWING_SL_PCT: Number(process.env.SWING_SL_PCT) || 1.0,
    SWING_TP_PCT: Number(process.env.SWING_TP_PCT) || 5.0,
    SWING_LEVERAGE: Number(process.env.SWING_LEVERAGE) || 6,
    MAX_POSITIONS_SWING: Number(process.env.MAX_POSITIONS_SWING) || 1,
    BULL_SWING_LONG: process.env.BULL_SWING_LONG !== 'false',
    HTF_FILTER_ENABLED: process.env.HTF_FILTER !== 'off',
    CAPITAL: Number(process.env.STARTING_CAPITAL) || 650,
  };
}

