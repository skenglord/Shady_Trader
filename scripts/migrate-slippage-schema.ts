import { initPostgresDatabase } from '../backend/database_postgres.js';
import { logger } from '../backend/logging/logger.js';

async function runSlippageMigrations() {
  try {
    logger.info('Starting slippage modeling database migrations', { service: 'Migration' });

    // The schema changes are already included in database_postgres.ts and database_worker.ts
    // This script ensures existing databases are updated
    await initPostgresDatabase();

    logger.info('Slippage modeling migrations completed successfully', { service: 'Migration' });
  } catch (error) {
    logger.error('Slippage modeling migration failed', {
      service: 'Migration',
      error: error.message
    });
    throw error;
  }
}

runSlippageMigrations().catch(console.error);