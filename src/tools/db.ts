import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CloudType } from './oauth.js';

export type { CloudType };

/**
 * Represents a signed-in Microsoft Entra account.
 *
 * `id` is a locally generated UUID (stable across sign-ins for the same
 * `tenantId + accountId` pair). All child stores reference this UUID as a
 * foreign key rather than using the raw Entra IDs.
 *
 * Token fields are null before the first sign-in and after a token refresh
 * failure that requires re-authentication. `needsAttention` is set when a
 * silent token refresh fails and the user must sign in interactively.
 */
export interface AccountRecord {
  id: string;
  tenantId: string;
  /** Entra object ID (oid claim from the ID token). */
  accountId: string;
  displayName: string;
  userPrincipalName: string;
  tenantDomain: string;
  cloud: CloudType;
  photoDataUrl: string | null;
  /** The initial/primary domain of the tenant, resolved via Graph at sign-in. */
  initialDomain: string | null;
  /** Human-readable tenant display name (e.g. "Contoso Corporation"), resolved via Graph at sign-in. */
  tenantDisplayName: string | null;
  /** Non-null when the account requires user interaction to restore access. */
  needsAttention: { reason: string } | null;
  /** Whether to show permanently assigned (non-PIM) roles in the Active Assignments section. Defaults to true when absent. */
  showPermanentAssignments?: boolean;
  loginHost: string | null;
  graphHost: string | null;
  tokenEndpoint: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch milliseconds when the access token expires. */
  tokenExpiresAt: number | null;
  /** Access token scoped to the Azure Management API. Null until first ARM acquisition. */
  armAccessToken: string | null;
  /** Epoch milliseconds when armAccessToken expires. */
  armTokenExpiresAt: number | null;
}

/**
 * A cached Entra role definition. Built-in roles are shared across all tenants
 * and use `tenantId: ''` (empty string). Custom roles are scoped to their tenant.
 */
export interface RoleDefinitionRecord {
  /** Entra role definition GUID (Graph roleDefinitionId). */
  id: string;
  displayName: string;
  isBuiltIn: boolean;
  /** Empty string for built-in roles (shared globally); tenant ID for custom roles. */
  tenantId: string;
}

/** A PIM-eligible Entra role assignment synced from Graph eligibleRoleAssignments. */
export interface RoleRecord {
  /** The Graph eligible role assignment ID (used as the IDB key for dedup). */
  id: string;
  /** Foreign key: AccountRecord.id (local UUID, not the Entra OID). */
  accountId: string;
  /** Foreign key: RoleDefinitionRecord.id */
  roleDefinitionId: string;
  /** Directory scope ID, e.g. "/" for tenant-wide. */
  directoryScopeId: string;
  /** How the eligibility is derived (Graph `memberType`, normalized): Direct, Group, or Inherited. Undefined for records written before this field was added. */
  memberType?: 'Direct' | 'Group' | 'Inherited';
}

/**
 * Cached PIM policy rules for a role definition within a specific tenant.
 * Keyed as `${tenantId}::${roleDefinitionId}` so tenant-customized policies
 * for built-in roles are stored independently across tenants.
 */
export interface RolePolicyRecord {
  /** Composite key: `${tenantId}::${roleDefinitionId}` */
  id: string;
  roleDefinitionId: string;
  tenantId: string;
  /** ISO 8601 duration string, e.g. "PT8H" or "P1D". */
  maximumDuration: string;
  mfaRequired: boolean;
  justificationRequired: boolean;
  ticketingRequired: boolean;
  approvalRequired: boolean;
  /** Whether a Conditional Access authentication context is required for activation. */
  authContextRequired: boolean;
  /** The auth context class reference value required (e.g. "c1"), or null when not required. */
  authContextClassRef: string | null;
  /** Epoch milliseconds when this record was last fetched. Absent on records written before the TTL cache existed (treated as stale). */
  lastSyncedAt?: number;
}

