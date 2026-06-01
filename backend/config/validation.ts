import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  EXCHANGE_NAME: z.string().default('coingecko'),
  EXCHANGE_API_KEY: z.string().optional(),
  EXCHANGE_API_SECRET: z.string().optional(),
  EXCHANGE_API_PASSWORD: z.string().optional(),
  COINAPI_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  CRYPTOCOMPARE_API_KEY: z.string().optional(),
  EXCHANGE_USE_TESTNET: z.string().transform(v => v === 'true').default('true'),
  API_ADMIN_TOKEN: z.string().optional(),
  API_TRADER_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.string().transform(v => parseInt(v, 10)).default('3000'),
  DB_PATH: z.string().default('trading.db'),
  CORS_ORIGIN: z.string().optional(),

  // ML Layer
  ML_ENABLED: z.string().transform(v => v === 'true').default('false'),
  ML_PYTHON_BIN: z.string().default('python3'),
  ML_MODELS_DIR: z.string().default('./models'),
  ML_MIN_TRAINING_ROWS: z.string().transform(Number).default('10000'),
  ML_CONFIDENCE_THRESHOLD: z.string().transform(Number).default('0.58'),
  ML_EXIT_CHECKPOINTS: z.string().default('0.05,0.12,0.20,0.35,0.50,0.80'),
  ML_EXIT_CLOSE_ON_GREEN_AT: z.string().transform(Number).default('0.20'),
  ML_EXIT_FORCE_CLOSE_AT: z.string().transform(Number).default('0.92'),

  // ── v6.0 Phase 1: Regime Detection v2 ──
  ATR_PERCENTILE_LOOKBACK: z.string().transform(Number).default('8064'),
  ATR_PERCENTILE_BOOTSTRAP_MIN: z.string().transform(Number).default('288'),
  REGIME_STABILITY_GATING: z.string().transform(v => v === 'true').default('false'),

  // ── v6.0 Phase 1: Risk Safety ──
  DEGEN_LIVE_OVERRIDE: z.string().transform(v => v === 'true').default('false'),
  MAX_EFFECTIVE_RISK_FRACTION: z.string().transform(Number).default('0.005'),
  DEGEN_MAX_RISK_DOLLARS: z.string().transform(Number).default('500'),
  RISK_MODE_DEFAULT: z.string().default('conservative'),

  // ── v6.0 Phase 1: Slippage (ALL FRACTIONS) ──
  TAKER_FEE_RATE: z.string().transform(Number).default('0.0006'),
  MAKER_FEE_RATE: z.string().transform(Number).default('0.0001'),
  SLIPPAGE_SKIP_THRESHOLD: z.string().transform(Number).default('0.45'),
  FIXED_SLIPPAGE_FALLBACK: z.string().transform(Number).default('0.0005'),

  // ── v6.0 Phase 1: Execution Locking ──
  TRADE_LOCK_TTL_MS: z.string().transform(Number).default('8000'),

  // ── v6.0 Phase 2: ATR Ratchet ──
  RATCHET_CALIBRATED: z.string().transform(v => v === 'true').default('false'),

  // ── v6.0 Phase 2: Gemma AI ──
  GEMMA_ENABLED: z.string().transform(v => v === 'true').default('true'),
  GEMMA_TIMEOUT_MS: z.string().transform(Number).default('2000'),
  GEMMA_MIN_CONF_SCORE: z.string().transform(Number).default('70'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gemma4'),

  // ── v6.0 Phase 2/3: ML ──
  ML_ENTRY_FILTER_THRESHOLD: z.string().transform(Number).default('0.55'),
});

export type EnvConfig = z.infer<typeof envSchema>;
