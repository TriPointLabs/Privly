/**
 * Privacy-focused persistent logging for the service worker.
 *
 * Replaces console logging in production. Entries are redacted at the write
 * site (never downstream) and stored in the `logs` IndexedDB store as a ring
 * buffer capped by the `logMaxEntries` setting. The popup's Debug panel reads
 * the store; nothing here fires DB_CHANGED, so logging can never trigger UI
 * refresh loops.
 *
 * Redaction rules (enforced by callers, checked in review):
 * - Never log tokens, claims JSON, justification text, ticket numbers, or full
 *   message payloads.
 * - Mask UPNs/emails with `maskUpn()` and GUIDs with `shortId()` before
 *   interpolating them into a message.
 * - Role/group/scope display names, HTTP statuses, counts, durations, and
 *   Graph/ARM error codes are allowed.
 */
import { getDB, getExtensionSettings } from '../tools/db.ts';

/** Severity of a log entry. 'error' means the user saw or will see a failure. */
export type LogLevel = 'info' | 'warn' | 'error';
/** Coarse source area used for filtering in the Debug panel. */
export type LogCategory = 'sync' | 'auth' | 'activate' | 'approval' | 'alarm' | 'account' | 'message' | 'popup' | 'general';

/** Masks a UPN/email to `d***@s***.us` form; non-emails keep only their first character. */
export function maskUpn(upn: string | null | undefined): string {
  if (!upn) return '(none)';
  const at = upn.indexOf('@');
  if (at < 1) return `${upn[0]}***`;
  const domain = upn.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot > 0 ? domain.slice(lastDot) : '';
  return `${upn[0]}***@${domain[0]}***${tld}`;
}

/** Shortens a GUID/UUID to its first 8 characters: enough to correlate, not to identify. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '(none)';
}

// Settings are read on every log call; cache briefly so logging does not
// double the DB read volume it is meant to observe.
const SETTINGS_CACHE_TTL_MS = 30_000;
let settingsCache: { loggingEnabled: boolean; logMaxEntries: number } | null = null;
let settingsCachedAt = 0;

/** Forces the next log() call to re-read settings. Call after settings writes. */
export function refreshLogSettings(): void {
  settingsCache = null;
}

async function getLogSettings(): Promise<{ loggingEnabled: boolean; logMaxEntries: number }> {
  if (!settingsCache || Date.now() - settingsCachedAt > SETTINGS_CACHE_TTL_MS) {
    const s = await getExtensionSettings();
    settingsCache = { loggingEnabled: s.loggingEnabled ?? true, logMaxEntries: s.logMaxEntries ?? 500 };
    settingsCachedAt = Date.now();
  }
  return settingsCache;
}

// Evict in batches rather than on every write so the common path is one add()
// plus one count().
const EVICTION_SLACK = 50;

/**
 * Records a redacted log entry. Fire-and-forget: persistence errors are
 * swallowed so logging can never break the operation being logged. In dev
 * builds the entry is mirrored to the console.
 */
export function log(level: LogLevel, category: LogCategory, message: string): void {
  if (import.meta.env.DEV) {
    const mirror = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    mirror(`[privly][${category}] ${message}`);
  }
  void persist(level, category, message).catch(() => {});
}

async function persist(level: LogLevel, category: LogCategory, message: string): Promise<void> {
  const settings = await getLogSettings();
  if (!settings.loggingEnabled) return;
  const db = await getDB();
  await db.add('logs', { timestamp: Date.now(), level, category, message });
  const count = await db.count('logs');
  if (count > settings.logMaxEntries + EVICTION_SLACK) {
    const tx = db.transaction('logs', 'readwrite');
    let toDelete = count - settings.logMaxEntries;
    let cursor = await tx.store.openCursor();
    while (cursor && toDelete > 0) {
      await cursor.delete();
      toDelete--;
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}

/** Clears all log entries. Used when the user disables logging. */
export async function clearLogs(): Promise<void> {
  const db = await getDB();
  await db.clear('logs');
}