/** A PIM-eligible group assignment synced from Graph privilegedAccess/group/eligibilitySchedules. */
export interface GroupRecord {
  /** Graph eligibility schedule ID (used as IDB key for dedup). */
  id: string;
  /** Foreign key: AccountRecord.id (local UUID). */
  accountId: string;
  /** Entra group object ID. */
  groupId: string;
  /** Group display name resolved from the expand. */
  displayName: string;
  /** Whether the user is eligible as a member or owner of the group. */
  accessId: 'member' | 'owner';
  /** How the eligibility is derived (Graph `memberType`, normalized): Direct or Group. Undefined for records written before this field was added. */
  memberType?: 'Direct' | 'Group' | 'Inherited';
}

/**
 * Cached PIM policy rules for a specific group access level. Keyed as `${tenantId}::${groupId}::${accessId}`.
 * Member and owner access levels for the same group are independent policies.
 */
export interface GroupPolicyRecord {
  /** Composite key: `${tenantId}::${groupId}::${accessId}` */
  id: string;
  groupId: string;
  tenantId: string;
  maximumDuration: string;
  mfaRequired: boolean;
  justificationRequired: boolean;
  ticketingRequired: boolean;
  approvalRequired: boolean;
  /** Whether a Conditional Access authentication context is required for activation. */
  authContextRequired: boolean;
  /** The auth context class reference value required (e.g. "c1"), or null when not required. */
  authContextClassRef: string | null;
  /** Epoch milliseconds when this record was last fetched. Absent on records written before the TTL cache existed (treated as stale). */
  lastSyncedAt?: number;
}

/** Tracks an active role or group activation synced from Graph assignment schedules. */
export interface ActivationRecord {
  id: string;
  accountId: string;
  /** Discriminates role vs. group activations to allow independent clearing during sync. */
  kind: 'role' | 'group';
  /** Entra role definition ID. Present when kind === 'role'. */
  roleDefinitionId?: string;
  /** Directory scope ID from the assignment schedule. Present when kind === 'role'. Required for SelfDeactivate requests to match the original activation scope. */
  directoryScopeId?: string;
  /** Entra group object ID. Present when kind === 'group'. */
  groupId?: string;
  /** Member or owner access. Present when kind === 'group'. */
  accessId?: 'member' | 'owner';
  /** Epoch milliseconds when the activation started. Undefined for records written before this field was added. */
  startedAt?: number;
  /** Epoch milliseconds when the activation expires. 0 means no expiration (permanent). */
  expiresAt: number;
  /** True when the assignment has no expiration (directly assigned, not PIM-activated). */
  isPermanent: boolean;
  /** How the access is held (Graph `memberType`, normalized): Direct, Group, or Inherited. Undefined for records written before this field was added. */
  memberType?: 'Direct' | 'Group' | 'Inherited';
  /** True once the "expiring soon" notification fired for this activation. Reset when the expiry changes. */
  notifiedExpiring?: boolean;
  /** True once the "expired" notification fired for this activation. */
  notifiedExpired?: boolean;
}

/**
 * A PIM approval request where the current user is an approver.
 * Synced from `roleAssignmentScheduleRequests/filterByCurrentUser(on='approver')`.
 *
 * `id` is the Graph `approvalId` and is used when PATCHing the approval step.
 * `requestId` is the `roleAssignmentScheduleRequest.id`, kept for logging.
 */
export interface ApprovalRecord {
  /** Graph approvalId -- used to PATCH the approval step. */
  id: string;
  accountId: string;
  /** The originating roleAssignmentScheduleRequest.id. */
  requestId: string;
  kind: 'role' | 'group';
  /** Entra role definition ID. Present when kind === 'role'. */
  roleDefinitionId?: string;
  /** Entra group object ID. Present when kind === 'group'. */
  groupId?: string;
  /** Member or owner. Present when kind === 'group'. */
  accessId?: 'member' | 'owner';
  /** Resolved display name of the role or group being requested. */
  roleName: string;
  /** Entra OID of the requester. */
  requestorId: string;
  /** Display name of the requester, resolved via $expand=principal. */
  requestorName: string;
  /** Justification the requester provided. */
  requestorJustification: string;
  /** ISO 8601 duration from scheduleInfo.expiration.duration (e.g. "PT4H"). */
  durationRequested: string;
  /** Epoch milliseconds from createdDateTime. */
  requestedAt: number;
}

