import * as fs from 'fs';
import * as path from 'path';
import { OptimizationResult } from './rolling-optimizer';
import { OverfittingDiagnostic } from './overfitting-detector';
import { ValidationReport } from './statistical-validator';
import { logger } from '../../logging/logger.js';
import { DataPartition } from './data-partitioner';
import { RiskMode } from '../../risk/manager';

interface WFACheckpoint {
  jobId: string;
  symbol: string;
  mode: RiskMode;
  partitions: DataPartition[];
  completedPartitions: number;
  optimizationResults: OptimizationResult[];
  overfittingDiagnostic?: OverfittingDiagnostic;
  validationReport?: ValidationReport;
  timestamp: number;
  version: string;
}

export class WFACheckpointManager {
  private readonly checkpointDir: string;
  private readonly maxCheckpoints = 50;
  private readonly checkpointInterval = 5; // Save every 5 partitions

  constructor(baseDir: string = './data/checkpoints') {
    this.checkpointDir = path.resolve(baseDir);
    this.ensureCheckpointDirectory();
  }

  /**
   * Save checkpoint for WFA job
   */
  async saveCheckpoint(
    jobId: string,
    symbol: string,
    mode: RiskMode,
    partitions: DataPartition[],
    completedPartitions: number,
    optimizationResults: OptimizationResult[],
    overfittingDiagnostic?: OverfittingDiagnostic,
    validationReport?: ValidationReport
  ): Promise<void> {
    // Only save checkpoint every N partitions
    if (completedPartitions % this.checkpointInterval !== 0 && completedPartitions !== partitions.length) {
      return;
    }

    const checkpoint: WFACheckpoint = {
      jobId,
      symbol,
      mode,
      partitions,
      completedPartitions,
      optimizationResults,
      overfittingDiagnostic,
      validationReport,
      timestamp: Date.now(),
      version: '1.0.0',
    };

    const filePath = this.getCheckpointFilePath(jobId);

    try {
      await fs.promises.writeFile(
        filePath,
        JSON.stringify(checkpoint, null, 2),
        'utf8'
      );

      // Clean up old checkpoints
      await this.cleanupOldCheckpoints();

      logger.info('WFA checkpoint saved: ${filePath}', { service: 'wfa-checkpoint' });
    } catch (error) {
      logger.error("Failed to save WFA checkpoint", { jobId, error: String(error), service: "wfa-checkpoint" });
      throw error;
    }
  }

