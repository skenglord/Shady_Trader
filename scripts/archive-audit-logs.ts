#!/usr/bin/env tsx

import { runQuery } from '../backend/database.js';

async function archiveOldAuditLogs() {
  console.log('Starting audit log archiving...');

  try {
    // Archive records older than 90 days (configurable)
    const cutoffTimestamp = Date.now() - (90 * 24 * 60 * 60 * 1000);

    // Archive trades
    const archivedTrades = await runQuery(`
      INSERT INTO audit_trades_archive
      SELECT *, ? as archived_at FROM audit_trades WHERE timestamp < ?
    `, [Date.now(), cutoffTimestamp], 'run');

    const deletedTrades = await runQuery(`
      DELETE FROM audit_trades WHERE timestamp < ?
    `, [cutoffTimestamp], 'run');

    console.log(`Archived ${archivedTrades.changes || 0} trade audit records`);

    // Archive balances
    const archivedBalances = await runQuery(`
      INSERT INTO audit_balances_archive
      SELECT *, ? as archived_at FROM audit_balances WHERE timestamp < ?
    `, [Date.now(), cutoffTimestamp], 'run');

    const deletedBalances = await runQuery(`
      DELETE FROM audit_balances WHERE timestamp < ?
    `, [cutoffTimestamp], 'run');

    console.log(`Archived ${archivedBalances.changes || 0} balance audit records`);

    // Archive user actions
    const archivedUserActions = await runQuery(`
      INSERT INTO audit_user_actions_archive
      SELECT *, ? as archived_at FROM audit_user_actions WHERE timestamp < ?
    `, [Date.now(), cutoffTimestamp], 'run');

    const deletedUserActions = await runQuery(`
      DELETE FROM audit_user_actions WHERE timestamp < ?
    `, [cutoffTimestamp], 'run');

    console.log(`Archived ${archivedUserActions.changes || 0} user action audit records`);

    // Archive system events
    const archivedSystemEvents = await runQuery(`
      INSERT INTO audit_system_events_archive
      SELECT *, ? as archived_at FROM audit_system_events WHERE timestamp < ?
    `, [Date.now(), cutoffTimestamp], 'run');

    const deletedSystemEvents = await runQuery(`
      DELETE FROM audit_system_events WHERE timestamp < ?
    `, [cutoffTimestamp], 'run');

    console.log(`Archived ${archivedSystemEvents.changes || 0} system event audit records`);

    console.log('Audit log archiving completed successfully');
  } catch (error) {
    console.error('Failed to archive audit logs:', error);
    throw error;
  }
}

// Export archived data to external storage (future enhancement)
async function exportArchivedLogs() {
  console.log('Exporting archived audit logs...');

  try {
    // This would export to external storage like S3, GCS, etc.
    // For now, just log the count of archived records
    const [tradeCount] = await runQuery('SELECT COUNT(*) as count FROM audit_trades_archive', [], 'all');
    const [balanceCount] = await runQuery('SELECT COUNT(*) as count FROM audit_balances_archive', [], 'all');
    const [userActionCount] = await runQuery('SELECT COUNT(*) as count FROM audit_user_actions_archive', [], 'all');
    const [systemEventCount] = await runQuery('SELECT COUNT(*) as count FROM audit_system_events_archive', [], 'all');

    console.log('Archived log counts:');
    console.log(`- Trades: ${tradeCount?.count || 0}`);
    console.log(`- Balances: ${balanceCount?.count || 0}`);
    console.log(`- User Actions: ${userActionCount?.count || 0}`);
    console.log(`- System Events: ${systemEventCount?.count || 0}`);

    // TODO: Implement actual export to external storage
    console.log('External export not yet implemented - records stored in archive tables');
  } catch (error) {
    console.error('Failed to export archived logs:', error);
    throw error;
  }
}

async function main() {
  try {
    await archiveOldAuditLogs();
    await exportArchivedLogs();
  } catch (error) {
    console.error('Audit archiving failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { archiveOldAuditLogs, exportArchivedLogs };