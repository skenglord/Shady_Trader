import fs from 'fs/promises';
import path from 'path';
import { logger } from './logging/logger.js';

const DB_PATH = path.join(process.cwd(), 'trading.db');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const MAX_BACKUPS = 5;

export async function performBackup() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `trading.db.${timestamp}`);
    await fs.copyFile(DB_PATH, backupPath);
    logger.info('Backup created', { backupPath, service: 'backup' });
    await cleanupOldBackups();
  } catch (error: any) {
    logger.error('Backup failed', { error: String(error), service: 'backup' });
  }
}

async function cleanupOldBackups() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files
      .filter(file => file.startsWith('trading.db.'))
      .map(file => ({ name: file, path: path.join(BACKUP_DIR, file) }));

    // Sort by name (which contains timestamp) descending
    backups.sort((a, b) => b.name.localeCompare(a.name));

    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(MAX_BACKUPS);
      for (const backup of toDelete) {
        await fs.unlink(backup.path);
        logger.info('Deleted old backup', { backupName: backup.name, service: 'backup' });
      }
    }
  } catch (error: any) {
    logger.error('Cleanup failed', { error: String(error), service: 'backup' });
  }
}
