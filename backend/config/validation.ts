import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  EXCHANGE_NAME: z.string().default('coinmarketcap'),
  EXCHANGE_API_KEY: z.string().optional(),
  EXCHANGE_API_SECRET: z.string().optional(),
  EXCHANGE_API_PASSWORD: z.string().optional(),
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
});

export type EnvConfig = z.infer<typeof envSchema>;
