/**
 * Service worker entry point.
 *
 * Registers all top-level event listeners (required synchronously by MV3) and
 * delegates all business logic to focused modules:
 *   - auth.ts     -- token lifecycle, sign-in, step-up auth
 *   - badge.ts    -- badge countdown and alarm management
 *   - sync.ts     -- PIM data sync from Microsoft Graph
 *   - handlers.ts -- typed message dispatcher
 *   - utils.ts    -- shared helpers and constants
 *
 * The popup communicates exclusively via the typed message contract in
 * `src/types/messages.ts` and reads IndexedDB directly in read-only mode.
 */
import browser from 'webextension-polyfill';
import { getDB, consumeMigrationInfo, DEFAULT_EXTENSION_SETTINGS } from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import { updateBadge, ensureAlarms, reconcilePendingApprovalAlarm, BADGE_ALARM } from './badge.ts';
import { runSyncCycle, syncMyPendingRequests, syncActiveAssignments, syncActiveGroupAssignments, cleanStaleActivatingRecords } from './sync.ts';
import { handleMessage } from './handlers.ts';
import { log } from './log.ts';
import { checkExpiries, EXPIRY_ALARM } from './expiry.ts';

// All event listeners registered at top level (MV3 requirement).

browser.runtime.onInstalled.addListener(async () => {
  log('info', 'general', 'Extension installed');
  const db = await getDB();
  const existing = await db.get('extension_settings', 'global');
  if (!existing) {
    await db.put('extension_settings', DEFAULT_EXTENSION_SETTINGS);
  }
  await ensureAlarms();
  await updateBadge();
});

// onInstalled only fires on install/update, not on browser restart or SW wake.
// onStartup covers the browser-restart case so the alarm is always present.
browser.runtime.onStartup.addListener(async () => {
  log('info', 'general', 'Extension startup');
  await ensureAlarms();
  await runSyncCycle();
});

browser.runtime.onMessage.addListener(handleMessage);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'activeAccountId' in changes) {
    updateBadge();
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === EXPIRY_ALARM) {
    await checkExpiries();
    return;
  }

  // Repaints the countdown once a minute while any activation is running.
  // updateBadge clears this alarm itself once nothing is counting down.
  if (alarm.name === BADGE_ALARM) {
    await updateBadge();
    return;
  }

  if (alarm.name === 'pending-approval-check') {
    const db = await getDB();
    const allPending = await db.getAll('pending_requests');
    const accountIds = [...new Set(allPending.map(r => r.accountId))];

    if (accountIds.length === 0) {
      await reconcilePendingApprovalAlarm();
      return;
    }

    // Snapshot pending request IDs per account before syncing so we can detect approvals.
    const preSyncIds = new Map(accountIds.map(id => [
      id,
      new Map(allPending.filter(r => r.accountId === id).map(r => [r.id, r.roleName])),
    ]));

    const freshDb = await getDB();
    await Promise.all(accountIds.map(async id => {
      const account = await freshDb.get('accounts', id);
      if (!account?.accessToken) return;
      // Only the data that changes when a request is approved: the pending list
      // and active assignment state. The full group eligibility+policy sync does
      // not belong on a 1-minute cadence.
      await Promise.all([
        syncMyPendingRequests(account),
        syncActiveAssignments(account),
        syncActiveGroupAssignments(account),
      ]);

      // Notify for each request that disappeared -- it was approved (or denied/cancelled).
      const postDb = await getDB();
      const remaining = new Set((await postDb.getAllFromIndex('pending_requests', 'by-account', id)).map(r => r.id));
      for (const [reqId, roleName] of preSyncIds.get(id) ?? []) {
        if (!remaining.has(reqId)) {
          await notify('Request approved', `"${roleName}" has been activated`, 'ping');
        }
      }
    }));

    await reconcilePendingApprovalAlarm();
    await updateBadge();
    await checkExpiries();
    return;
  }

  if (alarm.name !== 'token-refresh') return;

  // Belt-and-suspenders cleanup: catches stale activating records if the SW was
  // killed mid-poll and the top-level startup cleanup hasn't run since.
  await cleanStaleActivatingRecords().catch(() => {});

  await runSyncCycle();
});

// Startup tasks run after all synchronous addListener calls (MV3 requirement).
// The SW module re-evaluates on every wake-up from sleep, so these run on each resurrection.
cleanStaleActivatingRecords().catch(() => {});
reconcilePendingApprovalAlarm().catch(() => {});
checkExpiries().catch(() => {});
// The countdown goes stale while the worker sleeps; repaint on every wake.
updateBadge().catch(() => {});
void getDB().then(() => {
  const m = consumeMigrationInfo();
  if (m) log('info', 'general', `Database migrated v${m.from} -> v${m.to}`);
}).catch(() => {});

if (import.meta.env.DEV) {
  const ws = new WebSocket('ws://localhost:8765');
  ws.addEventListener('message', (e) => {
    if (e.data === 'reload') browser.runtime.reload();
  });
  ws.addEventListener('error', () => {}); // silence if plugin not running
}