/**
 * A PIM activation request the current user submitted that is awaiting approval.
 * Synced from `roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')`
 * filtered to `status eq 'PendingApproval'`.
 *
 * `id` is the schedule request ID, used to cancel via the `/cancel` action.
 */
export interface PendingRequestRecord {
  /** Graph roleAssignmentScheduleRequest.id -- used for the cancel action. */
  id: string;
  accountId: string;
  kind: 'role' | 'group';
  /** Entra role definition ID. Present when kind === 'role'. */
  roleDefinitionId?: string;
  /** Entra group object ID. Present when kind === 'group'. */
  groupId?: string;
  /** Member or owner. Present when kind === 'group'. */
  accessId?: 'member' | 'owner';
  /** Resolved display name for the UI. */
  roleName: string;
  /** Epoch milliseconds from createdDateTime. */
  requestedAt: number;
}

/**
 * Ephemeral in-flight state for long-running operations (e.g. sign-in).
 * Written by the service worker so the popup can show loading/error UI
 * without polling or a direct async response.
 */
export interface StateRecord {
  id: string;
  status: 'pending' | 'error';
  startedAt: number;
  accountId?: string;
  error?: string;
}

/**
 * In-flight activation record written to IndexedDB immediately after a successful
 * 201 POST to Graph. Persists across popup close/reopen so the eligible card can
 * show "Activating..." until provisioning is confirmed. Cleaned up by the SW after
 * the poll completes, and by `cleanStaleActivatingRecords` at startup/alarm if the
 * SW was killed mid-poll.
 */
export interface ActivatingRecord {
  /** Graph schedule request ID from the 201 response body. Used for the poll GET. */
  id: string;
  accountId: string;
  kind: 'role' | 'group' | 'azure_role';
  /** UUID of the matching RoleRecord, GroupRecord, or AzureRoleRecord -- popup uses this to match eligible cards. */
  recordId: string;
  /** Display name for logging. */
  displayName: string;
  /** Epoch ms when the activation was submitted. Records past ACTIVATING_STALE_TTL_MS are cleaned up. */
  startedAt: number;
}

/** User-configurable extension preferences stored as a single global record. */
export interface ExtensionSettingsRecord {
  id: 'global';
  showNotifications: boolean;
  notifyMinutesBefore: 5 | 10 | 15 | 30;
  showBadge: boolean;
  reloadPortalsOnActivation: boolean;
  theme: 'dark' | 'light' | 'system';
  /** Whether the service worker persists redacted diagnostic logs to the `logs` store. */
  loggingEnabled: boolean;
  /** Ring-buffer cap for the `logs` store; oldest entries are evicted beyond this. */
  logMaxEntries: number;
}

/**
 * A redacted diagnostic log entry written by the service worker's `log()`
 * helper. Identifiers are masked before the record is created -- nothing
 * sensitive is ever at rest. Read by the popup's Debug panel.
 */
export interface LogRecord {
  /** Auto-incremented key; insertion order doubles as chronological order. */
  id?: number;
  /** Epoch milliseconds when the entry was written. */
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  /** Coarse source area (sync, auth, activate, ...) used for filtering in the Debug panel. */
  category: string;
  message: string;
}

/**
 * An ARM scope that has at least one eligible role assignment for a given account.
 * Only scopes observed in the roleEligibilityScheduleInstances response are stored --
 * never created speculatively.
 */
export interface AzureScopeRecord {
  /** Full ARM resource path, e.g. /subscriptions/{id}/resourceGroups/{rg}. */
  id: string;
  /** FK → AccountRecord.id (local UUID). */
  accountId: string;
  tenantId: string;
  scopeType: 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';
  /** From expandedProperties.scope.displayName. */
  displayName: string;
  /** Always the parent subscription id, used for grouping. */
  subscriptionId: string;
  /** Null for subscription scope; RG path for resource scope. */
  parentScopeId: string | null;
  /** Epoch milliseconds when this record was last written. */
  lastSyncedAt: number;
}

