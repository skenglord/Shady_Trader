import { describe, test } from 'node:test';
import assert from 'node:assert';
import { envSchema, type EnvConfig } from '../../backend/config/validation.js';

describe('validation', () => {
  test('envSchema should parse valid environment', () => {
    const env = {
      NODE_ENV: 'development',
      PORT: '3000',
    };
    
    const result = envSchema.parse(env) as EnvConfig;
    assert.strictEqual(result.NODE_ENV, 'development');
    assert.strictEqual(result.PORT, 3000);
  });

  test('envSchema should use defaults for missing values', () => {
    const result = envSchema.parse({}) as EnvConfig;
    assert.strictEqual(result.NODE_ENV, 'development');
    assert.strictEqual(result.LOG_LEVEL, 'info');
    assert.strictEqual(result.PORT, 3000);
  });

  test('envSchema should transform string booleans', () => {
    const result = envSchema.parse({ EXCHANGE_USE_TESTNET: 'true' }) as EnvConfig;
    assert.strictEqual(result.EXCHANGE_USE_TESTNET, true);
    
    const result2 = envSchema.parse({ EXCHANGE_USE_TESTNET: 'false' }) as EnvConfig;
    assert.strictEqual(result2.EXCHANGE_USE_TESTNET, false);
  });

  test('envSchema should transform port string to number', () => {
    const result = envSchema.parse({ PORT: '8080' }) as EnvConfig;
    assert.strictEqual(result.PORT, 8080);
    assert.strictEqual(typeof result.PORT, 'number');
  });

  test('envSchema should reject invalid NODE_ENV', () => {
    assert.throws(() => envSchema.parse({ NODE_ENV: 'invalid' }));
  });

  test('envSchema should accept optional API tokens', () => {
    const result = envSchema.parse({ 
      API_ADMIN_TOKEN: 'admin-token',
      API_TRADER_TOKEN: 'trader-token',
    }) as EnvConfig;
    
    assert.strictEqual(result.API_ADMIN_TOKEN, 'admin-token');
    assert.strictEqual(result.API_TRADER_TOKEN, 'trader-token');
  });
});