  /**
   * Load checkpoint for WFA job
   */
  async loadCheckpoint(jobId: string): Promise<WFACheckpoint | null> {
    const filePath = this.getCheckpointFilePath(jobId);

    try {
      const data = await fs.promises.readFile(filePath, 'utf8');
      const checkpoint: WFACheckpoint = JSON.parse(data);

      // Validate checkpoint version
      if (checkpoint.version !== '1.0.0') {
        logger.warn('Checkpoint version mismatch for job ${jobId}: expected 1.0.0, got ${checkpoint.version}', { service: 'wfa-checkpoint' });
      }

      logger.info('WFA checkpoint loaded: ${filePath}', { service: 'wfa-checkpoint' });
      return checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // No checkpoint exists
      }
      logger.error("Failed to load WFA checkpoint", { jobId, error: String(error), service: "wfa-checkpoint" });
      return null;
    }
  }

  /**
   * Delete checkpoint for WFA job
   */
  async deleteCheckpoint(jobId: string): Promise<void> {
    const filePath = this.getCheckpointFilePath(jobId);

    try {
      await fs.promises.unlink(filePath);
      logger.info('WFA checkpoint deleted: ${filePath}', { service: 'wfa-checkpoint' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error("Failed to delete WFA checkpoint", { jobId, error: String(error), service: "wfa-checkpoint" });
      }
    }
  }

  /**
   * List all available checkpoints
   */
  async listCheckpoints(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.checkpointDir);
      return files
        .filter(file => file.startsWith('wfa_') && file.endsWith('.json'))
        .map(file => file.replace('wfa_', '').replace('.json', ''));
    } catch (error) {
      logger.error('Failed to list WFA checkpoints', { error: String(error), service: 'wfa-checkpoint' });
      return [];
    }
  }

  /**
   * Get checkpoint statistics
   */
  async getCheckpointStats(): Promise<{
    totalCheckpoints: number;
    totalSize: number;
    oldestCheckpoint?: number;
    newestCheckpoint?: number;
  }> {
    try {
      const files = await fs.promises.readdir(this.checkpointDir);
      const checkpointFiles = files.filter(file => file.startsWith('wfa_') && file.endsWith('.json'));

      let totalSize = 0;
      let oldestTimestamp: number | undefined;
      let newestTimestamp: number | undefined;

      for (const file of checkpointFiles) {
        const filePath = path.join(this.checkpointDir, file);
        const stats = await fs.promises.stat(filePath);
        totalSize += stats.size;

        try {
          const data = await fs.promises.readFile(filePath, 'utf8');
          const checkpoint: WFACheckpoint = JSON.parse(data);

          if (!oldestTimestamp || checkpoint.timestamp < oldestTimestamp) {
            oldestTimestamp = checkpoint.timestamp;
          }
          if (!newestTimestamp || checkpoint.timestamp > newestTimestamp) {
            newestTimestamp = checkpoint.timestamp;
          }
        } catch (error) {
          // Skip malformed checkpoints
          continue;
        }
      }

      return {
        totalCheckpoints: checkpointFiles.length,
        totalSize,
        oldestCheckpoint: oldestTimestamp,
        newestCheckpoint: newestTimestamp,
      };
    } catch (error) {
      logger.error('Failed to get checkpoint stats', { error: String(error), service: 'wfa-checkpoint' });
      return {
        totalCheckpoints: 0,
        totalSize: 0,
      };
    }
  }

  /**
   * Clean up old checkpoints to prevent disk space issues
   */
  private async cleanupOldCheckpoints(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.checkpointDir);
      const checkpointFiles = files
        .filter(file => file.startsWith('wfa_') && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(this.checkpointDir, file),
        }));

      if (checkpointFiles.length <= this.maxCheckpoints) {
        return;
      }

      // Sort by modification time (oldest first)
      const filesWithStats = await Promise.all(
        checkpointFiles.map(async (file) => {
          const stats = await fs.promises.stat(file.path);
          return {
            ...file,
            mtime: stats.mtime.getTime(),
          };
        })
      );

      filesWithStats.sort((a, b) => a.mtime - b.mtime);

      // Remove oldest files
      const filesToRemove = filesWithStats.slice(0, filesWithStats.length - this.maxCheckpoints);

      for (const file of filesToRemove) {
        try {
          await fs.promises.unlink(file.path);
          logger.info('Cleaned up old WFA checkpoint: ${file.name}', { service: 'wfa-checkpoint' });
        } catch (error) {
          logger.error("Failed to clean up checkpoint", { fileName: file.name, error: String(error), service: "wfa-checkpoint" });
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old checkpoints', { error: String(error), service: 'wfa-checkpoint' });
    }
  }

  /**
   * Validate checkpoint integrity
   */
  validateCheckpoint(checkpoint: WFACheckpoint): boolean {
    try {
      // Basic structure validation
      if (!checkpoint.jobId || !checkpoint.symbol || !checkpoint.mode) {
        return false;
      }

      if (!Array.isArray(checkpoint.partitions) || checkpoint.partitions.length === 0) {
        return false;
      }

      if (!Array.isArray(checkpoint.optimizationResults)) {
        return false;
      }

      if (checkpoint.completedPartitions < 0 || checkpoint.completedPartitions > checkpoint.partitions.length) {
        return false;
      }

      // Validate partition integrity
      for (const partition of checkpoint.partitions) {
        if (!partition.inSample || !partition.outOfSample) {
          return false;
        }
        if (partition.inSample.length === 0 || partition.outOfSample.length === 0) {
          return false;
        }
      }

      // Validate optimization results
      for (const result of checkpoint.optimizationResults) {
        if (!result.parameters || typeof result.fitnessScore !== 'number') {
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Checkpoint validation failed', { error: String(error), service: 'wfa-checkpoint' });
      return false;
    }
  }

  /**
   * Compress checkpoint data for storage efficiency
   */
  private compressCheckpoint(checkpoint: WFACheckpoint): string {
    // In a production system, you might want to implement actual compression
    // For now, we'll just return the JSON string
    return JSON.stringify(checkpoint);
  }

  /**
   * Decompress checkpoint data
   */
  private decompressCheckpoint(data: string): WFACheckpoint {
    return JSON.parse(data);
  }

  private getCheckpointFilePath(jobId: string): string {
    return path.join(this.checkpointDir, `wfa_${jobId}.json`);
  }

  private ensureCheckpointDirectory(): void {
    try {
      if (!fs.existsSync(this.checkpointDir)) {
        fs.mkdirSync(this.checkpointDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to create checkpoint directory', { error: String(error), service: 'wfa-checkpoint' });
      throw error;
    }
  }
}

export type { WFACheckpoint };