/** A PIM-eligible Azure ARM role assignment synced from roleEligibilityScheduleInstances. */
export interface AzureRoleRecord {
  /** The roleEligibilityScheduleInstance `name` GUID. */
  id: string;
  /** FK → AccountRecord.id (local UUID). */
  accountId: string;
  tenantId: string;
  /** FK → AzureScopeRecord.id. */
  scopeId: string;
  scopeType: 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';
  /** Denormalized for efficient subscription-level queries. */
  subscriptionId: string;
  /** Full ARM path from expandedProperties.roleDefinition.id. */
  roleDefinitionId: string;
  /** From expandedProperties.roleDefinition.displayName. */
  roleDisplayName: string;
  /** True when expandedProperties.roleDefinition.type === 'BuiltInRole'. */
  roleIsBuiltIn: boolean;
  principalId: string;
  principalType: string;
  /** Epoch milliseconds. */
  startDateTime: number;
  /** Epoch milliseconds; 0 if no expiry. */
  endDateTime: number;
  /** How the eligibility is derived (ARM `memberType`, normalized): Direct, Group, or Inherited. Undefined for records written before this field was added. */
  memberType?: 'Direct' | 'Group' | 'Inherited';
  /** Epoch milliseconds when this record was last written. */
  lastSyncedAt: number;
}

/** A currently active Azure ARM role assignment synced from roleAssignmentScheduleInstances. */
export interface AzureActivationRecord {
  /** The roleAssignmentScheduleInstance `name` GUID. */
  id: string;
  /** FK → AccountRecord.id (local UUID). */
  accountId: string;
  tenantId: string;
  /** FK → AzureScopeRecord.id. */
  scopeId: string;
  scopeType: 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';
  /** Denormalized for efficient subscription-level queries. */
  subscriptionId: string;
  roleDefinitionId: string;
  roleDisplayName: string;
  roleIsBuiltIn: boolean;
  principalId: string;
  principalType: string;
  /** Epoch milliseconds when the assignment started. */
  startDateTime: number;
  /** Epoch milliseconds when the assignment expires; 0 if permanent. */
  endDateTime: number;
  isPermanent: boolean;
  /** How the assignment is held (ARM `memberType`, normalized): Direct, Group, or Inherited. Undefined for records written before this field was added. */
  memberType?: 'Direct' | 'Group' | 'Inherited';
  /** Epoch milliseconds when this record was last written. */
  lastSyncedAt: number;
  /** True once the "expiring soon" notification fired for this activation. Reset when the expiry changes. */
  notifiedExpiring?: boolean;
  /** True once the "expired" notification fired for this activation. */
  notifiedExpired?: boolean;
}

/**
 * Cached ARM role management policy rules for a scope+role combination.
 * Mirrors RolePolicyRecord but keyed by ARM scope rather than tenant.
 */
export interface AzurePolicyRecord {
  /** Composite key: `{scopeId}::{roleDefinitionId}`. */
  id: string;
  /** FK → AccountRecord.id (local UUID). */
  accountId: string;
  tenantId: string;
  /** FK → AzureScopeRecord.id. */
  scopeId: string;
  roleDefinitionId: string;
  /** ISO 8601 duration string, e.g. "PT8H". */
  maximumDuration: string;
  mfaRequired: boolean;
  justificationRequired: boolean;
  ticketingRequired: boolean;
  approvalRequired: boolean;
  /** Whether a Conditional Access authentication context is required for activation. */
  authContextRequired: boolean;
  /** The auth context class reference value required (e.g. "c1"), or null when not required. */
  authContextClassRef: string | null;
  /** Epoch milliseconds when this record was last written. */
  lastSyncedAt: number;
}

