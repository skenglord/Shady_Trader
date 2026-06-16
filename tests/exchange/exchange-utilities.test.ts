import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RedisBloomFilter, DeduplicationEngine } from '../../backend/exchange/deduplication.js';
import { ZeroCopyBuffer } from '../../backend/exchange/data-serializer.js';

function createRedisMock(values: string[] = ['1', '1', '1']) {
  const pipeline = {
    setbitCalls: [] as number[],
    setbit(key: string, bit: number, value: number) {
      this.setbitCalls.push(bit);
      return this;
    },
    async exec() {
      return [];
    },
  };

  return {
    pipelineCalls: 0,
    lastPipeline: pipeline,
    getCalls: [] as string[],
    delCalls: [] as string[],
    pipeline() {
      this.pipelineCalls++;
      return pipeline;
    },
    async mget(...keys: string[]) {
      this.getCalls.push(...keys);
      return values;
    },
    async del(...keys: string[]) {
      this.delCalls.push(...keys);
      return 1;
    },
  };
}

describe('Exchange utility modules', () => {
  test('Redis Bloom filter and deduplication engine handle add, contains, clear, and reset', async () => {
    const redis = createRedisMock(['1', '1', '1']);
    const filter = new RedisBloomFilter(redis as any, 'dedup:test', 1000, 3);

    assert.strictEqual(await filter.add('trade-1'), true);
    assert.strictEqual(redis.pipelineCalls, 1);
    assert.strictEqual((redis as any).lastPipeline.setbitCalls.length, 3);
    assert.strictEqual(await filter.contains('trade-1'), true);
    assert.strictEqual(redis.getCalls.length, 3);
    await filter.clear();
    assert.deepStrictEqual(redis.delCalls, ['dedup:test']);
    assert.ok(filter.getFalsePositiveRate(100) >= 0);

    const engine = new DeduplicationEngine(redis as any);
    assert.strictEqual(await engine.isDuplicate('trade-2'), true);
    await engine.resetFilter();
    assert.deepStrictEqual(redis.delCalls, ['dedup:test', 'trade_deduplication']);
    assert.deepStrictEqual(engine.getStats(), { filterSize: 1000000, hashCount: 3 });
  });

  test('Redis Bloom filter degrades safely when Redis commands fail', async () => {
    const failingRedis = {
      pipeline() {
        throw new Error('redis down');
      },
      async mget() {
        throw new Error('redis down');
      },
      async del() {
        throw new Error('redis down');
      },
    };

    const filter = new RedisBloomFilter(failingRedis as any, 'dedup:fail', 1000, 2);
    assert.strictEqual(await filter.add('trade-1'), false);
    assert.strictEqual(await filter.contains('trade-1'), false);
    await filter.clear();
  });

  test('zero-copy buffer tracks writes, reads, available space, resize, and reset', () => {
    const buffer = new ZeroCopyBuffer(8);
    assert.strictEqual(buffer.getAvailableSpace(), 8);
    assert.strictEqual(buffer.write(Buffer.from('abcd')), true);
    assert.strictEqual(buffer.getAvailableSpace(), 4);
    assert.deepStrictEqual(buffer.read(2), Buffer.from('ab'));
    assert.strictEqual(buffer.getAvailableSpace(), 6);
    assert.strictEqual(buffer.write(Buffer.from('abcdefgh')), false);
    assert.deepStrictEqual(buffer.read(2), Buffer.from('cd'));
    assert.strictEqual(buffer.getAvailableSpace(), 8);

    buffer.resize(16);
    assert.strictEqual(buffer.getAvailableSpace(), 16);
    assert.strictEqual(buffer.write(Buffer.from('12345678')), true);
    const view = buffer.readView(4);
    assert.ok(view);
    assert.strictEqual(view.toString(), '1234');
    assert.strictEqual(buffer.readView(9), null);
    buffer.reset();
    assert.strictEqual(buffer.getAvailableSpace(), 16);
  });
});
