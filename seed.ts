import { runQuery } from './backend/database.js';

export async function seedDatabase() {
  // Check if already seeded
  const countResult = await runQuery('SELECT COUNT(*) as count FROM shadow_trades', [], 'all');
  const count = (countResult as any)[0] as { count: number };
  const candleCountResult = await runQuery('SELECT COUNT(*) as count FROM candles', [], 'all');
  const candleCount = (candleCountResult as any)[0] as { count: number };
  
  if (count.count > 0 && candleCount.count > 0) return;

  console.log('Seeding database with mock data...');

  const modes = ['ultra_conservative', 'conservative', 'moderate', 'aggressive', 'degen'];
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const sides = ['buy', 'sell'];
  const now = Date.now();

  for (const mode of modes) {
    // 10 closed trades per mode
    for (let i = 0; i < 10; i++) {
      const isWin = Math.random() > 0.4;
      const pnl = isWin ? Math.random() * 50 + 10 : -(Math.random() * 30 + 5);
      
      await runQuery(`
        INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, pnl, exit_price, exit_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        `mock-${mode}-closed-${i}`,
        symbols[Math.floor(Math.random() * symbols.length)],
        sides[Math.floor(Math.random() * sides.length)],
        Math.random() * 0.5 + 0.01,
        60000 + Math.random() * 5000,
        'closed',
        now - (i + 1) * 3600000,
        mode,
        pnl,
        60000 + Math.random() * 5000 + (isWin ? 500 : -500),
        now - i * 3600000
      ]);
    }

    // 2 open trades per mode
    for (let i = 0; i < 2; i++) {
      await runQuery(`
        INSERT INTO shadow_trades (id, symbol, side, amount, price, status, timestamp, risk_mode, pnl, exit_price, exit_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        `mock-${mode}-open-${i}`,
        symbols[Math.floor(Math.random() * symbols.length)],
        sides[Math.floor(Math.random() * sides.length)],
        Math.random() * 0.5 + 0.01,
        65000 + Math.random() * 1000,
        'open',
        now - Math.random() * 1800000,
        mode,
        null,
        null,
        null
      ]);
    }
  }
  // Seed candles
  const msPerCandle = 60000; // 1m

  for (const symbol of symbols) {
    let price = 50000;
    for (let i = 0; i < 500; i++) {
      const time = now - (500 - i) * msPerCandle;
      price += (Math.random() - 0.5) * 100;
      await runQuery(`
        INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume)
        VALUES (?, '1m', ?, ?, ?, ?, ?, ?)
      `, [symbol, time, price, price + 10, price - 10, price, Math.random() * 100]);
    }
  }
  console.log('Database seeded.');
}
