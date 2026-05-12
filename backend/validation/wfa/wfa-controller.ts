// Note: This controller is designed for Fastify but the main app uses Express
// import Fastify from 'fastify';
// import WebSocket from 'ws';
import { RollingOptimizer, OptimizationResult } from './rolling-optimizer';
import { OverfittingDetector, OverfittingDiagnostic } from './overfitting-detector';
import { StatisticalValidator, ValidationReport } from './statistical-validator';
import { DataPartitioner, DataPartition } from './data-partitioner';
import { WFACheckpointManager, WFACheckpoint } from './wfa-checkpoint';
import { Candle } from '../../indicators/engine';
import { RiskMode } from '../../risk/manager';
import { RegimeDetector } from '../../regime/detector';

export interface WFAJob {
  id: string;
  symbol: string;
  mode: RiskMode;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  startTime: number;
  endTime?: number;
  results?: WFACompleteResult;
  error?: string;
}

export interface WFACompleteResult {
  optimizationResults: OptimizationResult[];
  overfittingDiagnostic: OverfittingDiagnostic;
  validationReport: ValidationReport;
  partitions: number;
  symbol: string;
  mode: RiskMode;
  timestamp: number;
}

export class WFAController {
  private readonly optimizer = new RollingOptimizer();
  private readonly overfittingDetector = new OverfittingDetector();
  private readonly statisticalValidator = new StatisticalValidator();
  private readonly partitioner = new DataPartitioner();
  private readonly checkpointManager = new WFACheckpointManager();
  private readonly regimeDetector = new RegimeDetector();

  private activeJobs = new Map<string, WFAJob>();
  private completedJobs = new Map<string, WFACompleteResult>();
  private wssClients = new Set<WebSocket>();

