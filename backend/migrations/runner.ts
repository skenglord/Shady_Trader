// backend/migrations/runner.ts

import { up as m0001 } from './0001_regime_v2_and_ml_schema.js';
import { up as m0002 } from './0002_migrate_regime_strings.js';
import { up as m0003 } from './0003_freqtrade_jobs.js';
import { up as m0004 } from './0004_freqtrade_hyperopt_results.js';
import { logger }       from '../logging/logger.js';

export async function runMigrations(): Promise<void> {
  const migrations = [
    { id: '0001', name: 'regime_v2_and_ml_schema',     run: m0001 },
    { id: '0002', name: 'migrate_regime_strings',      run: m0002 },
    { id: '0003', name: 'freqtrade_jobs',              run: m0003 },
    { id: '0004', name: 'freqtrade_hyperopt_results', run: m0004 },
  ];

  logger.info('Starting migration runner', { service: 'migrations' });
  for (const m of migrations) {
    logger.info(`Running ${m.id}: ${m.name}`, { service: 'migrations' });
    await m.run();
  }
  logger.info('All migrations complete', { service: 'migrations' });
}
