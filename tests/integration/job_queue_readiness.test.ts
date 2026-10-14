import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import * as queues from '../../backend/job_queues.js';

const redisBinary = process.env.REDIS_SERVER_BINARY
  || (existsSync('/home/creekz/.local/share/shady-trader/bin/redis-server')
    ? '/home/creekz/.local/share/shady-trader/bin/redis-server' : 'redis-server');
const hasRedis = spawnSync(redisBinary, ['--version']).status === 0;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'queue operation did not become ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Redis queue startup readiness', { skip: !hasRedis }, () => {
  let server: ChildProcess;
  let port: number;
  const originalEnv = { REDIS_HOST: process.env.REDIS_HOST, REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD, FREQTRADE_ENABLED: process.env.FREQTRADE_ENABLED };

  before(async () => {
    // Reserve an ephemeral port, then give it to a private Redis with persistence disabled.
    // Tests must never reach the developer's application Redis or its queued jobs.
    const reservation = createServer();
    port = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    server = spawn(redisBinary, ['--bind', '127.0.0.1', '--port', String(port),
      '--save', '', '--appendonly', 'no', '--loglevel', 'notice'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Private Redis did not start')), 5000);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Private Redis exited: ${code}`)));
      server.stdout!.on('data', data => {
        if (String(data).includes('Ready to accept connections')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });

  beforeEach(async () => {
    await queues.closeQueues();
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(port);
    process.env.REDIS_PASSWORD = '';
    process.env.FREQTRADE_ENABLED = 'false';
  });

  after(async () => {
    await queues.closeQueues();
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('registration before Redis is ready starts a worker that consumes queued jobs', async () => {
    let fetched = 0;
    queues.initializeWorkers({ fetchMarketData: async () => { fetched++; }, fetchNews: async () => [] } as any,
      { optimize: async () => {} } as any);

    await eventually(() => !!queues.getMarketDataQueue());
    const queue = queues.getMarketDataQueue()!;
    await queue.waitUntilReady();
    await eventually(async () => (await queue.getWorkers()).length > 0);
    await queue.add('startup-regression', {}, { removeOnComplete: true });
    await eventually(() => fetched === 1);
  });

  test('repeated registration creates only one worker for each standard queue', async () => {
    assert.equal(await queues.awaitQueueReady(), true);
    for (let i = 0; i < 3; i++) {
      queues.initializeWorkers({ fetchMarketData: async () => {}, fetchNews: async () => [] } as any,
        { optimize: async () => {} } as any);
    }
    for (const queue of [queues.getMarketDataQueue()!, queues.getOptimizationQueue()!, queues.getDataPipelineQueue()!]) {
      await eventually(async () => (await queue.getWorkers()).length > 0);
      assert.equal((await queue.getWorkers()).length, 1);
    }
  });

  test('shutdown followed by startup uses a fresh connection and workers', async () => {
    assert.equal(await queues.awaitQueueReady(), true);
    const previousQueue = queues.getMarketDataQueue();
    await queues.closeQueues();
    assert.equal(await queues.awaitQueueReady(), true);
    queues.initializeWorkers({ fetchMarketData: async () => {}, fetchNews: async () => [] } as any,
      { optimize: async () => {} } as any);
    const queue = queues.getMarketDataQueue()!;
    assert.notEqual(queue, previousQueue);
    await eventually(async () => (await queue.getWorkers()).length === 1);
  });

  test('a TCP connection without Redis readiness times out and remains unavailable', async () => {
    const sockets = new Set<Socket>();
    const stalled = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    process.env.REDIS_PORT = String(await listen(stalled));
    try {
      const started = Date.now();
      assert.equal(await queues.awaitQueueReady(40), false);
      assert.ok(Date.now() - started < 1000, 'offline startup must stay bounded');
      assert.equal(queues.getMarketDataQueue(), null);
      await queues.closeQueues();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => stalled.close(() => resolve()));
    }
  });

  test('shutdown cancels pending readiness and worker registration', async () => {
    const sockets = new Set<Socket>();
    const stalled = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    process.env.REDIS_PORT = String(await listen(stalled));
    try {
      queues.initializeWorkers({ fetchMarketData: async () => {}, fetchNews: async () => [] } as any,
        { optimize: async () => {} } as any);
      const readiness = queues.awaitQueueReady(5000);
      await queues.closeQueues();
      assert.equal(await readiness, false);
      process.env.REDIS_PORT = String(port);
      assert.equal(await queues.awaitQueueReady(), true);
      assert.equal((await queues.getMarketDataQueue()!.getWorkers()).length, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => stalled.close(() => resolve()));
    }
  });
});
