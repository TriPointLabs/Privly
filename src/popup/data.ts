/**
 * Read-only IndexedDB queries for the popup, mapping stored records to the
 * view models in `types/pim.ts`.
 *
 * Pure data access: no Svelte state lives here. MainPage (and other
 * components) call these on mount and on DB_CHANGED notifications. All
 * functions are read-only -- the popup never writes to IndexedDB.
 */
import browser from 'webextension-polyfill';
import {
  getDB,
  getAccounts,
  type AccountRecord,
  type ActivatingRecord,
  type ApprovalRecord,
  type AzurePolicyRecord,
  type AzureRoleRecord,
  type AzureScopeRecord,
  type JustificationPrefillRecord,
  type LogRecord,
  type PendingRequestRecord,
} from '../tools/db.js';
import type {
  AzureScopeKind,
  EligibleRole,
  EligibleGroup,
  ActiveAssignment,
  ActiveRoleAssignment,
  ActiveGroupAssignment,
  ApprovalItem,
  PendingRequest,
} from '../types/pim.js';
import { parseAzureScope } from '../tools/scopeParser.js';
import { formatDuration } from './utils/duration.js';
import { toPolicyRules } from './utils/policy.js';

/**
 * Loads the account's saved activation justifications, most recently used
 * first, which is the order the activation dialog's quick-pick presents them.
 * @param accountId - `AccountRecord.id` to load prefills for.
 */
