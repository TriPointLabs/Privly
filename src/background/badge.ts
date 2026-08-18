/**
 * Extension action badge and alarm management.
 *
 * The badge shows how long is left on the soonest-expiring activation for the
 * selected account -- "42m", "2h" -- so the user can tell at a glance whether
 * they need to reactivate without opening the popup (CS-4). It is blank when
 * nothing has a timer running: permanent assignments carry no expiry, so an
 * account holding only those shows nothing.
 *
 * Also owns the recurring alarms: `token-refresh` (5-minute interval),
 * `pending-approval-check` (1-minute, created on demand), and `badge-tick`
 * (1-minute, live only while a timed activation exists).
 */
import browser from 'webextension-polyfill';
import { getDB, getExtensionSettings, type ExtensionSettingsRecord } from '../tools/db.js';
import { log } from './log.ts';

/** Ticks the badge countdown down; exists only while something is counting. */
export const BADGE_ALARM = 'badge-tick';

/** Default badge background. */
const BADGE_COLOR = '#7c3aed';
/** Badge background once the soonest expiry is inside the notification lead time. */
const BADGE_COLOR_WARNING = '#b45309';

/**
 * Renders milliseconds-remaining as a badge label.
 *
 * The badge fits roughly four characters, so the unit steps up rather than
 * combining units: minutes below an hour, whole hours below a day, then days.
 * Minutes round up so a live activation never reads "0m" -- the last minute
 * shows "1m" until it has actually expired.
 * @param msRemaining - Milliseconds until the activation expires.
 * @returns A short label, or '' when nothing is left to show.
 */
export function formatBadgeCountdown(msRemaining: number): string {
  const minutes = Math.ceil(msRemaining / 60_000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 10 ? `${days}d` : '9d+';
}

/**
 * Returns the epoch-millisecond expiry of the soonest-expiring live activation
 * for `accountId`, or null when the account has none.
 *
 * Covers Entra roles and groups plus Azure ARM roles: an Azure role is still a
 * role the user needs to reactivate. Permanent assignments and records with no
 * expiry are skipped, as are any that have already lapsed but not yet synced
 * away.
 * @param accountId - `AccountRecord.id` to inspect.
 */
async function soonestExpiryAt(accountId: string): Promise<number | null> {
  const db = await getDB();
  const [entra, azure] = await Promise.all([
    db.getAllFromIndex('activations', 'by-account', accountId),
    db.getAllFromIndex('azure_activations', 'by-account', accountId),
  ]);

  const now = Date.now();
  const expiries = [
    ...entra.filter(a => !a.isPermanent && a.expiresAt > now).map(a => a.expiresAt),
    ...azure.filter(a => !a.isPermanent && a.endDateTime > now).map(a => a.endDateTime),
  ];
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

/**
 * Repaints the badge for the active account and reconciles the `badge-tick`
 * alarm in the same pass, so the alarm can never outlive what it is ticking.
 *
 * Clears both when the badge is disabled, when no account is selected, or when
 * nothing has a timer.
 * @param [knownSettings] - Pre-fetched settings; if omitted, settings are read from the DB.
 */
export async function updateBadge(knownSettings?: ExtensionSettingsRecord): Promise<void> {
  const settings = knownSettings ?? await getExtensionSettings();

  let expiresAt: number | null = null;
  if (settings.showBadge) {
    const stored = await browser.storage.local.get('activeAccountId');
    const activeAccountId = stored['activeAccountId'] as string | undefined;
    if (activeAccountId) expiresAt = await soonestExpiryAt(activeAccountId);
  }

  if (expiresAt === null) {
    await browser.action.setBadgeText({ text: '' });
    await reconcileBadgeAlarm(false);
    return;
  }

  const remaining = expiresAt - Date.now();
  const warning = remaining <= settings.notifyMinutesBefore * 60_000;
  await browser.action.setBadgeBackgroundColor({ color: warning ? BADGE_COLOR_WARNING : BADGE_COLOR });
  await browser.action.setBadgeText({ text: formatBadgeCountdown(remaining) });
  await reconcileBadgeAlarm(true);
}

/**
 * Creates or clears the 1-minute `badge-tick` alarm.
 *
 * A periodic alarm rather than a one-shot scheduled at the next display change:
 * the label changes every minute for most of an activation's life, so the
 * bookkeeping to compute the next change would cost more than it saves. The
 * alarm exists only while something is counting down, matching how
 * `pending-approval-check` avoids waking the worker for nothing.
 * @param needed - Whether a countdown is currently displayed.
 */
async function reconcileBadgeAlarm(needed: boolean): Promise<void> {
  const existing = await browser.alarms.get(BADGE_ALARM);
  if (needed && !existing) {
    await browser.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
    log('info', 'alarm', 'badge-tick alarm created');
  } else if (!needed && existing) {
    await browser.alarms.clear(BADGE_ALARM);
    log('info', 'alarm', 'badge-tick alarm cleared');
  }
}

/**
 * Ensures the token-refresh alarm exists. Checks before creating so it is
 * safe to call on every SW startup without creating duplicate alarms.
 */
export async function ensureAlarms(): Promise<void> {
  const existing = await browser.alarms.get('token-refresh');
  if (!existing) {
    await browser.alarms.create('token-refresh', { periodInMinutes: 5 });
    log('info', 'alarm', 'token-refresh alarm created');
  }
}

/**
 * Creates the `pending-approval-check` alarm (1-minute interval) if any account
 * has pending requests, or clears it if none do. Safe to call repeatedly.
 *
 * The alarm only exists while it is needed so the SW is not woken unnecessarily.
 */
export async function reconcilePendingApprovalAlarm(): Promise<void> {
  const db = await getDB();
  const any = await db.getAll('pending_requests');
  if (any.length > 0) {
    const existing = await browser.alarms.get('pending-approval-check');
    if (!existing) {
      await browser.alarms.create('pending-approval-check', { periodInMinutes: 1 });
      log('info', 'alarm', 'pending-approval-check alarm created');
    }
  } else {
    await browser.alarms.clear('pending-approval-check');
  }
}
