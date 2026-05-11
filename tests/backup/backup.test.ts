import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('backup', async () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
    await fs.writeFile(path.join(tempDir, 'trading.db'), 'dummy database content');
    originalCwd = process.cwd;
    process.cwd = () => tempDir;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('performBackup should create backup with timestamp', async () => {
    const { performBackup } = await import('../../backend/backup.js');
    
    await performBackup();
    
    const backupDir = path.join(tempDir, 'backups');
    const files = await fs.readdir(backupDir);
    const backupFile = files.find(f => f.startsWith('trading.db.'));
    assert.ok(backupFile, 'Backup file should exist');
    
    const content = await fs.readFile(path.join(backupDir, backupFile!), 'utf-8');
    assert.strictEqual(content, 'dummy database content');
  });

  test('performBackup should handle errors gracefully', async () => {
    const { performBackup } = await import('../../backend/backup.js');

    // Remove the database file to trigger error
    await fs.unlink(path.join(tempDir, 'trading.db'));

    // Should not throw
    await assert.doesNotReject(async () => await performBackup());
  });

  test('cleanupOldBackups should remove excess backups', async () => {
    // Create multiple backup files to exceed MAX_BACKUPS
    const backupDir = path.join(tempDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });

    // Create 8 backup files (MAX_BACKUPS = 5)
    for (let i = 0; i < 8; i++) {
      const timestamp = new Date(Date.now() - i * 60000).toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `trading.db.${timestamp}`);
      await fs.writeFile(backupPath, `backup content ${i}`);
    }

    // Manually call cleanup by importing the module and triggering cleanup
    // Since the module uses process.cwd() at load time, we need to create the files first
    const { performBackup } = await import('../../backend/backup.js');
    
    // Create a valid database file so performBackup succeeds
    await fs.writeFile(path.join(tempDir, 'trading.db'), 'valid db content');

    // Trigger cleanup by performing a backup (which will create a 9th file, then cleanup to 5)
    await performBackup();

    // Check that only MAX_BACKUPS files remain
    const files = await fs.readdir(backupDir);
    const backupFiles = files.filter(f => f.startsWith('trading.db.'));
    assert.strictEqual(backupFiles.length, 5); // MAX_BACKUPS
  });

  test('cleanupOldBackups should handle empty backup directory', async () => {
    const { performBackup } = await import('../../backend/backup.js');

    // Create empty backup directory
    const backupDir = path.join(tempDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });

    // Should not throw
    await assert.doesNotReject(async () => await performBackup());
  });
});