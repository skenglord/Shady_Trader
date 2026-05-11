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
});

export type EnvConfig = z.infer<typeof envSchema>;
