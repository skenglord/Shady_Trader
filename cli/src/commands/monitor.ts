// cli/src/commands/monitor.ts — blessed-contrib TUI dashboard (core panels).
// Wave 7 (14-panels) extends this with regime-v2 / ratchet / bayesian / ml panels.
import { Command } from 'commander';
import chalk from 'chalk';
import { apiGet, BOT_BASE } from '../utils/api.js';

export const monitorCmd = new Command('monitor').description('Real-time TUI dashboard');

monitorCmd.option('-i, --interval <ms>', 'refresh interval', '5000').action(async (opts: { interval: string }) => {
  let blessed: any, contrib: any;
  try {
    blessed = (await import('blessed')).default ?? (await import('blessed'));
    contrib = (await import('blessed-contrib')).default ?? (await import('blessed-contrib'));
  } catch (e: any) {
    console.error(chalk.red(`TUI deps unavailable: ${e.message}`));
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
