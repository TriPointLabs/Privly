/**
 * Typed message contract for all communication between the popup and the
 * service worker.
 *
 * Two message directions are defined:
 * - Notifications (SW -> popup): fire-and-forget, no response expected.
 * - Commands (popup -> SW): each returns a `CommandAck`.
 *
 * Never use ad-hoc message objects outside this module.
 */
import browser from 'webextension-polyfill';
import type { ExtensionSettingsRecord } from '../tools/db.js';

/** Union of all IndexedDB store names that can appear in a `DB_CHANGED` message. */
export type StoreName =
  | 'accounts' | 'role_definitions' | 'role_policies' | 'roles' | 'groups' | 'group_policies'
  | 'activations' | 'activating' | 'approvals' | 'pending_requests' | 'extension_settings' | 'states'
  | 'azure_scopes' | 'azure_roles' | 'azure_activations' | 'azure_policies' | 'justification_prefills';

// ---------------------------------------------------------------------------
// Notifications: SW -> popup, fire-and-forget, no response
// ---------------------------------------------------------------------------

/**
 * Sent by the service worker after any IndexedDB write. The popup re-queries
 * only the listed stores rather than reloading all data.
 */
export interface DbChangedMessage {
  type: 'DB_CHANGED';
  stores: StoreName[];
}

/**
 * Sent by the service worker before and after a PIM data sync cycle.
 * The popup uses this to show or hide a syncing indicator.
 */
export interface SyncStatusMessage {
  type: 'SYNC_STATUS';
  running: boolean;
}

/**
 * Sent by the service worker after a notification fires to trigger an
 * in-popup sound effect. Fire-and-forget -- the popup may not be open.
 * Sound files live in `public/sounds/`.
 */
export interface PlaySoundMessage {
  type: 'PLAY_SOUND';
  sound: 'ping' | 'expiring' | 'expired';
}

/** Union of all fire-and-forget notifications the service worker sends to the popup. */
export type NotificationMessage = DbChangedMessage | SyncStatusMessage | PlaySoundMessage;

/**
 * Sends a typed fire-and-forget notification from the service worker to the
 * popup. The popup may not be open, so delivery failures are expected and
 * swallowed. All SW -> popup sends must go through this helper -- never build
 * ad-hoc message objects outside this module.
 */
