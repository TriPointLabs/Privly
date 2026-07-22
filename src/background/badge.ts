/**
 * Extension action badge and alarm management.
 *
 * Owns the badge count display (active activations for the selected account)
 * and the two recurring alarms: `token-refresh` (5-minute interval) and
 * `pending-approval-check` (1-minute interval, created on demand).
 */
import browser from 'webextension-polyfill';
import { getDB, getExtensionSettings, type ExtensionSettingsRecord } from '../tools/db.js';
import { log } from './log.ts';

/**
 * Updates the extension action badge to show the number of active activations
 * for the currently selected account.
 *
 * Clears the badge if the setting is disabled, no account is active, or there
 * are no activations. Accepts pre-fetched settings to avoid a redundant DB
 * read when called immediately after a settings update.
 * @param [knownSettings] - Pre-fetched settings; if omitted, settings are read from the DB.
 */
export async function updateBadge(knownSettings?: ExtensionSettingsRecord): Promise<void> {
  const settings = knownSettings ?? await getExtensionSettings();
  if (!settings.showBadge) {
    await browser.action.setBadgeText({ text: '' });
    return;
  }
  const stored = await browser.storage.local.get('activeAccountId');
  const activeAccountId = stored['activeAccountId'] as string | undefined;
  if (!activeAccountId) {
    await browser.action.setBadgeText({ text: '' });
    return;
  }
  const db = await getDB();
  const [activations, account] = await Promise.all([
    db.getAllFromIndex('activations', 'by-account', activeAccountId),
    db.get('accounts', activeAccountId),
  ]);
  const showPermanent = account?.showPermanentAssignments ?? false;
  const now = Date.now();
  const count = activations.filter(a =>
    (a.expiresAt === 0 || a.expiresAt > now) &&
    (showPermanent || !a.isPermanent)
  ).length;
  await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
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