/**
 * A justification the user chose to save from the activation dialog, offered
 * back as a quick-pick the next time they activate anything on this account.
 *
 * Scoped to the account rather than to a specific role or group: a user's
 * justifications ("Break-glass incident response", "Monthly access review")
 * are reusable across targets, and per-target scoping would leave the picker
 * empty for every role they had not activated before.
 *
 * `text` is user-authored free text and is treated like justification text
 * everywhere else in the codebase: never logged, never included in the Debug
 * panel snapshot, and deleted with the account on sign-out.
 */
export interface JustificationPrefillRecord {
  id: string;
  /** `AccountRecord.id` this prefill belongs to. */
  accountId: string;
  /** The saved justification, trimmed and capped at `MAX_JUSTIFICATION_LENGTH`. */
  text: string;
  /** Epoch milliseconds when the prefill was first saved. */
  createdAt: number;
  /** Epoch milliseconds when it was last saved or reused; drives ordering and eviction. */
  lastUsedAt: number;
}

/** `states` key holding the sync-in-flight marker read by the popup's syncing indicator. */
export const SYNC_STATE_ID = 'sync';

/**
 * A sync-in-flight marker older than this is treated as abandoned. The service
 * worker clears the record on every wake, so this only covers the window
 * between a worker dying mid-sync and the next wake.
 */
export const SYNC_STALE_TTL_MS = 5 * 60 * 1000;

/** Most prefills retained per account. The least recently used is evicted beyond this. */
export const MAX_JUSTIFICATION_PREFILLS = 10;

/** Longest justification stored as a prefill. Longer text still activates; it is just not saved whole. */
export const MAX_JUSTIFICATION_LENGTH = 500;

interface PrivlyDB extends DBSchema {
  justification_prefills: {
    key: string;
    value: JustificationPrefillRecord;
    indexes: {
      'by-account': string;
    };
  };
  accounts: {
    key: string;
    value: AccountRecord;
    indexes: {
      'by-tenant-account': [string, string];
    };
  };
  role_definitions: {
    key: string;
    value: RoleDefinitionRecord;
    indexes: {
      'by-tenant': string;
    };
  };
  role_policies: {
    key: string;
    value: RolePolicyRecord;
    indexes: {
      'by-tenant': string;
    };
  };
  roles: {
    key: string;
    value: RoleRecord;
    indexes: {
      'by-account': string;
    };
  };
  groups: {
    key: string;
    value: GroupRecord;
    indexes: {
      'by-account': string;
    };
  };
  group_policies: {
    key: string;
    value: GroupPolicyRecord;
    indexes: {
      'by-tenant': string;
    };
  };
  activations: {
    key: string;
    value: ActivationRecord;
    indexes: {
      'by-account': string;
    };
  };
  approvals: {
    key: string;
    value: ApprovalRecord;
    indexes: {
      'by-account': string;
    };
  };
  pending_requests: {
    key: string;
    value: PendingRequestRecord;
    indexes: {
      'by-account': string;
    };
  };
  activating: {
    key: string;
    value: ActivatingRecord;
    indexes: {
      'by-account': string;
    };
  };
  extension_settings: {
    key: string;
    value: ExtensionSettingsRecord;
  };
  states: {
    key: string;
    value: StateRecord;
  };
  azure_scopes: {
    key: string;
    value: AzureScopeRecord;
    indexes: {
      'by-account': string;
      'by-subscription': [string, string];
      // IDB skips null values in compound indexes, so subscription-scope records (parentScopeId = null)
      // are simply absent from this index -- query it only for non-null parentScopeId values.
      'by-parent': [string, string];
    };
  };
  azure_roles: {
    key: string;
    value: AzureRoleRecord;
    indexes: {
      'by-account': string;
      'by-scope': [string, string];
      'by-subscription': [string, string];
    };
  };
  azure_activations: {
    key: string;
    value: AzureActivationRecord;
    indexes: {
      'by-account': string;
      'by-scope': [string, string];
      'by-subscription': [string, string];
    };
  };
  azure_policies: {
    key: string;
    value: AzurePolicyRecord;
    indexes: {
      'by-account': string;
    };
  };
  logs: {
    key: number;
    value: LogRecord;
  };
}