export async function loadJustificationPrefills(accountId: string): Promise<JustificationPrefillRecord[]> {
  const db = await getDB();
  const prefills = await db.getAllFromIndex('justification_prefills', 'by-account', accountId);
  return prefills.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Loads all accounts plus the persisted active-account selection. */
export async function loadAccounts(): Promise<{ accounts: AccountRecord[]; activeAccountId: string | null }> {
  const [accounts, stored] = await Promise.all([
    getAccounts(),
    browser.storage.local.get('activeAccountId'),
  ]);
  const activeAccountId = (stored['activeAccountId'] as string | undefined) ?? accounts[0]?.id ?? null;
  return { accounts, activeAccountId };
}

/**
 * Loads eligible Entra role assignments for the account, resolving role names
 * from `role_definitions` and policy rules from `role_policies`. Roles with a
 * live active assignment are filtered out.
 */
export async function loadEligibleRoles(account: AccountRecord): Promise<EligibleRole[]> {
  const db = await getDB();
  const [roleRecords, activationRecords] = await Promise.all([
    db.getAllFromIndex('roles', 'by-account', account.id),
    db.getAllFromIndex('activations', 'by-account', account.id),
  ]);
  // Hide eligible roles that already have an active, non-expired role assignment.
  const now = Date.now();
  const activeRoleDefIds = new Set(
    activationRecords.filter(a => a.kind !== 'group' && (a.expiresAt === 0 || a.expiresAt > now)).map(a => a.roleDefinitionId!)
  );
  const eligible = roleRecords.filter(r => !activeRoleDefIds.has(r.roleDefinitionId));
  const [defs, policies] = await Promise.all([
    Promise.all(eligible.map(r => db.get('role_definitions', r.roleDefinitionId))),
    Promise.all(eligible.map(r => db.get('role_policies', `${account.tenantId}::${r.roleDefinitionId}`))),
  ]);
  return eligible.map((r, i) => ({
    id: r.id,
    roleName: defs[i]?.displayName ?? r.roleDefinitionId,
    isBuiltIn: defs[i]?.isBuiltIn ?? false,
    roleType: 'EntraRole' as const,
    memberType: r.memberType,
    policyRules: toPolicyRules(policies[i]),
  }));
}

/**
 * Loads active role, group, and Azure assignments for the account, resolving
 * display names and policy rules. Locally-expired records are excluded so they
 * disappear without waiting for the next server sync.
 */
export async function loadActiveAssignments(account: AccountRecord): Promise<ActiveAssignment[]> {
  const db = await getDB();
  const [activationRecords, allGroupRecords, azureActivationRecords, azureScopeRecords] = await Promise.all([
    db.getAllFromIndex('activations', 'by-account', account.id),
    db.getAllFromIndex('groups', 'by-account', account.id),
    db.getAllFromIndex('azure_activations', 'by-account', account.id),
    db.getAllFromIndex('azure_scopes', 'by-account', account.id),
  ]);

  const now = Date.now();
  const liveRecords = activationRecords.filter(a => a.expiresAt === 0 || a.expiresAt > now);
  const roleActivations = liveRecords.filter(a => a.kind !== 'group');
  const groupActivations = liveRecords.filter(a => a.kind === 'group');
  // groupId → GroupRecord for display name lookups without additional fetches.
  const groupByGroupId = new Map(allGroupRecords.map(g => [g.groupId, g]));

  const [roleDefs, rolePolicies, groupPolicies] = await Promise.all([
    Promise.all(roleActivations.map(a => db.get('role_definitions', a.roleDefinitionId!))),
    Promise.all(roleActivations.map(a => db.get('role_policies', `${account.tenantId}::${a.roleDefinitionId!}`))),
    Promise.all(groupActivations.map(a => db.get('group_policies', `${account.tenantId}::${a.groupId!}::${a.accessId!}`))),
  ]);

  const roleAssignments: ActiveRoleAssignment[] = roleActivations.map((a, i) => ({
    id: a.id,
    roleName: roleDefs[i]?.displayName ?? a.roleDefinitionId!,
    isBuiltIn: roleDefs[i]?.isBuiltIn ?? false,
    roleType: 'EntraRole' as const,
    isPermanent: a.isPermanent,
    memberType: a.memberType,
    startedAt: a.startedAt != null ? new Date(a.startedAt) : undefined,
    expiresAt: a.expiresAt > 0 ? new Date(a.expiresAt) : new Date(8640000000000000),
    policyRules: toPolicyRules(rolePolicies[i]),
  }));

  const groupAssignments: ActiveGroupAssignment[] = groupActivations.map((a, i) => ({
    id: a.id,
    groupName: groupByGroupId.get(a.groupId!)?.displayName ?? a.groupId!,
    accessId: a.accessId!,
    includedRoles: [],
    memberType: a.memberType,
    startedAt: a.startedAt != null ? new Date(a.startedAt) : undefined,
    expiresAt: a.expiresAt > 0 ? new Date(a.expiresAt) : new Date(8640000000000000),
    policyRules: toPolicyRules(groupPolicies[i]),
  }));

  // Azure ARM active assignments -- map to ActiveRoleAssignment with roleType 'AzureRole' and a parsed scope.
  const scopeNameMap = new Map(azureScopeRecords.map(s => [s.id, s.displayName]));
  const liveAzure = azureActivationRecords.filter(a => a.isPermanent || a.endDateTime === 0 || a.endDateTime > now);
  const azurePolicies = await Promise.all(
    liveAzure.map(a => db.get('azure_policies', `${a.scopeId}::${a.roleDefinitionId}`))
  );
  const azureAssignments: ActiveRoleAssignment[] = liveAzure.map((a, i) => ({
    id: a.id,
    roleName: a.roleDisplayName,
    isBuiltIn: a.roleIsBuiltIn,
    roleType: 'AzureRole' as const,
    isPermanent: a.isPermanent,
    memberType: a.memberType,
    scope: parseAzureScope(a.scopeId, scopeNameMap.get(a.scopeId) ?? a.scopeId),
    startedAt: a.startDateTime > 0 ? new Date(a.startDateTime) : undefined,
    expiresAt: a.endDateTime > 0 ? new Date(a.endDateTime) : new Date(8640000000000000),
    policyRules: toPolicyRules(azurePolicies[i]),
  }));

  return [...roleAssignments, ...groupAssignments, ...azureAssignments];
}

/**
 * Loads eligible group assignments for the account, resolving group policy
 * rules. Groups with a live active assignment (per accessId) are filtered out.
 */
export async function loadEligibleGroups(account: AccountRecord): Promise<EligibleGroup[]> {
  const db = await getDB();
  const [groupRecords, activationRecords] = await Promise.all([
    db.getAllFromIndex('groups', 'by-account', account.id),
    db.getAllFromIndex('activations', 'by-account', account.id),
  ]);
  // Key by `groupId::accessId` so member and owner eligibility are tracked independently. Exclude expired records.
  const now = Date.now();
  const activeGroupKeys = new Set(
    activationRecords.filter(a => a.kind === 'group' && (a.expiresAt === 0 || a.expiresAt > now)).map(a => `${a.groupId!}::${a.accessId!}`)
  );
  const eligible = groupRecords.filter(r => !activeGroupKeys.has(`${r.groupId}::${r.accessId}`));
  const policies = await Promise.all(
    eligible.map(r => db.get('group_policies', `${account.tenantId}::${r.groupId}::${r.accessId}`))
  );
  return eligible.map((r, i) => ({
    id: r.id,
    groupName: r.displayName,
    accessId: r.accessId,
    includedRoles: [],
    memberType: r.memberType,
    policyRules: toPolicyRules(policies[i]),
  }));
}

/** Loads pending approval records where the user is the approver. */
export async function loadApprovals(accountId: string): Promise<ApprovalItem[]> {
  const db = await getDB();
  const records: ApprovalRecord[] = await db.getAllFromIndex('approvals', 'by-account', accountId);
  return records.map(r => ({
    id: r.id,
    roleName: r.roleName,
    requestorName: r.requestorName,
    requestorJustification: r.requestorJustification,
    durationRequested: r.durationRequested,
    requestedAt: new Date(r.requestedAt),
  }));
}

/** Loads the user's own pending activation requests. */
export async function loadPendingRequests(accountId: string): Promise<PendingRequest[]> {
  const db = await getDB();
  const records: PendingRequestRecord[] = await db.getAllFromIndex('pending_requests', 'by-account', accountId);
  return records.map(r => ({
    id: r.id,
    kind: r.kind,
    roleName: r.roleName,
  }));
}

/**
 * Loads in-flight activating records, excluding stale ones (older than 2
 * minutes, matching the service worker's ACTIVATING_STALE_TTL_MS).
 */
export async function loadActivating(accountId: string): Promise<ActivatingRecord[]> {
  const db = await getDB();
  const records: ActivatingRecord[] = await db.getAllFromIndex('activating', 'by-account', accountId);
  const cutoff = Date.now() - 2 * 60 * 1000;
  return records.filter(r => r.startedAt > cutoff);
}

/** Summary row for a subscription or management group in the Azure subsection. */
export interface AzureSubscriptionGroup {
  scopeId: string;
  subscriptionId: string;
  displayName: string;
  eligibleCount: number;
  hasDeepScopes: boolean;
  isManagementGroup: boolean;
}

/**
 * Loads Azure ARM eligible roles, filters out those with a live activation on
 * the same (scopeId, roleDefinitionId) pair, and groups the remainder by
 * top-level scope (subscription path or management group path).
 */
export async function loadAzureSubscriptionGroups(accountId: string): Promise<AzureSubscriptionGroup[]> {
  const db = await getDB();
  const [roleRecords, activationRecords, allScopes] = await Promise.all([
    db.getAllFromIndex('azure_roles', 'by-account', accountId),
    db.getAllFromIndex('azure_activations', 'by-account', accountId),
    db.getAllFromIndex('azure_scopes', 'by-account', accountId),
  ]);
  if (roleRecords.length === 0) return [];

  // Filter out roles that have a live active activation on the same (scopeId, roleDefinitionId) pair.
  const now = Date.now();
  const activeKeys = new Set(
    activationRecords
      .filter(a => a.isPermanent || a.endDateTime === 0 || a.endDateTime > now)
      .map(a => `${a.scopeId}::${a.roleDefinitionId}`)
  );
  const eligible = roleRecords.filter(r => !activeKeys.has(`${r.scopeId}::${r.roleDefinitionId}`));

  // Build a map from scope ID to display name for label resolution.
  const scopeNameMap = new Map(allScopes.map(s => [s.id, s.displayName]));

  // Group by top-level scope: management groups form their own group; everything else
  // is bucketed by subscription path (/subscriptions/{id}).
  const groupMap = new Map<string, AzureSubscriptionGroup>();
  for (const role of eligible) {
    const isMG = role.scopeType === 'managementGroup';
    const groupKey = isMG ? role.scopeId : `/subscriptions/${role.subscriptionId}`;
    const isDeepScope = role.scopeType === 'resourceGroup' || role.scopeType === 'resource';

    let existing = groupMap.get(groupKey);
    if (!existing) {
      const displayName = isMG
        ? (scopeNameMap.get(role.scopeId) ?? role.scopeId)
        : (scopeNameMap.get(groupKey) ?? role.subscriptionId);
      existing = { scopeId: groupKey, subscriptionId: role.subscriptionId, displayName, eligibleCount: 0, hasDeepScopes: false, isManagementGroup: isMG };
      groupMap.set(groupKey, existing);
    }
    existing.eligibleCount++;
    if (isDeepScope) existing.hasDeepScopes = true;
  }

  return [...groupMap.values()];
}

/**
 * Loads the eligible Azure roles, scope metadata, and cached policies for one
 * top-level scope (a subscription or a management group). Uses the `by-scope`
 * and `by-subscription` compound indexes so only the relevant records are read
 * instead of scanning every Azure record for the account.
 */
export async function loadAzureScopeDetail(
  accountId: string,
  scopeId: string,
  isManagementGroup: boolean,
): Promise<{
  eligible: AzureRoleRecord[];
  scopeNameMap: Map<string, string>;
  scopeTypeMap: Map<string, AzureScopeKind>;
  policies: Map<string, AzurePolicyRecord>;
}> {
  const db = await getDB();
  const subscriptionId = isManagementGroup ? null : (/^\/subscriptions\/([^/]+)$/i.exec(scopeId)?.[1] ?? null);
  const useScopeIndex = isManagementGroup || !subscriptionId;

  const [roleRecords, activationRecords, scopes] = await Promise.all([
    useScopeIndex
      ? db.getAllFromIndex('azure_roles', 'by-scope', [accountId, scopeId])
      : db.getAllFromIndex('azure_roles', 'by-subscription', [accountId, subscriptionId!]),
    useScopeIndex
      ? db.getAllFromIndex('azure_activations', 'by-scope', [accountId, scopeId])
      : db.getAllFromIndex('azure_activations', 'by-subscription', [accountId, subscriptionId!]),
    useScopeIndex
      ? db.get('azure_scopes', scopeId).then(s => (s ? [s] : []))
      : db.getAllFromIndex('azure_scopes', 'by-subscription', [accountId, subscriptionId!]),
  ]);

  // Exclude roles with a live active activation on the same (scopeId, roleDefinitionId) pair.
  const now = Date.now();
  const activeKeys = new Set(
    activationRecords
      .filter(a => a.isPermanent || a.endDateTime === 0 || a.endDateTime > now)
      .map(a => `${a.scopeId}::${a.roleDefinitionId}`)
  );
  const eligible = roleRecords.filter(r => !activeKeys.has(`${r.scopeId}::${r.roleDefinitionId}`));

  const policyRecords = await Promise.all(
    eligible.map(r => db.get('azure_policies', `${r.scopeId}::${r.roleDefinitionId}`))
  );
  const policies = new Map<string, AzurePolicyRecord>();
  eligible.forEach((r, i) => {
    const p = policyRecords[i];
    if (p) policies.set(`${r.scopeId}::${r.roleDefinitionId}`, p);
  });

  return {
    eligible,
    scopeNameMap: new Map(scopes.map(s => [s.id, s.displayName])),
    scopeTypeMap: new Map(scopes.map(s => [s.id, s.scopeType])),
    policies,
  };
}

/** Loads the diagnostic log newest-first. Entries were redacted at write time. */
export async function loadLogs(): Promise<LogRecord[]> {
  const db = await getDB();
  const logs = await db.getAll('logs');
  return logs.reverse();
}

/** Current-state summary shown in the Settings Debug panel. */
export interface DebugSnapshot {
  extensionVersion: string;
  dbVersion: number;
  logCount: number;
  alarms: { name: string; scheduledTime: number }[];
  /** Timestamp of the newest "Sync cycle complete" log entry, or null. */
  lastSyncAt: number | null;
  accounts: {
    label: string;
    graphTokenExpiresAt: number | null;
    armTokenExpiresAt: number | null;
    counts: Record<string, number>;
  }[];
}

const SNAPSHOT_STORES = [
  'roles', 'groups', 'activations', 'approvals', 'pending_requests',
  'azure_scopes', 'azure_roles', 'azure_activations', 'azure_policies',
] as const;

/** Computes the Debug panel's state snapshot: store counts, token expiries, and alarms. */
export async function loadDebugSnapshot(): Promise<DebugSnapshot> {
  const db = await getDB();
  const [accounts, alarms, logCount, logs] = await Promise.all([
    db.getAll('accounts'),
    browser.alarms.getAll(),
    db.count('logs'),
    db.getAll('logs'),
  ]);
  const lastSync = [...logs].reverse().find(l => l.message === 'Sync cycle complete');

  const accountRows = await Promise.all(accounts.map(async (a) => {
    const counts: Record<string, number> = {};
    await Promise.all(SNAPSHOT_STORES.map(async s => {
      counts[s] = await db.countFromIndex(s, 'by-account' as never, a.id as never);
    }));
    return {
      label: a.displayName,
      graphTokenExpiresAt: a.tokenExpiresAt,
      armTokenExpiresAt: a.armTokenExpiresAt,
      counts,
    };
  }));

  return {
    extensionVersion: browser.runtime.getManifest().version,
    dbVersion: db.version,
    logCount,
    alarms: alarms.map(al => ({ name: al.name, scheduledTime: al.scheduledTime })),
    lastSyncAt: lastSync?.timestamp ?? null,
    accounts: accountRows,
  };
}

// ---------------------------------------------------------------------------
// Entitlement map (Debug panel)
// ---------------------------------------------------------------------------

/** One row in the Debug panel's entitlement tree. */
export interface EntitlementNode {
  label: string;
  /** Policy summary, activation status, or diagnostic note. */
  detail: string;
  /** Drives row styling; 'missing-policy' is the diagnostic the tree exists to expose. */
  status: 'ok' | 'missing-policy' | 'active' | 'scope';
  children?: EntitlementNode[];
}

/** Entitlement tree for one signed-in account. */
export interface AccountEntitlements {
  accountLabel: string;
  sections: EntitlementNode[];
}

/** Short relative age like "2h ago" for policy freshness display. */
function ageLabel(ts: number | undefined): string {
  if (!ts) return 'age unknown';
  const abs = Date.now() - ts;
  if (abs >= 3_600_000) return `${Math.round(abs / 3_600_000)}h ago`;
  if (abs >= 60_000) return `${Math.round(abs / 60_000)}m ago`;
  return 'just now';
}

/**
 * Summarizes a cached policy for a tree row. A missing record is the key
 * diagnostic: the UI silently falls back to defaults in that case, and this
 * is the only place that fallback is made visible.
 */
function policyDetail(p: { maximumDuration: string; mfaRequired: boolean; justificationRequired: boolean; ticketingRequired: boolean; approvalRequired: boolean; lastSyncedAt?: number } | undefined): { detail: string; status: 'ok' | 'missing-policy' } {
  if (!p) return { detail: 'NO CACHED POLICY (UI shows defaults)', status: 'missing-policy' };
  const parts = [`${formatDuration(p.maximumDuration)} max`];
  if (p.mfaRequired) parts.push('MFA');
  if (p.justificationRequired) parts.push('justification');
  if (p.ticketingRequired) parts.push('ticket');
  if (p.approvalRequired) parts.push('approval');
  return { detail: `${parts.join(' \u00b7 ')} \u00b7 policy ${ageLabel(p.lastSyncedAt)}`, status: 'ok' };
}

function activeUntil(expiresAt: number, isPermanent: boolean | undefined): string {
  if (isPermanent) return 'permanent';
  if (expiresAt <= 0) return 'no expiry';
  return `active until ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const SCOPE_TYPE_LABELS: Record<AzureScopeRecord['scopeType'], string> = {
  managementGroup: 'MG',
  subscription: 'Sub',
  resourceGroup: 'RG',
  resource: 'Res',
};

/** Recursively builds one Azure scope node: roles at this scope, then child scopes via the by-parent index. */
async function buildAzureScopeNode(
  db: Awaited<ReturnType<typeof getDB>>,
  accountId: string,
  scope: AzureScopeRecord,
): Promise<EntitlementNode | null> {
  const [roles, activations, childScopes] = await Promise.all([
    db.getAllFromIndex('azure_roles', 'by-scope', [accountId, scope.id]),
    db.getAllFromIndex('azure_activations', 'by-scope', [accountId, scope.id]),
    db.getAllFromIndex('azure_scopes', 'by-parent', [accountId, scope.id]),
  ]);
  const now = Date.now();
  const liveActs = activations.filter(a => a.isPermanent || a.endDateTime === 0 || a.endDateTime > now);

  const roleNodes: EntitlementNode[] = await Promise.all(roles.map(async r => {
    const policy = await db.get('azure_policies', `${r.scopeId}::${r.roleDefinitionId}`);
    const p = policyDetail(policy);
    const act = liveActs.find(a => a.roleDefinitionId === r.roleDefinitionId);
    return {
      label: r.roleDisplayName,
      detail: act ? `${activeUntil(act.endDateTime, act.isPermanent)} \u00b7 ${p.detail}` : p.detail,
      status: act ? 'active' as const : p.status,
    };
  }));

  // Active-only assignments (e.g. permanent) with no eligible record still deserve a row.
  const eligibleDefIds = new Set(roles.map(r => r.roleDefinitionId));
  for (const act of liveActs) {
    if (!eligibleDefIds.has(act.roleDefinitionId)) {
      roleNodes.push({ label: act.roleDisplayName, detail: activeUntil(act.endDateTime, act.isPermanent), status: 'active' });
    }
  }

  const childNodes = (await Promise.all(childScopes.map(c => buildAzureScopeNode(db, accountId, c))))
    .filter((n): n is EntitlementNode => n !== null);

  // Prune scope nodes that carry nothing (e.g. subscriptions synthesized only for name resolution).
  if (roleNodes.length === 0 && childNodes.length === 0) return null;
  return {
    label: `${SCOPE_TYPE_LABELS[scope.scopeType]}: ${scope.displayName}`,
    detail: '',
    status: 'scope',
    children: [...roleNodes, ...childNodes],
  };
}

/**
 * Builds the Debug panel's entitlement map for every signed-in account:
 * Entra roles, groups, and the Azure scope hierarchy, each entity annotated
 * with its cached policy (or the lack of one) and live activation state.
 */
export async function loadEntitlementTree(): Promise<AccountEntitlements[]> {
  const db = await getDB();
  const accounts = await getAccounts();
  const now = Date.now();

  return Promise.all(accounts.map(async (account) => {
    const [roles, groups, activations, rootScopes] = await Promise.all([
      db.getAllFromIndex('roles', 'by-account', account.id),
      db.getAllFromIndex('groups', 'by-account', account.id),
      db.getAllFromIndex('activations', 'by-account', account.id),
      db.getAllFromIndex('azure_scopes', 'by-account', account.id).then(all => all.filter(s => s.parentScopeId === null)),
    ]);
    const liveActs = activations.filter(a => a.expiresAt === 0 || a.expiresAt > now);

    // Entra roles: eligible plus role-kind activations.
    const roleNodes: EntitlementNode[] = await Promise.all(roles.map(async r => {
      const [def, policy] = await Promise.all([
        db.get('role_definitions', r.roleDefinitionId),
        db.get('role_policies', `${account.tenantId}::${r.roleDefinitionId}`),
      ]);
      const p = policyDetail(policy);
      const act = liveActs.find(a => a.kind !== 'group' && a.roleDefinitionId === r.roleDefinitionId);
      return {
        label: def?.displayName ?? r.roleDefinitionId,
        detail: act ? `${activeUntil(act.expiresAt, act.isPermanent)} \u00b7 ${p.detail}` : p.detail,
        status: act ? 'active' as const : p.status,
      };
    }));
    const eligibleDefIds = new Set(roles.map(r => r.roleDefinitionId));
    for (const act of liveActs) {
      if (act.kind !== 'group' && act.roleDefinitionId && !eligibleDefIds.has(act.roleDefinitionId)) {
        const def = await db.get('role_definitions', act.roleDefinitionId);
        roleNodes.push({ label: def?.displayName ?? act.roleDefinitionId, detail: activeUntil(act.expiresAt, act.isPermanent), status: 'active' });
      }
    }

    // Groups: member/owner eligibility each carry their own policy.
    const groupNodes: EntitlementNode[] = await Promise.all(groups.map(async g => {
      const policy = await db.get('group_policies', `${account.tenantId}::${g.groupId}::${g.accessId}`);
      const p = policyDetail(policy);
      const act = liveActs.find(a => a.kind === 'group' && a.groupId === g.groupId && a.accessId === g.accessId);
      return {
        label: `${g.displayName} (${g.accessId})`,
        detail: act ? `${activeUntil(act.expiresAt, act.isPermanent)} \u00b7 ${p.detail}` : p.detail,
        status: act ? 'active' as const : p.status,
      };
    }));

    const azureNodes = (await Promise.all(rootScopes.map(s => buildAzureScopeNode(db, account.id, s))))
      .filter((n): n is EntitlementNode => n !== null);

    const sections: EntitlementNode[] = [];
    if (roleNodes.length > 0) sections.push({ label: 'Entra roles', detail: '', status: 'scope', children: roleNodes });
    if (groupNodes.length > 0) sections.push({ label: 'Groups', detail: '', status: 'scope', children: groupNodes });
    if (azureNodes.length > 0) sections.push({ label: 'Azure', detail: '', status: 'scope', children: azureNodes });

    return { accountLabel: account.displayName, sections };
  }));
}

