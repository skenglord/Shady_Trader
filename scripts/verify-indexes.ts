#!/usr/bin/env tsx

import { runQuery, initDatabase } from '../backend/database.js';

/**
 * Verify database indexes are properly created
 * Run with: tsx scripts/verify-indexes.ts
 */
async function verifyIndexes() {
  console.log('Verifying database indexes...\n');
  
  try {
    // Initialize database
    initDatabase();
    
    // Wait a bit for worker to initialize
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check candles table indexes
    console.log('1. Candles table indexes:');
    const candleIndexes = await runQuery(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='candles'`,
      [],
      'all'
    );
    console.log('   Found indexes:', candleIndexes.length);
    candleIndexes.forEach((idx: any) => {
      console.log(`   - ${idx.name}: ${idx.sql}`);
    });
    
    // Check shadow_trades table indexes
    console.log('\n2. Shadow trades table indexes:');
    const tradeIndexes = await runQuery(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='shadow_trades'`,
      [],
      'all'
    );
    console.log('   Found indexes:', tradeIndexes.length);
    tradeIndexes.forEach((idx: any) => {
      console.log(`   - ${idx.name}: ${idx.sql}`);
    });
    
    // Check regime_history table indexes
    console.log('\n3. Regime history table indexes:');
    const regimeIndexes = await runQuery(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='regime_history'`,
      [],
      'all'
    );
    console.log('   Found indexes:', regimeIndexes.length);
    regimeIndexes.forEach((idx: any) => {
      console.log(`   - ${idx.name}: ${idx.sql}`);
    });
    
    // Check market_news table indexes
    console.log('\n4. Market news table indexes:');
    const newsIndexes = await runQuery(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='market_news'`,
      [],
      'all'
    );
    console.log('   Found indexes:', newsIndexes.length);
    newsIndexes.forEach((idx: any) => {
      console.log(`   - ${idx.name}: ${idx.sql}`);
    });
    
    // Verify expected indexes exist
    const expectedIndexes = [
      'idx_candles_symbol_timeframe_time',
      'idx_candles_time',
      'idx_shadow_trades_risk_mode_status',
      'idx_shadow_trades_timestamp',
      'idx_regime_history_timestamp',
      'idx_market_news_timestamp'
    ];
    
    const allIndexes = [...candleIndexes, ...tradeIndexes, ...regimeIndexes, ...newsIndexes]
      .map((idx: any) => idx.name);
    
    console.log('\n5. Verification results:');
    let allPresent = true;
    for (const expected of expectedIndexes) {
      const found = allIndexes.includes(expected);
      console.log(`   ${found ? '✓' : '✗'} ${expected}`);
      if (!found) allPresent = false;
    }
    
    if (allPresent) {
      console.log('\n✓ All expected indexes are present!');
      process.exit(0);
    } else {
      console.log('\n✗ Some indexes are missing!');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('Error verifying indexes:', error);
    process.exit(1);
  }
}

verifyIndexes();