// Set when open triggered a schema upgrade; consumed (and logged) by the
// service worker at startup. db.ts cannot log directly (log.ts imports db.ts).
let lastMigration: { from: number; to: number } | null = null;

/** Returns and clears the last schema migration that occurred in this context, if any. */
export function consumeMigrationInfo(): { from: number; to: number } | null {
  const m = lastMigration;
  lastMigration = null;
  return m;
}

let dbPromise: Promise<IDBPDatabase<PrivlyDB>> | null = null;

/**
 * Opens (or creates) the Privly IndexedDB database at the current schema
 * version and returns a typed `idb` handle.
 *
 * The connection is memoized per JS context (service worker wake or popup
 * instance) and reset when the browser closes it. The service worker module
 * re-evaluates on every wake-up, so each resurrection still starts with a
 * fresh connection.
 *
 * Schema migrations are applied incrementally:
 * - v1: core stores (accounts, roles, groups, activations, approvals)
 * - v2: extension_settings store
 * - v3: states store
 * - v4: role_definitions store; expanded RoleRecord shape
 * - v5: role_policies store for cached PIM policy rules
 * - v6: group_policies store; GroupRecord expanded; ActivationRecord gains required `kind` field
 * - v7: ActivationRecord gains optional `directoryScopeId`; activations store cleared
 * - v8: ApprovalRecord expanded with full approval fields; `pending_requests` store added; approvals store cleared
 * - v9: `activating` store added for in-flight activation tracking
 * - v10: `AccountRecord` gains `armAccessToken` and `armTokenExpiresAt` fields
 * - v11: `azure_scopes`, `azure_roles`, `azure_activations`, `azure_policies` stores added for ARM PIM support
 * - v12: `role_policies`, `group_policies`, and `azure_policies` gain `authContextRequired` and `authContextClassRef` fields
 * - v13: `extension_settings` gains a `theme` field, backfilled with 'system'
 * - v14: `AccountRecord` gains `tenantDisplayName` from Graph `/organization` `displayName`
 * - v15: `logs` store added; `extension_settings` gains `loggingEnabled` and `logMaxEntries`
 * - v16: `justification_prefills` store added (saved activation justifications, CS-3)
 * @returns A typed `IDBPDatabase` handle for the Privly database.
 */
