import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RotationConfig {
  maxSizeBytes: number;      // e.g., 10 * 1024 * 1024 for 10MB
  maxFiles: number;          // e.g., 5 to keep last 5 files
  compress: boolean;         // whether to gzip old logs
}

const DEFAULT_CONFIG: RotationConfig = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  compress: false
};

export class LogRotator {
  private logFilePath: string;
  private config: RotationConfig;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(logFilePath: string, config: Partial<RotationConfig> = {}) {
    this.logFilePath = logFilePath;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if log file needs rotation based on size
   */
  needsRotation(): boolean {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return false;
      }
      const stats = fs.statSync(this.logFilePath);
      return stats.size >= this.config.maxSizeBytes;
    } catch (error) {
      console.error('Error checking log file size:', error);
      return false;
    }
  }

  /**
   * Rotate the log file
   */
  rotate(): boolean {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return false;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = `${this.logFilePath}.${timestamp}`;

      // Rename current log file
      fs.renameSync(this.logFilePath, rotatedPath);

      // Compress if enabled
      if (this.config.compress) {
        this.compressFile(rotatedPath);
      }

      // Clean up old files
      this.cleanupOldFiles();

      return true;
    } catch (error) {
      console.error('Error rotating log file:', error);
      return false;
    }
  }

  /**
   * Compress a log file using gzip
   */
  private compressFile(filePath: string): void {
    import('zlib').then(({ gzipSync }) => {
      try {
        const data = fs.readFileSync(filePath);
        const compressed = gzipSync(data);
        fs.writeFileSync(`${filePath}.gz`, compressed);
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error compressing log file:', error);
      }
    }).catch(() => {});
  }

  /**
   * Remove old rotated files beyond maxFiles limit
   */
  private cleanupOldFiles(): void {
    try {
      const logDir = path.dirname(this.logFilePath);
      const logBasename = path.basename(this.logFilePath);
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith(logBasename) && f !== logBasename)
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          time: fs.statSync(path.join(logDir, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

      // Remove files beyond maxFiles limit
      for (let i = this.config.maxFiles - 1; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].path);
        } catch (error) {
          console.error(`Error removing old log file ${files[i].path}:`, error);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old log files:', error);
    }
  }

  /**
   * Start periodic rotation check
   */
  startPeriodicCheck(intervalMs: number = 60000): void {
    if (this.checkInterval) {
      return;
    }
    this.checkInterval = setInterval(() => {
      if (this.needsRotation()) {
        this.rotate();
      }
    }, intervalMs);
    this.checkInterval.unref?.();
  }

  /**
   * Stop periodic rotation check
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

/**
 * Daily time-based rotation utility
 */
export class TimeBasedRotator {
  private logFilePath: string;
  private lastRotationDate: string;
  private config: RotationConfig;

  constructor(logFilePath: string, config: Partial<RotationConfig> = {}) {
    this.logFilePath = logFilePath;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastRotationDate = new Date().toISOString().split('T')[0];
  }

  /**
   * Check if a new day has started and rotate if needed
   */
  checkAndRotate(): boolean {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastRotationDate) {
      this.lastRotationDate = today;
      return this.rotate();
    }
    return false;
  }

  /**
   * Rotate the log file (time-based)
   */
  rotate(): boolean {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return false;
      }

      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const rotatedPath = `${this.logFilePath}.${yesterday}`;

      // Remove existing rotated file for this date
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }

      // Rename current log file
      fs.renameSync(this.logFilePath, rotatedPath);

      // Compress if enabled
      if (this.config.compress) {
        this.compressFile(rotatedPath);
      }

      // Clean up old files
      this.cleanupOldFiles();

      return true;
    } catch (error) {
      console.error('Error rotating log file:', error);
      return false;
    }
  }

  private compressFile(filePath: string): void {
    import('zlib').then(({ gzipSync }) => {
      try {
        const data = fs.readFileSync(filePath);
        const compressed = gzipSync(data);
        fs.writeFileSync(`${filePath}.gz`, compressed);
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error compressing log file:', error);
      }
    }).catch(() => {});
  }

  private cleanupOldFiles(): void {
    try {
      const logDir = path.dirname(this.logFilePath);
      const logBasename = path.basename(this.logFilePath);
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith(logBasename) && f !== logBasename)
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          time: fs.statSync(path.join(logDir, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

      for (let i = this.config.maxFiles - 1; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].path);
        } catch (error) {
          console.error(`Error removing old log file ${files[i].path}:`, error);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old log files:', error);
    }
  }
}
