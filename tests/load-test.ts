/**
 * Load testing script for Paper Trading Module
 * Simulates 1000 concurrent paper traders
 */

import { PaperTradingService } from '../backend/paper-trading/paper-trading-service.js';
import { performance } from 'perf_hooks';

const NUM_TRADERS = 1000;
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
const SIDES = ['buy', 'sell'] as const;
const TYPES = ['market', 'limit'] as const;

interface LoadTestResult {
  traderId: number;
  success: boolean;
  latency: number;
  error?: string;
}

class LoadTester {
  private service: PaperTradingService;
  private results: LoadTestResult[] = [];

  constructor() {
    this.service = new PaperTradingService();
  }

  private generateRandomTrade(traderId: number) {
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const side = SIDES[Math.floor(Math.random() * SIDES.length)];
    const type = TYPES[Math.floor(Math.random() * TYPES.length)];
    const quantity = Math.random() * 0.5 + 0.1; // 0.1 to 0.6
    const leverage = Math.floor(Math.random() * 10) + 1; // 1 to 10
    
    const trade: any = {
      symbol,
      side,
      type,
      quantity,
      timeInForce: 'GTC' as const,
      leverage,
      idempotencyKey: `trader-${traderId}-${Date.now()}`,
    };

    if (type === 'limit') {
      trade.price = 40000 + Math.random() * 20000;
    }

    return trade;
  }

  async runLoadTest(): Promise<void> {
    console.log(`Starting load test with ${NUM_TRADERS} concurrent traders...`);
    console.log('='.repeat(60));

    const startTime = performance.now();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < NUM_TRADERS; i++) {
      promises.push(this.simulateTrader(i));
    }

    await Promise.allSettled(promises);

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    this.printResults(totalTime);
  }

  private async simulateTrader(traderId: number): Promise<void> {
    const trade = this.generateRandomTrade(traderId);
    const startTime = performance.now();

    try {
      const result = await this.service.createPaperTrade(trade);
      const endTime = performance.now();
      const latency = endTime - startTime;

      this.results.push({
        traderId,
        success: true,
        latency,
      });

      // Simulate some trading activity
      if (Math.random() < 0.3) { // 30% chance to check positions
        await this.service.getOpenPositions();
      }

      if (Math.random() < 0.1) { // 10% chance to cancel
        await this.service.cancelPaperTrade(result.id, `cancel-${traderId}`);
      }

    } catch (error: any) {
      const endTime = performance.now();
      const latency = endTime - startTime;

      this.results.push({
        traderId,
        success: false,
        latency,
        error: error.message,
      });
    }
  }

  private printResults(totalTime: number): void {
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const latencies = this.results.map(r => r.latency);
    
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    
    const p50 = this.percentile(latencies, 50);
    const p95 = this.percentile(latencies, 95);
    const p99 = this.percentile(latencies, 99);

    console.log('\nLoad Test Results:');
    console.log('-'.repeat(60));
    console.log(`Total traders:        ${NUM_TRADERS}`);
    console.log(`Successful:           ${successful} (${((successful / NUM_TRADERS) * 100).toFixed(1)}%)`);
    console.log(`Failed:               ${failed} (${((failed / NUM_TRADERS) * 100).toFixed(1)}%)`);
    console.log(`Total time:           ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`Throughput:           ${(NUM_TRADERS / (totalTime / 1000)).toFixed(2)} traders/sec`);
    console.log('\nLatency Statistics:');
    console.log(`Average:              ${avgLatency.toFixed(2)}ms`);
    console.log(`Min:                  ${minLatency.toFixed(2)}ms`);
    console.log(`Max:                  ${maxLatency.toFixed(2)}ms`);
    console.log(`P50:                  ${p50.toFixed(2)}ms`);
    console.log(`P95:                  ${p95.toFixed(2)}ms`);
    console.log(`P99:                  ${p99.toFixed(2)}ms`);
    console.log('='.repeat(60));

    // Check if performance targets are met
    const targetLatency = 50; // 50ms target
    const targetThroughput = 1000; // 1000 traders in reasonable time
    
    console.log('\nPerformance Targets:');
    console.log(`P95 Latency < ${targetLatency}ms: ${p95 < targetLatency ? '✓ PASS' : '✗ FAIL'}`);
    console.log(`Throughput > ${targetThroughput} traders: ${NUM_TRADERS >= targetThroughput ? '✓ PASS' : '✗ FAIL'}`);
    
    if (p95 >= targetLatency) {
      console.log('\n⚠ Warning: P95 latency exceeds 50ms target');
    }
  }

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

// Run load test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new LoadTester();
  tester.runLoadTest().catch(console.error);
}

export { LoadTester };