export function getDB(): Promise<IDBPDatabase<PrivlyDB>> {
  dbPromise ??= openDBConnection().catch(err => {
    // A failed open must not poison the cache; the next call retries.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function openDBConnection(): Promise<IDBPDatabase<PrivlyDB>> {
  return openDB<PrivlyDB>('privly', 16, {
    blocking() {
      // Another context is upgrading to a newer schema version. Close this
      // connection so the upgrade can proceed; the next getDB() reopens.
      dbPromise?.then(db => db.close()).catch(() => {});
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
    async upgrade(db, oldVersion, newVersion, transaction) {
      lastMigration = { from: oldVersion, to: newVersion ?? 16 };
      if (oldVersion < 1) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
        accounts.createIndex('by-tenant-account', ['tenantId', 'accountId'], { unique: true });

        const roles = db.createObjectStore('roles', { keyPath: 'id' });
        roles.createIndex('by-account', 'accountId');

        const groups = db.createObjectStore('groups', { keyPath: 'id' });
        groups.createIndex('by-account', 'accountId');

        const activations = db.createObjectStore('activations', { keyPath: 'id' });
        activations.createIndex('by-account', 'accountId');

        const approvals = db.createObjectStore('approvals', { keyPath: 'id' });
        approvals.createIndex('by-account', 'accountId');
      }

      if (oldVersion < 2) {
        db.createObjectStore('extension_settings', { keyPath: 'id' });
      }

      if (oldVersion < 3) {
        db.createObjectStore('states', { keyPath: 'id' });
      }

      if (oldVersion < 4) {
        const roleDefs = db.createObjectStore('role_definitions', { keyPath: 'id' });
        roleDefs.createIndex('by-tenant', 'tenantId');
      }

      if (oldVersion < 5) {
        const rolePolicies = db.createObjectStore('role_policies', { keyPath: 'id' });
        rolePolicies.createIndex('by-tenant', 'tenantId');
      }

      if (oldVersion < 6) {
        // GroupRecord gained required fields (groupId, displayName, accessId) -- clear stale data.
        void transaction.objectStore('groups').clear();
        // ActivationRecord gained required `kind` field -- clear so old records don't cause type errors.
        void transaction.objectStore('activations').clear();
        // New group_policies store (parallel to role_policies but scoped per group object).
        const groupPolicies = db.createObjectStore('group_policies', { keyPath: 'id' });
        groupPolicies.createIndex('by-tenant', 'tenantId');
      }

      if (oldVersion < 7) {
        // ActivationRecord gains optional directoryScopeId -- clear stale records without it.
        void transaction.objectStore('activations').clear();
      }

      if (oldVersion < 8) {
        // ApprovalRecord expanded with full fields -- clear stale placeholder records.
        void transaction.objectStore('approvals').clear();
        // New pending_requests store for the current user's own PendingApproval requests.
        const pendingRequests = db.createObjectStore('pending_requests', { keyPath: 'id' });
        pendingRequests.createIndex('by-account', 'accountId');
      }

      if (oldVersion < 9) {
        // New activating store for in-flight activation state (poll-until-provisioned).
        const activating = db.createObjectStore('activating', { keyPath: 'id' });
        activating.createIndex('by-account', 'accountId');
      }

      if (oldVersion < 10) {
        // AccountRecord gains ARM token fields -- patch existing records with null defaults.
        const accountStore = transaction.objectStore('accounts');
        const existingAccounts = await accountStore.getAll();
        for (const account of existingAccounts) {
          await accountStore.put({ ...account, armAccessToken: null, armTokenExpiresAt: null });
        }
      }

      if (oldVersion < 11) {
        // New ARM PIM stores for Azure eligible roles, active assignments, scopes, and policies.
        const azureScopes = db.createObjectStore('azure_scopes', { keyPath: 'id' });
        azureScopes.createIndex('by-account', 'accountId');
        azureScopes.createIndex('by-subscription', ['accountId', 'subscriptionId']);
        azureScopes.createIndex('by-parent', ['accountId', 'parentScopeId']);

        const azureRoles = db.createObjectStore('azure_roles', { keyPath: 'id' });
        azureRoles.createIndex('by-account', 'accountId');
        azureRoles.createIndex('by-scope', ['accountId', 'scopeId']);
        azureRoles.createIndex('by-subscription', ['accountId', 'subscriptionId']);

        const azureActivations = db.createObjectStore('azure_activations', { keyPath: 'id' });
        azureActivations.createIndex('by-account', 'accountId');
        azureActivations.createIndex('by-scope', ['accountId', 'scopeId']);
        azureActivations.createIndex('by-subscription', ['accountId', 'subscriptionId']);

        const azurePolicies = db.createObjectStore('azure_policies', { keyPath: 'id' });
        azurePolicies.createIndex('by-account', 'accountId');
      }

      if (oldVersion < 12) {
        // role_policies, group_policies, and azure_policies gain authContextRequired and authContextClassRef.
        for (const storeName of ['role_policies', 'group_policies', 'azure_policies'] as const) {
          const store = transaction.objectStore(storeName);
          const all = await store.getAll();
          for (const record of all) {
            await store.put({ ...record, authContextRequired: false, authContextClassRef: null });
          }
        }
      }

      if (oldVersion < 13) {
        // extension_settings gains a theme field -- backfill existing record with 'system'.
        const settingsStore = transaction.objectStore('extension_settings');
        const existing = await settingsStore.get('global');
        if (existing) {
          await settingsStore.put({ ...existing, theme: 'system' });
        }
      }

      if (oldVersion < 14) {
        // AccountRecord gains tenantDisplayName -- backfill existing accounts with null.
        const accountStore = transaction.objectStore('accounts');
        const existingAccounts = await accountStore.getAll();
        for (const account of existingAccounts) {
          await accountStore.put({ ...account, tenantDisplayName: null });
        }
      }

      if (oldVersion < 15) {
        // Redacted diagnostic log ring buffer; read by the popup Debug panel.
        db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        // extension_settings gains logging fields -- backfill the existing record.
        const settingsStore = transaction.objectStore('extension_settings');
        const existing = await settingsStore.get('global');
        if (existing) {
          await settingsStore.put({ ...existing, loggingEnabled: existing.loggingEnabled ?? true, logMaxEntries: existing.logMaxEntries ?? 500 });
        }
      }

      if (oldVersion < 16) {
        // Saved activation justifications, offered as quick-picks in the
        // activation dialog. Nothing to backfill -- existing users start empty
        // and populate the list the first time they tick "Save for next time".
        const prefills = db.createObjectStore('justification_prefills', { keyPath: 'id' });
        prefills.createIndex('by-account', 'accountId');
      }
    },
  });
}

/** Store names that carry per-account records via a `by-account` index. */
type AccountScopedStore =
  | 'roles' | 'groups' | 'activations' | 'approvals' | 'pending_requests'
  | 'activating' | 'azure_scopes' | 'azure_roles' | 'azure_activations' | 'azure_policies'
  | 'justification_prefills';

/**
 * Replaces an account's records in a store within a single short transaction:
 * deletes the existing records matching the `by-account` index, then puts the
 * new ones. Sync functions call this after all network I/O completes (MV3
 * rule: never hold a transaction open across a fetch).
 * @param db - Open database handle.
 * @param store - Target store; must declare a `by-account` index.
 * @param accountId - `AccountRecord.id` whose records are replaced.
 * @param records - New records to put.
 * @param shouldDelete - Optional predicate; existing records where it returns false are kept (e.g. preserving group-kind activations during a role sync).
 */
export async function replaceForAccount<S extends AccountScopedStore>(
  db: IDBPDatabase<PrivlyDB>,
  store: S,
  accountId: string,
  records: PrivlyDB[S]['value'][],
  shouldDelete?: (existing: PrivlyDB[S]['value']) => boolean,
): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  // idb's conditional index types do not resolve for a generic store name;
  // every AccountScopedStore declares `by-account: string`, so the casts are safe.
  const existing = await tx.store.index('by-account').getAll(accountId as never) as PrivlyDB[S]['value'][];
  const doomed = shouldDelete ? existing.filter(shouldDelete) : existing;
  await Promise.all([
    ...doomed.map(r => tx.store.delete(r.id as never)),
    ...records.map(r => tx.store.put(r as never)),
  ]);
  await tx.done;
}

/**
 * Returns all ephemeral state records (e.g. in-progress sign-in operations).
 * @returns All records currently in the `states` store.
 */
export async function getStates(): Promise<StateRecord[]> {
  const db = await getDB();
  return db.getAll('states');
}

/** Fallback settings used when no record exists in `extension_settings`. */
export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettingsRecord = {
  id: 'global',
  showNotifications: true,
  notifyMinutesBefore: 5,
  showBadge: true,
  reloadPortalsOnActivation: true,
  theme: 'system',
  loggingEnabled: true,
  logMaxEntries: 500,
};

/**
 * Returns all signed-in accounts in insertion order.
 * @returns All records currently in the `accounts` store.
 */
export async function getAccounts(): Promise<AccountRecord[]> {
  const db = await getDB();
  return db.getAll('accounts');
}

/**
 * Returns the stored extension settings, falling back to
 * `DEFAULT_EXTENSION_SETTINGS` if none have been saved yet.
 * @returns The stored settings record, or the defaults if none exist.
 */
export async function getExtensionSettings(): Promise<ExtensionSettingsRecord> {
  const db = await getDB();
  const record = await db.get('extension_settings', 'global');
  return record ?? DEFAULT_EXTENSION_SETTINGS;
}