  constructor(private fastify: any) {
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes() {
    // Start WFA analysis
    this.fastify.post('/api/wfa/start', async (request, reply) => {
      const { symbol, mode, data } = request.body as {
        symbol: string;
        mode: RiskMode;
        data: Candle[];
      };

      const jobId = this.generateJobId();
      const job: WFAJob = {
        id: jobId,
        symbol,
        mode,
        status: 'pending',
        progress: 0,
        startTime: Date.now(),
      };

      this.activeJobs.set(jobId, job);

      // Start WFA analysis asynchronously
      this.runWFAnalysis(jobId, symbol, mode, data);

      reply.send({ jobId, status: 'started' });
    });

    // Get WFA job status
    this.fastify.get('/api/wfa/status/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      const job = this.activeJobs.get(jobId);
      if (job) {
        reply.send(job);
        return;
      }

      const completed = this.completedJobs.get(jobId);
      if (completed) {
        reply.send({
          id: jobId,
          status: 'completed',
          progress: 100,
          results: completed,
        });
        return;
      }

      reply.code(404).send({ error: 'Job not found' });
    });

    // Get WFA results
    this.fastify.get('/api/wfa/results', async (request, reply) => {
      const { mode, symbol, limit = 10 } = request.query as {
        mode?: RiskMode;
        symbol?: string;
        limit?: number;
      };

      const results: WFACompleteResult[] = [];

      for (const result of this.completedJobs.values()) {
        if (mode && result.mode !== mode) continue;
        if (symbol && result.symbol !== symbol) continue;
        results.push(result);
        if (results.length >= limit) break;
      }

      reply.send({
        results,
        total: this.completedJobs.size,
        filtered: results.length,
      });
    });

    // Get WFA summary statistics
    this.fastify.get('/api/wfa/summary', async (request, reply) => {
      const summary = {
        activeJobs: this.activeJobs.size,
        completedJobs: this.completedJobs.size,
        totalOptimizations: Array.from(this.completedJobs.values()).reduce(
          (sum, job) => sum + job.optimizationResults.length,
          0
        ),
        averageValidationScore: this.calculateAverageValidationScore(),
        bestPerformingMode: this.findBestPerformingMode(),
        lastUpdated: Date.now(),
      };

      reply.send(summary);
    });

    // Cancel WFA job
    this.fastify.post('/api/wfa/cancel/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      const job = this.activeJobs.get(jobId);
      if (!job) {
        reply.code(404).send({ error: 'Job not found' });
        return;
      }

      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.endTime = Date.now();

      this.activeJobs.delete(jobId);

      reply.send({ status: 'cancelled' });
    });
  }

  private setupWebSocket() {
    this.fastify.get('/api/wfa/stream', { websocket: true }, (connection, request) => {
      const ws = connection.socket;

      this.wssClients.add(ws);

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'subscribe' && data.jobId) {
            // Client wants to subscribe to specific job updates
            ws.jobId = data.jobId;
          }
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      });

      ws.on('close', () => {
        this.wssClients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.wssClients.delete(ws);
      });

      // Send initial connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to WFA streaming service',
      }));
    });
  }

  private async runWFAnalysis(jobId: string, symbol: string, mode: RiskMode, data: Candle[]) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    let checkpoint: WFACheckpoint | null = null;
    let partitions: DataPartition[] = [];
    let optimizationResults: OptimizationResult[] = [];
    let startPartition = 0;

    try {
      job.status = 'running';

      // Check for existing checkpoint
      checkpoint = await this.checkpointManager.loadCheckpoint(jobId);
      if (checkpoint && this.checkpointManager.validateCheckpoint(checkpoint)) {
        console.log(`Resuming WFA analysis from checkpoint for job ${jobId}`);
        partitions = checkpoint.partitions;
        optimizationResults = checkpoint.optimizationResults;
        startPartition = checkpoint.completedPartitions;

        // Update progress based on checkpoint
        const progress = (startPartition / partitions.length) * 80; // Up to 80% for optimization
        this.updateJobProgress(jobId, progress, `Resumed from partition ${startPartition}/${partitions.length}...`);
      } else {
        // Step 1: Partition data (20% progress)
        this.updateJobProgress(jobId, 20, 'Partitioning data...');
        partitions = this.partitioner.partition(data);

        // Save initial checkpoint
        await this.checkpointManager.saveCheckpoint(
          jobId, symbol, mode, partitions, 0, [], undefined, undefined
        );
      }

      // Step 2: Run optimization for each partition (60% progress total)
      const totalPartitions = partitions.length;

      for (let i = startPartition; i < totalPartitions; i++) {
        const partition = partitions[i];

        try {
          const result = await this.optimizer.optimizeMode(
            mode,
            partition.inSample,
            partition.outOfSample
          );
          optimizationResults.push(result);
        } catch (error) {
          console.error(`Optimization failed for partition ${i}:`, error);
        }

        const progress = 20 + (i + 1) / totalPartitions * 60;
        this.updateJobProgress(jobId, progress, `Optimizing partition ${i + 1}/${totalPartitions}...`);

        // Save checkpoint every 5 partitions
        if ((i + 1) % 5 === 0 || i === totalPartitions - 1) {
          await this.checkpointManager.saveCheckpoint(
            jobId, symbol, mode, partitions, i + 1, optimizationResults, undefined, undefined
          );
        }
      }

      if (optimizationResults.length === 0) {
        throw new Error('No optimization results obtained');
      }

      // Step 3: Run overfitting detection (80% progress)
      this.updateJobProgress(jobId, 80, 'Analyzing overfitting...');
      const overfittingDiagnostic = this.overfittingDetector.analyzeOverfitting(
        optimizationResults,
        partitions
      );

      // Save checkpoint with overfitting results
      await this.checkpointManager.saveCheckpoint(
        jobId, symbol, mode, partitions, partitions.length, optimizationResults, overfittingDiagnostic, undefined
      );

      // Step 4: Run statistical validation (90% progress)
      this.updateJobProgress(jobId, 90, 'Running statistical validation...');
      const validationReport = await this.statisticalValidator.validateOptimization(
        optimizationResults,
        overfittingDiagnostic
      );

      // Step 5: Complete (100% progress)
      this.updateJobProgress(jobId, 100, 'Analysis complete');

      const results: WFACompleteResult = {
        optimizationResults,
        overfittingDiagnostic,
        validationReport,
        partitions: partitions.length,
        symbol,
        mode,
        timestamp: Date.now(),
      };

      job.status = 'completed';
      job.endTime = Date.now();
      job.results = results;

      // Move to completed jobs (with size limit)
      if (this.completedJobs.size >= 100) {
        const firstKey = this.completedJobs.keys().next().value;
        this.completedJobs.delete(firstKey);
      }
      this.completedJobs.set(jobId, results);

      // Clean up checkpoint
      await this.checkpointManager.deleteCheckpoint(jobId);

      // Remove from active jobs
      this.activeJobs.delete(jobId);

      // Broadcast completion
      this.broadcastUpdate(jobId, {
        type: 'completed',
        jobId,
        results,
      });

    } catch (error) {
      console.error(`WFA analysis failed for job ${jobId}:`, error);

      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.endTime = Date.now();

      this.activeJobs.delete(jobId);

      this.broadcastUpdate(jobId, {
        type: 'failed',
        jobId,
        error: job.error,
      });
    }
  }

  private updateJobProgress(jobId: string, progress: number, message: string) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    job.progress = Math.round(progress);

    this.broadcastUpdate(jobId, {
      type: 'progress',
      jobId,
      progress: job.progress,
      message,
    });
  }

  private broadcastUpdate(jobId: string, data: any) {
    const message = JSON.stringify(data);

    for (const client of this.wssClients) {
      if (client.readyState === WebSocket.OPEN) {
        // Send to all clients or only subscribed clients
        if (!(client as any).jobId || (client as any).jobId === jobId) {
          try {
            client.send(message);
          } catch (error) {
            console.error('WebSocket send error:', error);
            this.wssClients.delete(client);
          }
        }
      } else {
        this.wssClients.delete(client);
      }
    }
  }

  private generateJobId(): string {
    return `wfa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private calculateAverageValidationScore(): number {
    const scores = Array.from(this.completedJobs.values()).map(job => job.validationReport.overallValidationScore);
    return scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  }

  private findBestPerformingMode(): { mode: RiskMode; score: number } | null {
    const modeScores = new Map<RiskMode, number[]>();

    for (const job of this.completedJobs.values()) {
      const mode = job.mode;
      const score = job.validationReport.overallValidationScore;

      if (!modeScores.has(mode)) {
        modeScores.set(mode, []);
      }
      modeScores.get(mode)!.push(score);
    }

    let bestMode: RiskMode | null = null;
    let bestScore = -1;

    for (const [mode, scores] of modeScores.entries()) {
      const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      if (avgScore > bestScore) {
        bestScore = avgScore;
        bestMode = mode;
      }
    }

    return bestMode ? { mode: bestMode, score: bestScore } : null;
  }
}

// Export for use in main application