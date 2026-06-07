// cli/src/commands/monitor.ts
// Real-time monitoring command with two modes:
//   • TUI mode (default, attached terminal): blessed-contrib dashboard with
//     positions, mode performance, and a live log box.
//   • JSON mode (--once, or stdout is not a TTY): a single non-interactive
//     poll that prints a structured snapshot to stdout. This is the
//     smoketest/agent-friendly path so `npm run cli:monitor` works in
//     pipes, cron, CI, and the human-browser-qa harness.
//
// Flags:
//   --once             Print a single snapshot and exit (no TUI, no polling).
//   -i, --interval     Refresh interval in ms (TUI mode only, default 5000).
import { Command } from 'commander';
import chalk from 'chalk';
import { apiGet, BOT_BASE } from '../utils/api.js';

export const monitorCmd = new Command('monitor')
  .description('Real-time TUI dashboard (or use --once for a JSON snapshot)');

monitorCmd
  .option('-i, --interval <ms>', 'refresh interval (TUI mode only)', '5000')
  .option('--once', 'print a single JSON snapshot and exit (non-interactive)')
  .action(async (opts: { interval: string; once?: boolean }) => {
    const wantsOnce = Boolean(opts.once) || !process.stdout.isTTY;

    if (wantsOnce) {
      // Non-interactive snapshot path. Safe to run from a pipe, CI, or
      // agent harness. Prints a single JSON document to stdout.
      try {
        const [status, positions, performance, balances, signals] = await Promise.all([
          apiGet('/status').catch((e) => ({ error: e.message })),
          apiGet('/positions/open').catch(() => []),
          apiGet('/performance').catch(() => ({})),
          apiGet('/balances').catch(() => ({})),
          apiGet('/signals?limit=5').catch(() => []),
        ]);
        const snapshot = {
          ts: new Date().toISOString(),
          base: BOT_BASE,
          status,
          openPositions: Array.isArray(positions) ? positions : [],
          performance: performance || {},
          balances: balances || {},
          recentSignals: Array.isArray(signals) ? signals : [],
        };
        console.log(JSON.stringify(snapshot, null, 2));
      } catch (e: any) {
        console.error(chalk.red(`monitor --once failed: ${e.message}`));
        process.exitCode = 1;
      }
      return;
    }

    // Interactive TUI path. Requires a TTY.
    let blessed: any, contrib: any;
    try {
      blessed = (await import('blessed')).default ?? (await import('blessed'));
      contrib = (await import('blessed-contrib')).default ?? (await import('blessed-contrib'));
    } catch (e: any) {
      console.error(chalk.red(`TUI deps unavailable: ${e.message}`));
      console.error(chalk.yellow('Hint: re-run with --once for a non-interactive snapshot.'));
      process.exitCode = 1;
      return;
    }

    const screen = blessed.screen({ smartCSR: true, title: 'Shady Bot Monitor' });
    const grid = new contrib.grid({ rows: 12, cols: 12, screen });

    const posTable = grid.set(0, 0, 6, 6, contrib.table, {
      label: ' Active Positions ', keys: true, columnWidth: [10, 6, 12, 8],
      columnSpacing: 2,
    });
    const perfTable = grid.set(0, 6, 6, 6, contrib.table, {
      label: ' Mode Performance ', keys: true, columnWidth: [18, 10, 12],
      columnSpacing: 2,
    });
    const logBox = grid.set(6, 0, 6, 12, contrib.log, { label: ' Live Log ', fg: 'green' });

    logBox.log(`Connected to ${BOT_BASE}`);

    async function refresh() {
      try {
        const status = await apiGet('/status');
        logBox.log(`[${new Date().toLocaleTimeString()}] regime=${status.currentRegime ?? '?'} running=${status.isRunning ?? '?'}`);

        const positions = await apiGet('/positions/open').catch(() => []);
        const posRows = (Array.isArray(positions) ? positions : []).slice(0, 10)
          .map((p: any) => [p.symbol ?? '?', p.side ?? '?', String(p.price ?? p.entryPrice ?? ''), String(p.status ?? 'OPEN')]);
        posTable.setData({ headers: ['Symbol', 'Side', 'Price', 'Status'], data: posRows });

        const perf = await apiGet('/performance').catch(() => ({}));
        const perfRows = Object.entries(perf || {}).map(([mode, v]: [string, any]) =>
          [mode, `${((v.winRate ?? 0) * 100).toFixed(1)}%`, `$${(v.totalPnl ?? 0).toFixed(0)}`]);
        perfTable.setData({ headers: ['Mode', 'WinRate', 'PnL'], data: perfRows });

        screen.render();
      } catch (e: any) {
        logBox.log(chalk.red(`refresh error: ${e.message}`));
        screen.render();
      }
    }

    screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
    await refresh();
    const timer = setInterval(refresh, parseInt(opts.interval, 10));
    screen.on('destroy', () => clearInterval(timer));
  });