export function sendNotification(message: NotificationMessage): void {
  browser.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Commands: popup -> SW, returns CommandAck
// ---------------------------------------------------------------------------

/** All message type discriminants in the popup <-> service worker contract. */
export const MessageType = {
  DB_CHANGED: 'DB_CHANGED',
  TRIGGER_SYNC: 'TRIGGER_SYNC',
  SIGN_IN_NEW: 'SIGN_IN_NEW',
  SIGN_IN_INTERACTIVE: 'SIGN_IN_INTERACTIVE',
  SIGN_OUT: 'SIGN_OUT',
  UPDATE_EXTENSION_SETTING: 'UPDATE_EXTENSION_SETTING',
  UPDATE_ACCOUNT_SETTING: 'UPDATE_ACCOUNT_SETTING',
  TEST_NOTIFICATION: 'TEST_NOTIFICATION',
  ACTIVATE_ROLE: 'ACTIVATE_ROLE',
  DEACTIVATE_ROLE: 'DEACTIVATE_ROLE',
  ACTIVATE_GROUP: 'ACTIVATE_GROUP',
  DEACTIVATE_GROUP: 'DEACTIVATE_GROUP',
  ACTIVATE_AZURE_ROLE: 'ACTIVATE_AZURE_ROLE',
  DEACTIVATE_AZURE_ROLE: 'DEACTIVATE_AZURE_ROLE',
  APPROVE_REQUEST: 'APPROVE_REQUEST',
  DENY_REQUEST: 'DENY_REQUEST',
  CANCEL_REQUEST: 'CANCEL_REQUEST',
  CLEAR_LOGS: 'CLEAR_LOGS',
  LOG_EVENT: 'LOG_EVENT',
  DELETE_JUSTIFICATION_PREFILL: 'DELETE_JUSTIFICATION_PREFILL',
} as const;

/** Union of every message type string. */
export type MessageType = typeof MessageType[keyof typeof MessageType];

/**
 * `savePrefill` on the activation commands asks the service worker to store the
 * submitted justification as a reusable prefill once the request succeeds. It
 * rides along with the activation rather than using a separate command so the
 * dialog makes one round trip and nothing is saved for a request that failed.
 */
interface CommandPayloadMap {
  [MessageType.TRIGGER_SYNC]: Record<string, never>;
  [MessageType.SIGN_IN_NEW]: { username: string; tenantId?: string };
  [MessageType.SIGN_IN_INTERACTIVE]: { accountId: string };
  [MessageType.SIGN_OUT]: { accountId: string };
  [MessageType.UPDATE_EXTENSION_SETTING]: { patch: Partial<Omit<ExtensionSettingsRecord, 'id'>> };
  [MessageType.UPDATE_ACCOUNT_SETTING]: { accountId: string; patch: { showPermanentAssignments?: boolean } };
  [MessageType.TEST_NOTIFICATION]: Record<string, never>;
  [MessageType.ACTIVATE_ROLE]: { accountId: string; roleId: string; justification?: string; durationMinutes: number; ticketNumber?: string; ticketSystem?: string; savePrefill?: boolean };
  [MessageType.DEACTIVATE_ROLE]: { accountId: string; activationId: string };
  [MessageType.ACTIVATE_GROUP]: { accountId: string; groupId: string; justification?: string; durationMinutes: number; ticketNumber?: string; ticketSystem?: string; savePrefill?: boolean };
  [MessageType.DEACTIVATE_GROUP]: { accountId: string; activationId: string };
  [MessageType.ACTIVATE_AZURE_ROLE]: { accountId: string; azureRoleId: string; justification?: string; durationMinutes: number; ticketNumber?: string; ticketSystem?: string; savePrefill?: boolean };
  [MessageType.DEACTIVATE_AZURE_ROLE]: { accountId: string; azureActivationId: string };
  [MessageType.APPROVE_REQUEST]: { accountId: string; approvalId: string; justification?: string };
  [MessageType.DENY_REQUEST]: { accountId: string; approvalId: string; justification?: string };
  [MessageType.CANCEL_REQUEST]: { accountId: string; requestId: string; kind: 'role' | 'group' };
  [MessageType.CLEAR_LOGS]: Record<string, never>;
  /** Popup-originated diagnostic entry. The SW records it under the 'popup' category. Senders must not include identifiers -- the popup has no redaction helpers. */
  [MessageType.LOG_EVENT]: { level: 'info' | 'warn' | 'error'; message: string };
  /** Removes one saved justification prefill. Issued from the quick-pick list in the activation dialog. */
  [MessageType.DELETE_JUSTIFICATION_PREFILL]: { accountId: string; prefillId: string };
}

/** Discriminated union of every popup -> service worker command with its typed payload. */
export type CommandMessage = {
  [K in keyof CommandPayloadMap]: { type: K; payload: CommandPayloadMap[K] }
}[keyof CommandPayloadMap];

/** Every message that can cross the popup <-> service worker boundary. */
export type AppMessage = DbChangedMessage | SyncStatusMessage | PlaySoundMessage | CommandMessage;

// ---------------------------------------------------------------------------
// Response type for all commands
// ---------------------------------------------------------------------------

/** Standard acknowledgement returned by the service worker for every command. */
export interface CommandAck {
  ok: boolean;
  /** Human-readable error message when `ok` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Single generic type guard -- replaces all per-type isXxxMessage() functions
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows an unknown runtime message to the specific
 * `AppMessage` subtype identified by `type`.
 *
 * Replaces per-message `isXxxMessage()` helpers with a single generic function.
 * @template T - The `MessageType` literal to narrow to.
 * @param type - The expected `type` discriminant value.
 * @param msg - The unknown value received from `browser.runtime.onMessage`.
 * @returns `true` if `msg` is the `AppMessage` subtype for `type`.
 */
export function isMessageOfType<T extends MessageType>(
  type: T,
  msg: unknown
): msg is Extract<AppMessage, { type: T }> {
  return typeof msg === 'object' && msg !== null && (msg as { type: unknown }).type === type;
}

// ---------------------------------------------------------------------------
// Typed send helper for commands
// ---------------------------------------------------------------------------

/**
 * Sends a typed command to the service worker and returns the `CommandAck`
 * response. Provides full type inference for the `payload` based on `type`.
 * @template T - The command type key, used to infer the correct payload shape.
 * @param type - The command type discriminant (e.g. `MessageType.SIGN_IN_NEW`).
 * @param payload - The command payload, typed according to `CommandPayloadMap[T]`.
 * @returns A promise resolving to the service worker's `CommandAck`.
 */
export function sendCommand<T extends keyof CommandPayloadMap>(
  type: T,
  payload: CommandPayloadMap[T]
): Promise<CommandAck> {
  return browser.runtime.sendMessage({ type, payload });
}
