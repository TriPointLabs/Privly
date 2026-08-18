/**
 * Saved activation justifications ("prefills").
 *
 * Owns every write to the `justification_prefills` store: the dedupe and
 * least-recently-used eviction rules on save, and removal from the picker.
 * Lives in its own module because both the Entra activation path
 * (`handlers.ts`) and the Azure ARM path (`azureHandlers.ts`) save prefills,
 * and `handlers.ts` already imports `azureHandlers.ts`.
 *
 * Prefill text is user-authored free text and is treated exactly like the
 * justification it came from: never logged, never surfaced in the Debug panel
 * snapshot, and deleted along with the account on sign-out.
 */
import { getDB, MAX_JUSTIFICATION_LENGTH, MAX_JUSTIFICATION_PREFILLS } from '../tools/db.ts';
import type { CommandAck } from '../types/messages.ts';
import { notifyDbChanged } from './utils.ts';
import { log, shortId } from './log.ts';

/**
 * Stores `justification` as a reusable prefill for `accountId`, if there is
 * anything to store. Callers invoke this only after an activation request has
 * been accepted, so a rejected request never pollutes the list.
 *
 * Re-saving text that already exists refreshes its `lastUsedAt` rather than
 * adding a duplicate, which also floats it back to the top of the picker. Once
 * the account holds `MAX_JUSTIFICATION_PREFILLS`, the least recently used
 * entries are evicted to make room.
 *
 * The read runs inside the write transaction so two activations completing at
 * the same time cannot both miss the duplicate check.
 * @param accountId - Account the prefill belongs to.
 * @param justification - Raw justification from the activation payload; blank or absent is a no-op.
 */
export async function saveJustificationPrefill(
  accountId: string,
  justification: string | undefined,
): Promise<void> {
  const text = justification?.trim().slice(0, MAX_JUSTIFICATION_LENGTH) ?? '';
  if (!text) return;

  const db = await getDB();
  const now = Date.now();
  const tx = db.transaction('justification_prefills', 'readwrite');
  const existing = await tx.store.index('by-account').getAll(accountId);
  const match = existing.find(p => p.text === text);

  if (match) {
    await tx.store.put({ ...match, lastUsedAt: now });
  } else {
    await tx.store.put({ id: crypto.randomUUID(), accountId, text, createdAt: now, lastUsedAt: now });
    const overflow = existing.length + 1 - MAX_JUSTIFICATION_PREFILLS;
    if (overflow > 0) {
      const evict = [...existing].sort((a, b) => a.lastUsedAt - b.lastUsedAt).slice(0, overflow);
      await Promise.all(evict.map(p => tx.store.delete(p.id)));
    }
  }
  await tx.done;

  const stored = Math.min(existing.length + (match ? 0 : 1), MAX_JUSTIFICATION_PREFILLS);
  log('info', 'activate', `Justification prefill ${match ? 'refreshed' : 'saved'} (${stored} stored)`);
  notifyDbChanged('justification_prefills');
}

/**
 * Removes one saved prefill, rejecting a record that belongs to a different
 * account. A prefill that is already gone reports success so a double-click in
 * the picker is harmless.
 * @param accountId - Account the caller believes owns the prefill.
 * @param prefillId - Record key to delete.
 */
export async function deleteJustificationPrefill(
  accountId: string,
  prefillId: string,
): Promise<CommandAck> {
  const db = await getDB();
  const record = await db.get('justification_prefills', prefillId);
  if (!record) return { ok: true };
  if (record.accountId !== accountId) return { ok: false, error: 'Prefill does not belong to this account' };

  await db.delete('justification_prefills', prefillId);
  log('info', 'activate', `Justification prefill deleted (${shortId(prefillId)})`);
  notifyDbChanged('justification_prefills');
  return { ok: true };
}
