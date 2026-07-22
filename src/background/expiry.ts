/**
 * Expiry notifications for active role, group, and Azure activations.
 *
 * `checkExpiries()` fires "expiring soon" and "expired" notifications for any
 * live activation whose moment has arrived, then schedules a single one-shot
 * `expiry-check` alarm at the next upcoming warn/expire moment so timing is
 * exact even between 5-minute sync cycles. Each notification fires at most
 * once per activation, tracked via `notifiedExpiring`/`notifiedExpired` flags
 * that the sync layer carries across record rewrites while the expiry is
 * unchanged. The 5-minute cycle and every service worker wake also call this
 * as a catch-up in case the worker was asleep at alarm time.
 */
import browser from 'webextension-polyfill';
import { getDB, getExtensionSettings, type ActivationRecord, type AzureActivationRecord } from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import { log } from './log.ts';

/** Name of the one-shot alarm that wakes the SW at the next warn/expire moment. */
export const EXPIRY_ALARM = 'expiry-check';

/** Do not fire "expired" for records that expired more than this long ago (e.g. before install). */
const EXPIRED_GRACE_MS = 15 * 60 * 1000;

// Last scheduled alarm moment; used to log only when the schedule actually moves
// (checkExpiries runs on every wake and cycle, so unconditional logging would be chatter).
let lastScheduledAt: number | null = null;

/**
 * Fires any due expiry notifications, persists the once-only flags, and
 * (re)schedules the `expiry-check` alarm for the next upcoming moment.
 * Idempotent: safe to call from alarms, sync cycles, and SW wake-ups.
 */
export async function checkExpiries(): Promise<void> {
  const settings = await getExtensionSettings();
  if (!settings.showNotifications) return;
  const leadMs = settings.notifyMinutesBefore * 60_000;
  const db = await getDB();
  const now = Date.now();

  const [entra, azure, groups] = await Promise.all([
    db.getAll('activations'),
    db.getAll('azure_activations'),
    db.getAll('groups'),
  ]);
  const groupNames = new Map(groups.map(g => [g.groupId, g.displayName]));

  let nextAt = Infinity;
  const updatedEntra: ActivationRecord[] = [];
  const updatedAzure: AzureActivationRecord[] = [];

  /** Decides what to fire now for one record and tracks the next future moment. */
  const consider = (expiresAt: number, notifiedExpiring?: boolean, notifiedExpired?: boolean): 'warn' | 'expire' | null => {
    const warnAt = expiresAt - leadMs;
    if (now >= expiresAt) {
      return !notifiedExpired && now - expiresAt <= EXPIRED_GRACE_MS ? 'expire' : null;
    }
    // Expiry is still upcoming; it is always the next moment for this record.
    if (!notifiedExpired) nextAt = Math.min(nextAt, expiresAt);
    if (!notifiedExpiring) {
      if (now >= warnAt) return 'warn';
      nextAt = Math.min(nextAt, warnAt);
    }
    return null;
  };

  const minutesLeftLabel = (expiresAt: number): string => {
    const mins = Math.max(1, Math.round((expiresAt - now) / 60_000));
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  };

  for (const a of entra) {
    if (a.isPermanent || a.expiresAt <= 0) continue;
    const action = consider(a.expiresAt, a.notifiedExpiring, a.notifiedExpired);
    if (!action) continue;
    let name: string;
    if (a.kind === 'group') {
      name = groupNames.get(a.groupId ?? '') ?? a.groupId ?? 'Group';
    } else {
      const def = a.roleDefinitionId ? await db.get('role_definitions', a.roleDefinitionId) : undefined;
      name = def?.displayName ?? a.roleDefinitionId ?? 'Role';
    }
    if (action === 'warn') {
      await notify(a.kind === 'group' ? 'Group access expiring' : 'Role expiring', `"${name}" expires in about ${minutesLeftLabel(a.expiresAt)}`, 'expiring');
      updatedEntra.push({ ...a, notifiedExpiring: true });
    } else {
      await notify(a.kind === 'group' ? 'Group access expired' : 'Role expired', `"${name}" has expired`, 'expired');
      updatedEntra.push({ ...a, notifiedExpiring: true, notifiedExpired: true });
    }
  }

  for (const a of azure) {
    if (a.isPermanent || a.endDateTime <= 0) continue;
    const action = consider(a.endDateTime, a.notifiedExpiring, a.notifiedExpired);
    if (!action) continue;
    if (action === 'warn') {
      await notify('Azure role expiring', `"${a.roleDisplayName}" expires in about ${minutesLeftLabel(a.endDateTime)}`, 'expiring');
      updatedAzure.push({ ...a, notifiedExpiring: true });
    } else {
      await notify('Azure role expired', `"${a.roleDisplayName}" has expired`, 'expired');
      updatedAzure.push({ ...a, notifiedExpiring: true, notifiedExpired: true });
    }
  }

  if (updatedEntra.length > 0 || updatedAzure.length > 0) {
    // Flag writes only -- deliberately no DB_CHANGED, nothing user-visible changed.
    const tx = db.transaction(['activations', 'azure_activations'], 'readwrite');
    await Promise.all([
      ...updatedEntra.map(a => tx.objectStore('activations').put(a)),
      ...updatedAzure.map(a => tx.objectStore('azure_activations').put(a)),
    ]);
    await tx.done;
    log('info', 'alarm', `Fired ${updatedEntra.length + updatedAzure.length} expiry notification(s)`);
  }

  if (Number.isFinite(nextAt)) {
    // One-shot alarm at the earliest upcoming moment; create() replaces any prior schedule.
    browser.alarms.create(EXPIRY_ALARM, { when: nextAt });
    if (lastScheduledAt !== nextAt) {
      lastScheduledAt = nextAt;
      log('info', 'alarm', `expiry-check scheduled for ${new Date(nextAt).toLocaleString()}`);
    }
  } else {
    if (lastScheduledAt !== null) log('info', 'alarm', 'expiry-check alarm cleared (no upcoming expiries)');
    lastScheduledAt = null;
    await browser.alarms.clear(EXPIRY_ALARM);
  }
}
