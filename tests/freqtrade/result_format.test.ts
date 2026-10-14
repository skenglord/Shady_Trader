import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FreqtradeBridge } from '../../backend/freqtrade/bridge.js';

test('backtesting reads only the current job directory and normalizes native strategy results', async () => {
  const bridge = new FreqtradeBridge();
  let directory = '';
  (bridge as any).runAndCaptureStdout = async (_id: string, args: string[]) => {
    assert.ok(args.includes('--backtest-directory'));
    assert.ok(!args.includes('--export-filename'));
    assert.ok(!args.includes('--fee'), 'an omitted fee must not leave a dangling flag');
    assert.ok(!args.includes('--timerange'), 'an omitted timerange must not leave a dangling flag');
    directory = args[args.indexOf('--backtest-directory') + 1];
    await fs.writeFile(path.join(directory, 'backtest-result-current.json'), JSON.stringify({ strategy: {
      ShadyTraderReferenceStrategy: { total_trades: 2, profit_total: 0.04, max_drawdown_account: 0.02, results_per_pair: [] }
    } }));
    return { exitCode: 0, stdout: [], stderr: [] };
  };
  try {
    const result = await bridge.runBacktest({ strategy: 'ShadyTraderReferenceStrategy', pairs: ['BTC/USDT:USDT'], timeframe: '1h', dryRunWallet: 1000 });
    assert.equal(result.strategy, 'ShadyTraderReferenceStrategy');
    assert.equal(result.total_trades, 2);
    assert.equal(result.max_drawdown, 0.02);
    assert.equal(result.profit_total, 0.04);
  } finally { if (directory) await fs.rm(directory, { recursive: true }); }
});

test('missing current-job output never returns an old successful backtest', async () => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freqtrade-old-test-'));
  await fs.mkdir(path.join(userDataDir, 'backtest_results'));
  await fs.writeFile(path.join(userDataDir, 'backtest_results', 'backtest-result-old.json'), JSON.stringify({ strategy: 'OldStrategy', total_trades: 99 }));
  const bridge = new FreqtradeBridge({ userDataDir });
  let directory = '';
  (bridge as any).runAndCaptureStdout = async (_id: string, args: string[]) => {
    directory = args[args.indexOf('--backtest-directory') + 1];
    return { exitCode: 0, stdout: [], stderr: [] };
  };
  try { await assert.rejects(bridge.runBacktest({ strategy: 'NewStrategy', pairs: ['BTC/USDT:USDT'], timeframe: '1h', dryRunWallet: 1000 }), /current job|produce/); }
  finally { await fs.rm(userDataDir, { recursive: true }); if (directory?.includes('freqtrade-backtest-')) await fs.rm(directory, { recursive: true }); }
});
