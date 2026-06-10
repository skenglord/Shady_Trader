import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { setMockRunQuery } from '../../backend/database.js';
import { seedDatabase } from '../../seed.js';

// Block 9 verify-only: fresh seed yields 12 shadow trades per mode incl. ai_enhanced.
describe('Seed modes', () => {
  after(() => setMockRunQuery(null as any));

  test('seed inserts 12 shadow trades per mode including ai_enhanced (72 total)', async () => {
    const modeCounts: Record<string, number> = {};
    let candleCountQueried = false;

    setMockRunQuery(async (sql: string, params: any[], type: string) => {
      // Make the "already seeded?" guard return 0 so seeding proceeds
      if (sql.includes('COUNT(*)')) { candleCountQueried = true; return [{ count: 0 }]; }
      // Capture shadow_trades inserts and tally by risk_mode (8th param)
      if (sql.includes('INSERT INTO shadow_trades')) {
        const mode = params[7];
        modeCounts[mode] = (modeCounts[mode] || 0) + 1;
      }
      if (type === 'all') return [];
      return { changes: 1 };
    });

    await seedDatabase();

    assert.ok(candleCountQueried, 'seed should check existing counts');
    const modes = Object.keys(modeCounts).sort();
    assert.deepEqual(
      modes,
      ['aggressive', 'ai_enhanced', 'conservative', 'degen', 'moderate', 'ultra_conservative'],
      'all 6 modes incl ai_enhanced'
    );
    for (const m of modes) {
      assert.equal(modeCounts[m], 12, `${m} should have 12 shadow trades (10 closed + 2 open)`);
    }
    const total = Object.values(modeCounts).reduce((a, b) => a + b, 0);
    assert.equal(total, 72, 'total 72 shadow trades');
  });
});
