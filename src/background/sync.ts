/**
 * PIM data synchronization functions.
 *
 * Fetches eligible/active role and group assignments, policy rules, pending
 * approvals, and pending requests from Microsoft Graph and writes them to
 * IndexedDB. All functions follow the MV3 rule: network I/O completes before
 * any write transaction opens.
 *
 * Also owns `cleanStaleActivatingRecords`, which recovers from a service worker
 * being killed mid-poll by pruning orphaned activating records and re-syncing
 * the affected accounts.
 */
import browser from 'webextension-polyfill';
import {
  getDB,
  replaceForAccount,
  type AccountRecord,
  type RoleRecord,
  type RoleDefinitionRecord,
  type RolePolicyRecord,
  type ActivationRecord,
  type GroupRecord,
  type GroupPolicyRecord,
  type ApprovalRecord,
  type PendingRequestRecord,
  type AzureScopeRecord,
  type AzureRoleRecord,
  type AzureActivationRecord,
  type AzurePolicyRecord,
  SYNC_STATE_ID,
} from '../tools/db.ts';
import { getArmHost } from '../tools/oauth.ts';
import { notify } from '../tools/notify.ts';
import { normalizeMemberType } from '../tools/membership.ts';
import type { PolicyRules } from '../types/pim.ts';
import {
  withConcurrency,
  fetchWithRetry,
  fetchAllPages,
  parsePolicyRules,
  notifyDbChanged,
  ACTIVATING_STALE_TTL_MS,
  type RawPolicyRule,
} from './utils.ts';
import { reconcilePendingApprovalAlarm, updateBadge } from './badge.ts';
import { refreshAccountTokens, refreshArmToken, fetchTenantInfo } from './auth.ts';
import { sendNotification } from '../types/messages.ts';
import { log, maskUpn } from './log.ts';
import { checkExpiries } from './expiry.ts';

/**
 * Policies rarely change, so cached policy records fresher than this are not
 * refetched during the periodic sync cycle. A manual refresh (TRIGGER_SYNC)
 * bypasses the TTL, and a policy validation failure during activation forces a
 * targeted refetch via the refreshSingle*Policy helpers.
 */
const POLICY_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Resolves role definition display names and group display names from the
 * IndexedDB cache for a given account. Used by both pending-approval and
 * pending-request sync functions to avoid duplicating the map-building logic.
 *
 * @param db - Open IndexedDB connection for reading cached definitions.
 * @param roleDefIds - Unique role definition IDs to look up.
 * @param accountId - Local UUID of the account; used to query the groups index.
 * @returns Maps from roleDefinitionId to display name, and from groupId to display name.
 */
async function resolveDisplayNames(
  db: Awaited<ReturnType<typeof getDB>>,
  roleDefIds: string[],
  accountId: string,
): Promise<{ roleDefMap: Map<string, string>; groupNameMap: Map<string, string> }> {
  const roleDefMap = new Map<string, string>();
  await Promise.all(roleDefIds.map(async id => {
    const def = await db.get('role_definitions', id);
    if (def) roleDefMap.set(id, def.displayName);
  }));
  const groupRecords = await db.getAllFromIndex('groups', 'by-account', accountId);
  const groupNameMap = new Map(groupRecords.map(g => [g.groupId, g.displayName]));
  return { roleDefMap, groupNameMap };
}


/**
 * Shared two-step policy fetch used by Entra role, group, and Azure policy
 * sync: resolve each pair's roleManagementPolicyAssignment to a policyId (max
 * 5 concurrent), then fetch rules once per unique policyId -- pairs often
 * share a policy. Returns parsed rules keyed by the original pair; pairs whose
 * assignment or rules fetch failed are absent from the result.
 */
async function fetchPolicyRulesForPairs<K>(opts: {
  pairs: K[];
  headers: Record<string, string>;
  /** Redaction-safe label for a pair, used in log lines. */
  label: (pair: K) => string;
  /** URL of the roleManagementPolicyAssignments query for a pair. */
  assignmentUrl: (pair: K) => string;
  /** Extracts the policyId from one assignment item (Graph: flat `policyId`; ARM: under `properties`). */
  policyIdOf: (item: { policyId?: string; properties?: { policyId?: string } }) => string | undefined;
  /** Fetches and parses the rules for one policyId; null on failure. */
  fetchRules: (policyId: string) => Promise<PolicyRules | null>;
  logPrefix: string;
}): Promise<Map<K, PolicyRules>> {
  const { pairs, headers, label, assignmentUrl, policyIdOf, fetchRules, logPrefix } = opts;

  const policyIdByPair = new Map<K, string>();
  await withConcurrency(pairs, 5, async (pair) => {
    const res = await fetchAllPages<{ policyId?: string; properties?: { policyId?: string } }>(assignmentUrl(pair), { headers });
    if (!res.ok) {
      log('warn', 'sync', `${logPrefix}: policy assignment fetch failed for ${label(pair)}: HTTP ${res.status} ${res.body}`);
      return;
    }
    const policyId = res.items[0] ? policyIdOf(res.items[0]) : undefined;
    if (policyId) {
      policyIdByPair.set(pair, policyId);
      log('info', 'sync', `${logPrefix}: policy matched ${label(pair)} -> ${policyId}`);
    } else {
      log('warn', 'sync', `${logPrefix}: no policy assignment found for ${label(pair)}`);
    }
  });

  const uniquePolicyIds = [...new Set(policyIdByPair.values())];
  const rulesByPolicyId = new Map<string, PolicyRules>();
  await Promise.all(uniquePolicyIds.map(async (policyId) => {
    const rules = await fetchRules(policyId);
    if (rules) {
      rulesByPolicyId.set(policyId, rules);
      log('info', 'sync', `${logPrefix}: policy ${policyId}: maxDuration=${rules.maximumDuration} mfa=${rules.mfaRequired} justification=${rules.justificationRequired} ticketing=${rules.ticketingRequired} approval=${rules.approvalRequired}`);
    }
  }));

  const result = new Map<K, PolicyRules>();
  for (const [pair, policyId] of policyIdByPair) {
    const rules = rulesByPolicyId.get(policyId);
    if (rules) result.set(pair, rules);
  }
  return result;
}

/** Returns a rules fetcher for Graph `roleManagementPolicies/{id}/rules`; logs and returns null on failure. */
function graphPolicyRulesFetcher(graphHost: string, headers: Record<string, string>): (policyId: string) => Promise<PolicyRules | null> {
  return async (policyId) => {
    const res = await fetchAllPages<RawPolicyRule>(`${graphHost}/v1.0/policies/roleManagementPolicies/${policyId}/rules`, { headers });
    if (!res.ok) {
      log('warn', 'sync', `Policy rules fetch failed for policyId ${policyId}: HTTP ${res.status}`);
      return null;
    }
    return parsePolicyRules(res.items);
  };
}

/**
 * Fetches PIM role management policy rules for the given role definition IDs
 * and upserts them into the `role_policies` store.
 *
 * `policyQueryIds` maps each roleDefinitionId to the ID that should be used
 * in the `roleManagementPolicyAssignments` filter. For built-in roles this is
 * the same as the roleDefinitionId; for custom roles it is the canonical ID
 * returned by `GET /roleManagement/directory/roleDefinitions/{id}`.
 *
 * `scopeMap` maps each roleDefinitionId to its `directoryScopeId` from the
 * eligibility schedule. For tenant-wide roles this is always `/`, but for
 * RMAU-scoped roles it is the administrative unit resource path. Using the
 * actual scope is required for RMAU policy lookups to return results.
 *
 * @param account - Authenticated account for Graph requests.
 * @param roleDefinitionIds - IDs of roles whose policies should be fetched.
 * @param roleNames - Map from roleDefinitionId to display name, used for logging.
 * @param policyQueryIds - Map from roleDefinitionId to the ID to use in the policy filter.
 * @param scopeMap - Map from roleDefinitionId to directoryScopeId.
 */
async function syncPolicyRules(
  account: AccountRecord,
  roleDefinitionIds: string[],
  roleNames: Map<string, string>,
  policyQueryIds: Map<string, string>,
  scopeMap: Map<string, string>,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  if (roleDefinitionIds.length === 0) return;

  // TTL: skip roles whose cached policy is still fresh unless forced.
  if (!force) {
    const cacheDb = await getDB();
    const cutoff = Date.now() - POLICY_TTL_MS;
    const cached = await Promise.all(roleDefinitionIds.map(id => cacheDb.get('role_policies', `${account.tenantId}::${id}`)));
    const stale = roleDefinitionIds.filter((_, i) => (cached[i]?.lastSyncedAt ?? 0) < cutoff);
    if (stale.length < roleDefinitionIds.length) {
      log('info', 'sync', `Skipping ${roleDefinitionIds.length - stale.length} fresh role policy/policies (TTL)`);
    }
    roleDefinitionIds = stale;
    if (roleDefinitionIds.length === 0) return;
  }

  // scopeType eq 'DirectoryRole' is required -- omitting it causes a MissingProvider 400.
  // The roleDefinitionId value in the filter must be the canonical ID from policyQueryIds.
  // scopeId comes from the eligibility schedule's directoryScopeId (not hardcoded to '/').
  log('info', 'sync', `Fetching ${roleDefinitionIds.length} policy assignment(s) for ${maskUpn(account.userPrincipalName)}`);
  const headers = { Authorization: `Bearer ${account.accessToken!}` };
  const rulesByRole = await fetchPolicyRulesForPairs({
    pairs: roleDefinitionIds,
    headers,
    label: (id) => `"${roleNames.get(id) ?? id}"`,
    assignmentUrl: (id) => {
      const queryId = policyQueryIds.get(id) ?? id;
      const scopeId = scopeMap.get(id) ?? '/';
      return `${account.graphHost}/v1.0/policies/roleManagementPolicyAssignments` +
        `?$filter=scopeId eq '${scopeId}' and scopeType eq 'DirectoryRole' and roleDefinitionId eq '${queryId}'` +
        `&$select=id,policyId,roleDefinitionId`;
    },
    policyIdOf: item => item.policyId,
    fetchRules: graphPolicyRulesFetcher(account.graphHost!, headers),
    logPrefix: 'Role',
  });

  // All network I/O complete -- build records and write.
  const policyRecords: RolePolicyRecord[] = [...rulesByRole].map(([roleDefinitionId, parsed]) => ({
    id: `${account.tenantId}::${roleDefinitionId}`,
    roleDefinitionId,
    tenantId: account.tenantId,
    ...parsed,
    lastSyncedAt: Date.now(),
  }));

  const db = await getDB();
  const tx = db.transaction('role_policies', 'readwrite');
  await Promise.all(policyRecords.map(r => tx.store.put(r)));
  await tx.done;

  log('info', 'sync', `Stored ${policyRecords.length} policy rule set(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('role_policies');
}

/**
 * Fetches PIM approval requests where the current user is an approver (both role
 * and group kinds). Replaces all existing approval records for this account in
 * the `approvals` store.
 *
 * Uses `filterByCurrentUser(on='approver')` so Graph server-filters to only
 * requests where this user is a designated approver.
 *
 * The `approvalId` field on each request is stored as the record `id` -- it is
 * the key used when PATCHing the approval stage to approve or deny.
 *
 * All network I/O completes before any write transaction opens (MV3 rule).
 */
export async function syncPendingApprovals(account: AccountRecord): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  const roleUrl =
    `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='approver')` +
    `?$filter=status eq 'PendingApproval'` +
    `&$select=id,principalId,roleDefinitionId,status,justification,createdDateTime,scheduleInfo,approvalId,createdBy`;

  const groupUrl =
    `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='approver')` +
    `?$filter=status eq 'PendingApproval'` +
    `&$select=id,principalId,groupId,accessId,status,justification,createdDateTime,scheduleInfo,approvalId,createdBy`;

  log('info', 'sync', `Fetching pending approvals for ${maskUpn(account.userPrincipalName)}`);

  type RequestItem = {
    id: string;
    principalId: string;
    roleDefinitionId?: string;
    groupId?: string;
    accessId?: 'member' | 'owner';
    justification?: string;
    createdDateTime: string;
    scheduleInfo?: { expiration?: { duration?: string } };
    approvalId?: string;
    createdBy?: { user?: { id: string; displayName?: string } };
  };

  const [roleRes, groupRes] = await Promise.all([
    fetchAllPages<RequestItem>(roleUrl, { headers: { Authorization: `Bearer ${account.accessToken}` } }),
    fetchAllPages<RequestItem>(groupUrl, { headers: { Authorization: `Bearer ${account.accessToken}` } }),
  ]);

  const roleItems: RequestItem[] = roleRes.ok ? roleRes.items : [];
  const groupItems: RequestItem[] = groupRes.ok ? groupRes.items : [];

  if (!roleRes.ok) log('warn', 'sync', `Role approval requests fetch failed: HTTP ${roleRes.status}`);
  if (!groupRes.ok) log('warn', 'sync', `Group approval requests fetch failed: HTTP ${groupRes.status}`);

  // Resolve role definition and group display names from the IndexedDB cache.
  const roleDefIds = [...new Set(roleItems.map(r => r.roleDefinitionId!).filter(Boolean))];
  const db = await getDB();
  const { roleDefMap, groupNameMap } = await resolveDisplayNames(db, roleDefIds, account.id);

  const newApprovals: ApprovalRecord[] = [];

  for (const item of roleItems) {
    if (!item.approvalId || !item.roleDefinitionId) continue;
    newApprovals.push({
      id: item.approvalId,
      accountId: account.id,
      requestId: item.id,
      kind: 'role',
      roleDefinitionId: item.roleDefinitionId,
      roleName: roleDefMap.get(item.roleDefinitionId) ?? item.roleDefinitionId,
      requestorId: item.principalId,
      requestorName: item.createdBy?.user?.displayName ?? item.principalId,
      requestorJustification: item.justification ?? '',
      durationRequested: item.scheduleInfo?.expiration?.duration ?? 'PT0S',
      requestedAt: new Date(item.createdDateTime).getTime(),
    });
  }

  for (const item of groupItems) {
    if (!item.approvalId || !item.groupId) continue;
    newApprovals.push({
      id: item.approvalId,
      accountId: account.id,
      requestId: item.id,
      kind: 'group',
      groupId: item.groupId,
      accessId: item.accessId,
      roleName: groupNameMap.get(item.groupId) ?? item.groupId,
      requestorId: item.principalId,
      requestorName: item.createdBy?.user?.displayName ?? item.principalId,
      requestorJustification: item.justification ?? '',
      durationRequested: item.scheduleInfo?.expiration?.duration ?? 'PT0S',
      requestedAt: new Date(item.createdDateTime).getTime(),
    });
  }

  await replaceForAccount(db, 'approvals', account.id, newApprovals);

  log('info', 'sync', `Stored ${newApprovals.length} pending approval(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('approvals');

  if (newApprovals.length > 0) {
    await notify(
      'Approval required',
      newApprovals.length === 1
        ? `"${newApprovals[0].roleName}" needs your approval`
        : `${newApprovals.length} requests need your approval`,
      'ping'
    );
  }
}

/**
 * Fetches PIM activation requests the current user submitted that are still
 * `PendingApproval`. Replaces all existing pending request records for this
 * account in the `pending_requests` store.
 *
 * Uses `filterByCurrentUser(on='principal')` to limit results to this user's
 * own requests. Covers both role and group assignment requests.
 *
 * All network I/O completes before any write transaction opens (MV3 rule).
 */
export async function syncMyPendingRequests(account: AccountRecord): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  const roleUrl =
    `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')` +
    `?$filter=status eq 'PendingApproval'` +
    `&$select=id,principalId,roleDefinitionId,status,justification,createdDateTime,scheduleInfo`;

  const groupUrl =
    `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')` +
    `?$filter=status eq 'PendingApproval'` +
    `&$select=id,principalId,groupId,accessId,status,justification,createdDateTime,scheduleInfo`;

  log('info', 'sync', `Fetching my pending requests for ${maskUpn(account.userPrincipalName)}`);

  type RequestItem = {
    id: string;
    principalId?: string;
    roleDefinitionId?: string;
    groupId?: string;
    accessId?: 'member' | 'owner';
    createdDateTime: string;
  };

  const [roleRes, groupRes] = await Promise.all([
    fetchAllPages<RequestItem>(roleUrl, { headers: { Authorization: `Bearer ${account.accessToken}` } }),
    fetchAllPages<RequestItem>(groupUrl, { headers: { Authorization: `Bearer ${account.accessToken}` } }),
  ]);

  // Guard against Graph eventual-consistency edge cases where filterByCurrentUser(on='principal')
  // transiently returns items belonging to a different principal (e.g. the approver account in a
  // multi-account session). Validate principalId matches this account's Entra OID.
  const ownOid = account.accountId;
  const allRoleItems: RequestItem[] = roleRes.ok ? roleRes.items : [];
  const allGroupItems: RequestItem[] = groupRes.ok ? groupRes.items : [];
  const roleItems = allRoleItems.filter(r => !r.principalId || r.principalId === ownOid);
  const groupItems = allGroupItems.filter(r => !r.principalId || r.principalId === ownOid);
  if (roleItems.length !== allRoleItems.length || groupItems.length !== allGroupItems.length) {
    log('warn', 'sync', `syncMyPendingRequests filtered out ${allRoleItems.length - roleItems.length + allGroupItems.length - groupItems.length} item(s) with mismatched principalId for ${maskUpn(account.userPrincipalName)}`);
  }

  if (!roleRes.ok) log('warn', 'sync', `My pending role requests fetch failed: HTTP ${roleRes.status}`);
  if (!groupRes.ok) log('warn', 'sync', `My pending group requests fetch failed: HTTP ${groupRes.status}`);

  const defsDb = await getDB();
  const roleDefIds = [...new Set(roleItems.map(r => r.roleDefinitionId!).filter(Boolean))];
  const { roleDefMap, groupNameMap } = await resolveDisplayNames(defsDb, roleDefIds, account.id);

  const newRequests: PendingRequestRecord[] = [
    ...roleItems.map(item => ({
      id: item.id,
      accountId: account.id,
      kind: 'role' as const,
      roleDefinitionId: item.roleDefinitionId,
      roleName: (item.roleDefinitionId ? roleDefMap.get(item.roleDefinitionId) : undefined) ?? item.roleDefinitionId ?? item.id,
      requestedAt: new Date(item.createdDateTime).getTime(),
    })),
    ...groupItems.map(item => ({
      id: item.id,
      accountId: account.id,
      kind: 'group' as const,
      groupId: item.groupId,
      accessId: item.accessId,
      roleName: (item.groupId ? groupNameMap.get(item.groupId) : undefined) ?? item.groupId ?? item.id,
      requestedAt: new Date(item.createdDateTime).getTime(),
    })),
  ];

  const db = await getDB();
  await replaceForAccount(db, 'pending_requests', account.id, newRequests);

  log('info', 'sync', `Stored ${newRequests.length} pending request(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('pending_requests');
  await reconcilePendingApprovalAlarm();
}

/**
 * Fetches PIM-eligible Entra role assignments for the account from Graph and
 * replaces all existing role records for that account in IndexedDB. Role
 * definitions (names, isBuiltIn) are upserted into `role_definitions` as a
 * shared cache -- built-in roles are stored with an empty tenantId so they are
 * not duplicated across tenants. Policy rules are also fetched and cached.
 *
 * All network I/O completes before any write transaction opens (MV3 rule: never
 * hold a transaction open across a network call).
 */
export async function syncEligibleAssignments(account: AccountRecord, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!account.accessToken || !account.graphHost) {
    log('info', 'sync', `syncEligibleAssignments skipped for ${maskUpn(account.userPrincipalName)}: missing accessToken or graphHost`);
    return;
  }

  await syncRoleAssignments(account, { force });

  await Promise.all([
    syncActiveAssignments(account),
    syncGroupAssignments(account, { force }),
    syncPendingApprovals(account),
    syncMyPendingRequests(account),
    syncAzureEligibleAssignments(account, { force }),
    syncAzureActiveAssignments(account),
  ]);
  log('info', 'sync', `syncEligibleAssignments complete for ${maskUpn(account.userPrincipalName)}`);
}

/**
 * Fetches PIM-eligible Entra role assignments (plus role definitions and
 * policies) without the full cascade. Used by the sync cycle via
 * `syncEligibleAssignments` and directly for targeted post-activation resyncs.
 */
export async function syncRoleAssignments(account: AccountRecord, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  // roleEligibilitySchedules is the correct v1.0 endpoint for PIM eligible roles.
  // eligibleRoleAssignments does not exist in v1.0 (returns 400 "Resource not found").
  // Filter to Provisioned only to exclude revoked or pending eligibilities.
  // roleDefinition must use nested $select inside $expand to avoid a 400.
  const url =
    `${account.graphHost}/v1.0/roleManagement/directory/roleEligibilitySchedules` +
    `?$filter=principalId eq '${account.accountId}' and status eq 'Provisioned'` +
    `&$expand=roleDefinition($select=id,displayName,isBuiltIn)` +
    `&$select=id,principalId,roleDefinitionId,directoryScopeId,status,memberType`;

  type EligibleScheduleItem = {
    id: string;
    roleDefinitionId: string;
    directoryScopeId: string;
    status: string;
    memberType?: string;
    roleDefinition?: { id?: string; displayName?: string; isBuiltIn?: boolean };
  };

  log('info', 'sync', `Fetching eligible assignments for ${maskUpn(account.userPrincipalName)} (${account.cloud})`);
  const res = await fetchAllPages<EligibleScheduleItem>(url, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });

  if (!res.ok) {
    log('warn', 'sync', `eligibleRoleAssignments failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status}`);
    log('warn', 'sync', `  Response body: ${res.body}`);
    return;
  }

  const items = res.items;
  log('info', 'sync', `eligibleRoleAssignments: ${items.length} assignment(s) for ${maskUpn(account.userPrincipalName)}`);

  // Extract role definitions to upsert into the shared cache.
  // Built-in roles use tenantId='' so they are not duplicated across tenants.
  const roleDefs: RoleDefinitionRecord[] = items.map(item => ({
    id: item.roleDefinitionId,
    displayName: item.roleDefinition?.displayName ?? item.roleDefinitionId,
    isBuiltIn: item.roleDefinition?.isBuiltIn ?? false,
    tenantId: (item.roleDefinition?.isBuiltIn ?? false) ? '' : account.tenantId,
  }));

  // Map Graph response to RoleRecord (name/isBuiltIn live in role_definitions).
  const newRoles: RoleRecord[] = items.map(item => ({
    id: item.id,
    accountId: account.id,
    roleDefinitionId: item.roleDefinitionId,
    directoryScopeId: item.directoryScopeId,
    memberType: normalizeMemberType(item.memberType),
  }));

  // All fetches done -- open a single multi-store write transaction.
  const db = await getDB();
  const tx = db.transaction(['roles', 'role_definitions'], 'readwrite');
  const rolesStore = tx.objectStore('roles');
  const defsStore = tx.objectStore('role_definitions');

  const existingKeys = await rolesStore.index('by-account').getAllKeys(account.id);
  log('info', 'sync', `Writing ${newRoles.length} role(s) for ${maskUpn(account.userPrincipalName)} (replacing ${existingKeys.length} existing)`);
  await Promise.all([
    ...existingKeys.map(k => rolesStore.delete(k)),
    ...roleDefs.map(d => defsStore.put(d)),
    ...newRoles.map(r => rolesStore.put(r)),
  ]);
  await tx.done;

  notifyDbChanged('roles', 'role_definitions');

  // For built-in roles the roleDefinitionId from the expand matches roleManagementPolicyAssignments
  // directly. For custom roles, the expand ID does not match -- querying roleDefinitions/{id}
  // returns a different canonical ID that the policy assignment endpoint accepts.
  const roleDefinitionIds = [...new Set(items.map(item => item.roleDefinitionId))];
  const policyQueryIds = new Map<string, string>(roleDefinitionIds.map(id => [id, id]));

  const customRoleIds = roleDefinitionIds.filter(
    id => !(items.find(i => i.roleDefinitionId === id)?.roleDefinition?.isBuiltIn ?? false)
  );
  if (customRoleIds.length > 0) {
    log('info', 'sync', `Resolving canonical IDs for ${customRoleIds.length} custom role(s)`);
    await withConcurrency(customRoleIds, 5, async (roleDefId) => {
      const defRes = await fetchWithRetry(
        `${account.graphHost}/v1.0/roleManagement/directory/roleDefinitions/${roleDefId}`,
        { headers: { Authorization: `Bearer ${account.accessToken!}` } },
      );
      if (!defRes.ok) {
        log('warn', 'sync', `  roleDefinitions fetch failed for ${roleDefId}: HTTP ${defRes.status}`);
        return;
      }
      const def = await defRes.json() as { id: string };
      log('info', 'sync', `  Custom role ${roleDefId} -> policy query ID: ${def.id}`);
      policyQueryIds.set(roleDefId, def.id);
    });
  }

  // directoryScopeId is used in place of the hardcoded '/' for RMAU-scoped roles.
  const scopeMap = new Map(items.map(item => [item.roleDefinitionId, item.directoryScopeId]));
  const roleNamesMap = new Map(roleDefs.map(d => [d.id, d.displayName]));
  await syncPolicyRules(account, roleDefinitionIds, roleNamesMap, policyQueryIds, scopeMap, { force });
}

/**
 * Fetches active (provisioned) Entra role assignment schedules for the account
 * from Graph and replaces all existing activation records for that account in
 * IndexedDB. Active assignments are used by the popup to filter them out of
 * the eligible list and to populate the Active Assignments section.
 *
 * Covers both PIM-activated roles (time-bound) and permanently assigned roles
 * (expiresAt = 0). All network I/O completes before the write transaction opens.
 */
export async function syncActiveAssignments(account: AccountRecord): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  const url =
    `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentSchedules` +
    `?$filter=principalId eq '${account.accountId}' and status eq 'Provisioned'` +
    `&$select=id,roleDefinitionId,directoryScopeId,scheduleInfo,status,memberType`;

  type ActiveScheduleItem = {
    id: string;
    roleDefinitionId: string;
    directoryScopeId: string;
    scheduleInfo?: { startDateTime?: string | null; expiration?: { endDateTime?: string | null; type?: string } };
    status: string;
    memberType?: string;
  };

  log('info', 'sync', `Fetching active assignments for ${maskUpn(account.userPrincipalName)}`);
  const res = await fetchAllPages<ActiveScheduleItem>(url, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  if (!res.ok) {
    log('warn', 'sync', `roleAssignmentSchedules failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status} ${res.body}`);
    return;
  }

  const items = res.items;
  log('info', 'sync', `Active assignments: ${items.length} for ${maskUpn(account.userPrincipalName)}`);

  // Fetch role definitions for any roleDefinitionId not already in the cache. Permanent
  // assignments are often not in the PIM eligible list, so their definitions may be absent.
  // All network I/O must complete before any write transaction is opened (MV3 rule).
  const defsDb = await getDB();
  const uniqueRoleDefIds = [...new Set(items.map(i => i.roleDefinitionId))];
  const cachedDefs = await Promise.all(uniqueRoleDefIds.map(id => defsDb.get('role_definitions', id)));
  const missingIds = uniqueRoleDefIds.filter((_, i) => !cachedDefs[i]);

  const fetchedDefs: RoleDefinitionRecord[] = [];
  await withConcurrency(missingIds, 5, async (roleDefId) => {
    const defRes = await fetchWithRetry(
      `${account.graphHost}/v1.0/roleManagement/directory/roleDefinitions/${roleDefId}`,
      { headers: { Authorization: `Bearer ${account.accessToken!}` } }
    );
    if (!defRes.ok) {
      log('warn', 'sync', `Failed to fetch role definition ${roleDefId}: HTTP ${defRes.status}`);
      return;
    }
    const def = await defRes.json() as { id: string; displayName: string; isBuiltIn: boolean };
    fetchedDefs.push({ id: def.id, displayName: def.displayName, isBuiltIn: def.isBuiltIn, tenantId: def.isBuiltIn ? '' : account.tenantId });
  });

  if (fetchedDefs.length > 0) {
    const defWriteDb = await getDB();
    const defTx = defWriteDb.transaction('role_definitions', 'readwrite');
    await Promise.all(fetchedDefs.map(d => defTx.store.put(d)));
    await defTx.done;
    log('info', 'sync', `Cached ${fetchedDefs.length} missing role definition(s) from active assignments`);
    notifyDbChanged('role_definitions');
  }

  const newActivations: ActivationRecord[] = items.map(item => ({
    id: item.id,
    accountId: account.id,
    kind: 'role' as const,
    roleDefinitionId: item.roleDefinitionId,
    directoryScopeId: item.directoryScopeId,
    isPermanent: item.scheduleInfo?.expiration?.type === 'noExpiration',
    startedAt: item.scheduleInfo?.startDateTime ? new Date(item.scheduleInfo.startDateTime).getTime() : undefined,
    expiresAt: item.scheduleInfo?.expiration?.endDateTime
      ? new Date(item.scheduleInfo.expiration.endDateTime).getTime()
      : 0,
    memberType: normalizeMemberType(item.memberType),
  }));

  const db = await getDB();
  // Preserve expiry-notification flags across the rewrite while the expiry is unchanged.
  const prior = new Map((await db.getAllFromIndex('activations', 'by-account', account.id)).map(a => [a.id, a]));
  for (const a of newActivations) {
    const p = prior.get(a.id);
    if (p && p.expiresAt === a.expiresAt) {
      a.notifiedExpiring = p.notifiedExpiring;
      a.notifiedExpired = p.notifiedExpired;
    }
  }
  // Only clear role-kind activations so group activations written by syncActiveGroupAssignments are preserved.
  await replaceForAccount(db, 'activations', account.id, newActivations, a => a.kind !== 'group');

  log('info', 'sync', `Wrote ${newActivations.length} active assignment(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('activations');
}

/**
 * Fetches PIM-eligible group assignments for the account from Graph and replaces all
 * existing group records for that account in IndexedDB. Group display names are resolved
 * via the `$expand=group` parameter. Policy rules are fetched per unique group object using
 * `scopeType eq 'Group'` and `scopeId eq '{groupId}'` (each group has its own policy).
 *
 * Calls `syncActiveGroupAssignments` at the end so the activations store is always fresh.
 */
export async function syncGroupAssignments(account: AccountRecord, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  const url =
    `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/eligibilitySchedules` +
    `?$filter=principalId eq '${account.accountId}' and status eq 'Provisioned'` +
    `&$expand=group($select=id,displayName)` +
    `&$select=id,groupId,accessId,status,memberType`;

  type GroupEligibilityItem = {
    id: string;
    groupId: string;
    accessId: 'member' | 'owner';
    status: string;
    memberType?: string;
    group?: { id?: string; displayName?: string };
  };

  log('info', 'sync', `Fetching eligible group assignments for ${maskUpn(account.userPrincipalName)}`);
  const res = await fetchAllPages<GroupEligibilityItem>(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
  if (!res.ok) {
    log('warn', 'sync', `Group eligibility schedules failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status}`);
    log('warn', 'sync', `  Response: ${res.body}`);
    return;
  }

  const items = res.items;
  log('info', 'sync', `Eligible group assignments: ${items.length} for ${maskUpn(account.userPrincipalName)}`);

  // Each (groupId, accessId) pair has its own independent policy -- a user eligible as both
  // member and owner of the same group can have different constraints for each access level.
  // The policy assignment filter requires scopeType 'Group' (capital G) and
  // roleDefinitionId eq '{accessId}' ('member' or 'owner') to uniquely identify the policy.
  // TTL: only fetch policies for pairs whose cached record is stale unless forced.
  let policyItems = items;
  if (!force) {
    const cacheDb = await getDB();
    const cutoff = Date.now() - POLICY_TTL_MS;
    const cached = await Promise.all(items.map(item => cacheDb.get('group_policies', `${account.tenantId}::${item.groupId}::${item.accessId}`)));
    policyItems = items.filter((_, i) => (cached[i]?.lastSyncedAt ?? 0) < cutoff);
    if (policyItems.length < items.length) {
      log('info', 'sync', `Skipping ${items.length - policyItems.length} fresh group policy/policies (TTL)`);
    }
  }

  const groupHeaders = { Authorization: `Bearer ${account.accessToken!}` };
  const rulesByItem = await fetchPolicyRulesForPairs({
    pairs: policyItems,
    headers: groupHeaders,
    label: (item) => `"${item.group?.displayName ?? item.groupId}" (${item.accessId})`,
    assignmentUrl: (item) =>
      `${account.graphHost}/v1.0/policies/roleManagementPolicyAssignments` +
      `?$filter=scopeId eq '${item.groupId}' and scopeType eq 'Group' and roleDefinitionId eq '${item.accessId}'` +
      `&$select=id,policyId`,
    policyIdOf: item => item.policyId,
    fetchRules: graphPolicyRulesFetcher(account.graphHost!, groupHeaders),
    logPrefix: 'Group',
  });

  // All network I/O complete -- build records and write.
  const newGroups: GroupRecord[] = items.map(item => ({
    id: item.id,
    accountId: account.id,
    groupId: item.groupId,
    displayName: item.group?.displayName ?? item.groupId,
    accessId: item.accessId,
    memberType: normalizeMemberType(item.memberType),
  }));

  // Policy key: `${tenantId}::${groupId}::${accessId}` -- member and owner policies are distinct.
  const newGroupPolicies: GroupPolicyRecord[] = [...rulesByItem].map(([item, parsed]) => ({
    id: `${account.tenantId}::${item.groupId}::${item.accessId}`,
    groupId: item.groupId,
    tenantId: account.tenantId,
    ...parsed,
    lastSyncedAt: Date.now(),
  }));

  const db = await getDB();
  const tx = db.transaction(['groups', 'group_policies'], 'readwrite');
  const groupsStore = tx.objectStore('groups');
  const policiesStore = tx.objectStore('group_policies');
  const existingGroupKeys = await groupsStore.index('by-account').getAllKeys(account.id);
  await Promise.all([
    ...existingGroupKeys.map(k => groupsStore.delete(k)),
    ...newGroups.map(g => groupsStore.put(g)),
    ...newGroupPolicies.map(p => policiesStore.put(p)),
  ]);
  await tx.done;

  log('info', 'sync', `Wrote ${newGroups.length} group(s) and ${newGroupPolicies.length} group policy/policies for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('groups', 'group_policies');

  await syncActiveGroupAssignments(account);
}

/**
 * Fetches active (provisioned) Entra group assignment schedules for the account
 * from Graph and replaces all group-kind activation records for that account in
 * IndexedDB. Role-kind activations written by `syncActiveAssignments` are not touched.
 */
export async function syncActiveGroupAssignments(account: AccountRecord): Promise<void> {
  if (!account.accessToken || !account.graphHost) return;

  const url =
    `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentSchedules` +
    `?$filter=principalId eq '${account.accountId}' and status eq 'Provisioned'` +
    `&$select=id,groupId,accessId,scheduleInfo,status,memberType`;

  type ActiveGroupScheduleItem = {
    id: string;
    groupId: string;
    accessId: 'member' | 'owner';
    scheduleInfo?: { startDateTime?: string | null; expiration?: { endDateTime?: string | null; type?: string } };
    status: string;
    memberType?: string;
  };

  log('info', 'sync', `Fetching active group assignments for ${maskUpn(account.userPrincipalName)}`);
  const res = await fetchAllPages<ActiveGroupScheduleItem>(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
  if (!res.ok) {
    log('warn', 'sync', `Active group assignment schedules failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status} ${res.body}`);
    return;
  }

  const items = res.items;
  log('info', 'sync', `Active group assignments: ${items.length} for ${maskUpn(account.userPrincipalName)}`);

  const newActivations: ActivationRecord[] = items.map(item => ({
    id: item.id,
    accountId: account.id,
    kind: 'group' as const,
    groupId: item.groupId,
    accessId: item.accessId,
    isPermanent: item.scheduleInfo?.expiration?.type === 'noExpiration',
    startedAt: item.scheduleInfo?.startDateTime ? new Date(item.scheduleInfo.startDateTime).getTime() : undefined,
    expiresAt: item.scheduleInfo?.expiration?.endDateTime
      ? new Date(item.scheduleInfo.expiration.endDateTime).getTime()
      : 0,
    memberType: normalizeMemberType(item.memberType),
  }));

  const db = await getDB();
  // Preserve expiry-notification flags across the rewrite while the expiry is unchanged.
  const prior = new Map((await db.getAllFromIndex('activations', 'by-account', account.id)).map(a => [a.id, a]));
  for (const a of newActivations) {
    const p = prior.get(a.id);
    if (p && p.expiresAt === a.expiresAt) {
      a.notifiedExpiring = p.notifiedExpiring;
      a.notifiedExpired = p.notifiedExpired;
    }
  }
  // Only clear group-kind activations so role activations are preserved.
  await replaceForAccount(db, 'activations', account.id, newActivations, a => a.kind === 'group');

  log('info', 'sync', `Wrote ${newActivations.length} active group assignment(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('activations');
}

// ---------------------------------------------------------------------------
// ARM scope path helpers
// ---------------------------------------------------------------------------

/**
 * Maps the raw ARM scope type string from `expandedProperties.scope.type` to the
 * discriminated union stored in `AzureScopeRecord`. The ARM API returns lowercase
 * strings (e.g. "resourcegroup"), while the stored type uses camelCase.
 */
function deriveScopeType(rawType: string): 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource' {
  switch (rawType.toLowerCase()) {
    case 'managementgroup': return 'managementGroup';
    case 'subscription': return 'subscription';
    case 'resourcegroup': return 'resourceGroup';
    default: return 'resource';
  }
}

/**
 * Extracts the subscription GUID from an ARM scope path.
 * Works for any scope depth: /subscriptions/{id}, /subscriptions/{id}/resourceGroups/{rg}, etc.
 */
function parseSubscriptionId(scopeId: string): string {
  return /\/subscriptions\/([^/]+)/i.exec(scopeId)?.[1] ?? '';
}

/**
 * Derives the parent scope ARM path from a given scope ID and type.
 * - Subscription scopes have no parent (returns null).
 * - Resource group scopes are parented by their subscription path.
 * - Resource scopes are parented by their resource group path.
 */
function deriveParentScopeId(scopeId: string, scopeType: 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource'): string | null {
  if (scopeType === 'managementGroup') return null; // MG hierarchy is not encoded in the scope path
  if (scopeType === 'subscription') return null;
  if (scopeType === 'resourceGroup') {
    return /^(\/subscriptions\/[^/]+)/i.exec(scopeId)?.[1] ?? null;
  }
  // Resource: parent is /subscriptions/{id}/resourceGroups/{rg}
  return /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)/i.exec(scopeId)?.[1] ?? null;
}


/** Raw ARM roleEligibility/roleAssignment schedule instance shape shared by both Azure syncs. */
type RawScheduleInstance = {
  name: string;
  properties?: {
    expandedProperties?: {
      scope?: { id: string; displayName: string; type: string };
      roleDefinition?: { id: string; displayName: string; type: string };
      principal?: { id: string; type: string };
    };
    startDateTime?: string | null;
    endDateTime?: string | null;
    memberType?: string;
  };
};

/**
 * Maps one ARM schedule instance to the record fields shared by
 * `AzureRoleRecord` and `AzureActivationRecord` (which adds only
 * `isPermanent`). Returns null when `expandedProperties` is incomplete.
 * `scopeDisplayName` is surfaced separately for scope-record synthesis.
 */
function mapAzureInstance(
  instance: RawScheduleInstance,
  account: AccountRecord,
  now: number,
): { role: AzureRoleRecord; scopeDisplayName: string } | null {
  const ep = instance.properties?.expandedProperties;
  if (!ep?.scope?.id || !ep?.roleDefinition?.id || !ep?.principal?.id) return null;
  const scopeId = ep.scope.id;
  const scopeType = deriveScopeType(ep.scope.type ?? '');
  return {
    scopeDisplayName: ep.scope.displayName,
    role: {
      id: instance.name,
      accountId: account.id,
      tenantId: account.tenantId,
      scopeId,
      scopeType,
      subscriptionId: parseSubscriptionId(scopeId),
      roleDefinitionId: ep.roleDefinition.id,
      roleDisplayName: ep.roleDefinition.displayName,
      roleIsBuiltIn: ep.roleDefinition.type === 'BuiltInRole',
      principalId: ep.principal.id,
      principalType: ep.principal.type,
      startDateTime: instance.properties?.startDateTime
        ? new Date(instance.properties.startDateTime).getTime()
        : 0,
      endDateTime: instance.properties?.endDateTime
        ? new Date(instance.properties.endDateTime).getTime()
        : 0,
      memberType: normalizeMemberType(instance.properties?.memberType),
      lastSyncedAt: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Azure ARM eligible assignment sync
// ---------------------------------------------------------------------------

/**
 * Fetches all Azure ARM PIM-eligible role assignments for the account using the
 * tenant-root scope endpoint and writes them to `azure_scopes` and `azure_roles`.
 *
 * Uses the root `/providers/Microsoft.Authorization/roleEligibilityScheduleInstances`
 * endpoint rather than querying per subscription. The per-subscription endpoint
 * requires an active RBAC role on each subscription -- users with only eligible
 * assignments would see empty results. The root endpoint is not subject to this
 * restriction and covers all scopes in the tenant in a single request.
 *
 * Subscription IDs are parsed from the scope paths returned in `expandedProperties`
 * rather than from a separate subscriptions API call.
 *
 * Follows the MV3 rule: all network I/O completes before any write transaction opens.
 * Runs in parallel with Entra sync functions at the end of syncEligibleAssignments.
 */
export async function syncAzureEligibleAssignments(account: AccountRecord, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!account.armAccessToken) {
    log('info', 'sync', `syncAzureEligibleAssignments skipped for ${maskUpn(account.userPrincipalName)}: no ARM token`);
    return;
  }

  const armHost = getArmHost(account.cloud);
  const armToken = account.armAccessToken;
  const now = Date.now();

  // Fetch eligible assignments and subscription list in parallel. The subscriptions call
  // provides display names for subscriptions that only appear as parent scopes of deep
  // assignments (resourceGroup/resource), which don't produce their own scope records.
  const assignmentsUrl =
    `${armHost}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances` +
    `?api-version=2020-10-01&$filter=asTarget()`;
  const subscriptionsUrl = `${armHost}/subscriptions?api-version=2022-12-01`;

  type RawSubscription = { subscriptionId: string; displayName: string };

  log('info', 'sync', `Azure: fetching eligible assignments and subscriptions for ${maskUpn(account.userPrincipalName)}`);
  const [res, subsRes] = await Promise.all([
    fetchAllPages<RawScheduleInstance>(assignmentsUrl, { headers: { Authorization: `Bearer ${armToken}` } }),
    fetchAllPages<RawSubscription>(subscriptionsUrl, { headers: { Authorization: `Bearer ${armToken}` } }),
  ]);

  if (!res.ok) {
    log('warn', 'sync', `Azure: roleEligibilityScheduleInstances failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status} ${res.body}`);
    return;
  }

  const subscriptions: RawSubscription[] = subsRes.ok ? subsRes.items : [];
  log('info', 'sync', `Azure: ${subscriptions.length} subscription(s) visible for ${maskUpn(account.userPrincipalName)}`);

  const items = res.items;
  log('info', 'sync', `Azure: ${items.length} eligible assignment(s) for ${maskUpn(account.userPrincipalName)}`);

  // Build scope and role records from expandedProperties -- no secondary lookups needed.
  // Scopes are deduplicated by ID since multiple role assignments can share the same scope.
  const scopeMap = new Map<string, AzureScopeRecord>();
  const newRoles: AzureRoleRecord[] = [];

  for (const instance of items) {
    const mapped = mapAzureInstance(instance, account, now);
    if (!mapped) {
      log('warn', 'sync', `Azure: skipping instance with missing expandedProperties: ${instance.name}`);
      continue;
    }
    const { role, scopeDisplayName } = mapped;

    if (!scopeMap.has(role.scopeId)) {
      scopeMap.set(role.scopeId, {
        id: role.scopeId,
        accountId: account.id,
        tenantId: account.tenantId,
        scopeType: role.scopeType,
        displayName: scopeDisplayName,
        subscriptionId: role.subscriptionId,
        parentScopeId: deriveParentScopeId(role.scopeId, role.scopeType),
        lastSyncedAt: now,
      });
    }

    newRoles.push(role);
  }

  // Synthesize subscription-level scope records for any subscription not already present
  // from a direct assignment. This ensures the popup can resolve a display name even when
  // all of a user's roles for a subscription are at resourceGroup or resource scope.
  for (const sub of subscriptions) {
    const scopeId = `/subscriptions/${sub.subscriptionId}`;
    if (!scopeMap.has(scopeId)) {
      scopeMap.set(scopeId, {
        id: scopeId,
        accountId: account.id,
        tenantId: account.tenantId,
        scopeType: 'subscription',
        displayName: sub.displayName,
        subscriptionId: sub.subscriptionId,
        parentScopeId: null,
        lastSyncedAt: now,
      });
    }
  }

  const newScopes = [...scopeMap.values()];

  // All network I/O complete -- open a single two-store write transaction (MV3 rule).
  const db = await getDB();
  const tx = db.transaction(['azure_scopes', 'azure_roles'], 'readwrite');
  const scopesStore = tx.objectStore('azure_scopes');
  const rolesStore = tx.objectStore('azure_roles');

  const [existingScopeKeys, existingRoleKeys] = await Promise.all([
    scopesStore.index('by-account').getAllKeys(account.id),
    rolesStore.index('by-account').getAllKeys(account.id),
  ]);

  await Promise.all([
    ...existingScopeKeys.map(k => scopesStore.delete(k)),
    ...existingRoleKeys.map(k => rolesStore.delete(k)),
    ...newScopes.map(s => scopesStore.put(s)),
    ...newRoles.map(r => rolesStore.put(r)),
  ]);
  await tx.done;

  log('info', 'sync', `Azure: wrote ${newScopes.length} scope(s) and ${newRoles.length} eligible role(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('azure_scopes', 'azure_roles');

  await syncAzurePolicyRules(account, { force });
}

/**
 * Fetches ARM role management policy rules for every unique (scopeId, roleDefinitionId)
 * pair currently in `azure_roles` for the account and upserts them into `azure_policies`.
 *
 * Two-step per pair:
 * 1. GET {scopeId}/providers/Microsoft.Authorization/roleManagementPolicyAssignments
 *    filtered by roleDefinitionId to obtain the policyId.
 * 2. GET {policyId} to fetch the full policy rules.
 *
 * Step 1 is parallelized across all pairs (max 5 concurrent). Step 2 deduplicates
 * by policyId so policies shared across multiple roles are fetched only once.
 *
 * Reuses `parsePolicyRules` from utils.ts -- the ARM rule object shape matches
 * the existing RawPolicyRule interface used for Graph policies.
 *
 * All network I/O completes before the write transaction opens (MV3 rule).
 */
async function syncAzurePolicyRules(account: AccountRecord, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!account.armAccessToken) return;

  const armHost = getArmHost(account.cloud);
  const armToken = account.armAccessToken;
  const now = Date.now();

  // Read the current azure_roles for this account to determine which pairs to fetch.
  const rolesDb = await getDB();
  const roles = await rolesDb.getAllFromIndex('azure_roles', 'by-account', account.id);
  if (roles.length === 0) return;

  // Deduplicate by composite key -- multiple instances can share the same scope+role pair.
  const pairMap = new Map<string, { scopeId: string; roleDefinitionId: string }>();
  for (const r of roles) {
    const key = `${r.scopeId}::${r.roleDefinitionId}`;
    if (!pairMap.has(key)) pairMap.set(key, { scopeId: r.scopeId, roleDefinitionId: r.roleDefinitionId });
  }
  // TTL: only fetch pairs whose cached policy is stale unless forced. Fresh pairs
  // stay valid for the cleanup below (their keys remain in pairMap).
  let pairs = [...pairMap.values()];
  if (!force) {
    const cutoff = Date.now() - POLICY_TTL_MS;
    const cached = await Promise.all(pairs.map(p => rolesDb.get('azure_policies', `${p.scopeId}::${p.roleDefinitionId}`)));
    const stale = pairs.filter((_, i) => (cached[i]?.lastSyncedAt ?? 0) < cutoff);
    if (stale.length < pairs.length) {
      log('info', 'sync', `Azure: skipping ${pairs.length - stale.length} fresh policy pair(s) (TTL)`);
    }
    pairs = stale;
    if (pairs.length === 0) return;
  }
  log('info', 'sync', `Azure: fetching policy rules for ${pairs.length} scope+role pair(s) for ${maskUpn(account.userPrincipalName)}`);

  const armHeaders = { Authorization: `Bearer ${armToken}` };
  const rulesByPair = await fetchPolicyRulesForPairs({
    pairs,
    headers: armHeaders,
    label: p => `${p.scopeId}::${p.roleDefinitionId}`,
    assignmentUrl: p =>
      `${armHost}${p.scopeId}/providers/Microsoft.Authorization/roleManagementPolicyAssignments` +
      `?api-version=2020-10-01&$filter=roleDefinitionId eq '${p.roleDefinitionId}'`,
    policyIdOf: item => item.properties?.policyId,
    // ARM policy rules live on the policy resource itself, not a /rules list endpoint.
    fetchRules: async (policyId) => {
      const res = await fetchWithRetry(`${armHost}${policyId}?api-version=2020-10-01`, { headers: armHeaders });
      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)');
        log('warn', 'sync', `Azure: policy rules fetch failed for ${policyId}: HTTP ${res.status} ${body}`);
        return null;
      }
      const json = await res.json() as { properties?: { rules?: RawPolicyRule[] } };
      return parsePolicyRules(json.properties?.rules ?? []);
    },
    logPrefix: 'Azure',
  });

  // Build records -- all network I/O done.
  const policyRecords: AzurePolicyRecord[] = [...rulesByPair].map(([{ scopeId, roleDefinitionId }, rules]) => ({
    id: `${scopeId}::${roleDefinitionId}`,
    accountId: account.id,
    tenantId: account.tenantId,
    scopeId,
    roleDefinitionId,
    ...rules,
    lastSyncedAt: now,
  }));

  // Cleanup + upsert: valid policy IDs are the keys of pairMap (the current role pairs for this
  // account). Records whose key is absent from pairMap correspond to roles that no longer exist
  // and are deleted. Records for pairs where the fetch failed keep their existing data -- the key
  // is still in pairMap even when policyRecords omits it due to a failed fetch.
  const validPolicyIds = new Set(pairMap.keys());
  const db = await getDB();
  await replaceForAccount(db, 'azure_policies', account.id, policyRecords, r => !validPolicyIds.has(r.id));

  log('info', 'sync', `Azure: stored ${policyRecords.length} policy rule set(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('azure_policies');
}

/**
 * Fetches all active Azure ARM role assignments for the account using the
 * tenant-root scope endpoint and writes them to `azure_activations`.
 *
 * Uses the same root-scope pattern as `syncAzureEligibleAssignments` to cover
 * management group scopes and avoid the active-role-required restriction on
 * per-subscription endpoints. Parses exclusively from `expandedProperties`.
 *
 * `isPermanent` is true when `properties.endDateTime` is absent -- this mirrors
 * the Entra pattern where `noExpiration` type maps to `expiresAt = 0`.
 *
 * Follows the MV3 rule: all network I/O completes before the write transaction opens.
 */
export async function syncAzureActiveAssignments(account: AccountRecord): Promise<void> {
  if (!account.armAccessToken) {
    log('info', 'sync', `syncAzureActiveAssignments skipped for ${maskUpn(account.userPrincipalName)}: no ARM token`);
    return;
  }

  const armHost = getArmHost(account.cloud);
  const armToken = account.armAccessToken;
  const now = Date.now();

  const url =
    `${armHost}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances` +
    `?api-version=2020-10-01&$filter=asTarget()`;

  log('info', 'sync', `Azure: fetching active assignments for ${maskUpn(account.userPrincipalName)}`);
  const res = await fetchAllPages<RawScheduleInstance>(url, { headers: { Authorization: `Bearer ${armToken}` } });
  if (!res.ok) {
    log('warn', 'sync', `Azure: roleAssignmentScheduleInstances failed for ${maskUpn(account.userPrincipalName)}: HTTP ${res.status} ${res.body}`);
    return;
  }

  const items = res.items;
  log('info', 'sync', `Azure: ${items.length} active assignment(s) for ${maskUpn(account.userPrincipalName)}`);

  const newActivations: AzureActivationRecord[] = [];

  for (const instance of items) {
    const mapped = mapAzureInstance(instance, account, now);
    if (!mapped) {
      log('warn', 'sync', `Azure: skipping active instance with missing expandedProperties: ${instance.name}`);
      continue;
    }
    // `isPermanent` mirrors the Entra pattern: no endDateTime means no expiry.
    newActivations.push({ ...mapped.role, isPermanent: !instance.properties?.endDateTime });
  }

  // All network I/O complete -- write transaction (MV3 rule).
  const db = await getDB();
  // Preserve expiry-notification flags across the rewrite while the expiry is unchanged.
  const prior = new Map((await db.getAllFromIndex('azure_activations', 'by-account', account.id)).map(a => [a.id, a]));
  for (const a of newActivations) {
    const p = prior.get(a.id);
    if (p && p.endDateTime === a.endDateTime) {
      a.notifiedExpiring = p.notifiedExpiring;
      a.notifiedExpired = p.notifiedExpired;
    }
  }
  await replaceForAccount(db, 'azure_activations', account.id, newActivations);

  log('info', 'sync', `Azure: wrote ${newActivations.length} active assignment(s) for ${maskUpn(account.userPrincipalName)}`);
  notifyDbChanged('azure_activations');
}

/**
 * Deletes `activating` records past `ACTIVATING_STALE_TTL_MS` and re-syncs
 * affected accounts. Called on every SW wake-up and on each `token-refresh` alarm
 * to recover from the SW being killed mid-poll.
 */
export async function cleanStaleActivatingRecords(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('activating');
  const cutoff = Date.now() - ACTIVATING_STALE_TTL_MS;
  const stale = all.filter(r => r.startedAt < cutoff);
  if (stale.length === 0) return;

  const tx = db.transaction('activating', 'readwrite');
  await Promise.all(stale.map(r => tx.store.delete(r.id)));
  await tx.done;

  log('info', 'sync', `Cleaned ${stale.length} stale activating record(s)`);
  notifyDbChanged('activating');

  // Best-effort sync for each affected account so the activations store reflects reality.
  const accountIds = [...new Set(stale.map(r => r.accountId))];
  const freshDb = await getDB();
  await Promise.all(accountIds.map(async id => {
    const account = await freshDb.get('accounts', id);
    if (account?.accessToken) await syncEligibleAssignments(account);
  }));
}

/**
 * Records that a sync is starting or finishing.
 *
 * Writes the `states` store as well as broadcasting `SYNC_STATUS`, because the
 * broadcast alone only reaches a popup that is already mounted and listening.
 * The popup closes as soon as focus moves to the interactive sign-in window, so
 * after the first sign-in it re-opens partway through the initial sync and
 * would otherwise show no activity at all. Persisting the marker lets a popup
 * that opens mid-sync read the current state, exactly as `sign-in:new` already
 * works. The broadcast is kept so an open popup still updates instantly rather
 * than waiting on a DB round trip.
 * @param running - Whether a sync is now in flight.
 */
export async function setSyncRunning(running: boolean): Promise<void> {
  try {
    const db = await getDB();
    if (running) {
      await db.put('states', { id: SYNC_STATE_ID, status: 'pending', startedAt: Date.now() });
    } else {
      await db.delete('states', SYNC_STATE_ID);
    }
    notifyDbChanged('states');
  } catch (e) {
    // A progress indicator must never break the sync it is reporting on.
    log('warn', 'sync', `Could not record sync state: ${e instanceof Error ? e.message : String(e)}`);
  }
  sendNotification({ type: 'SYNC_STATUS', running });
}

/**
 * Clears an abandoned sync marker left behind by a service worker that died
 * mid-sync. Called on every worker wake: if this module is being evaluated, no
 * sync from a previous lifetime can still be running.
 */
export async function clearStaleSyncState(): Promise<void> {
  const db = await getDB();
  const existing = await db.get('states', SYNC_STATE_ID);
  if (!existing) return;
  await db.delete('states', SYNC_STATE_ID);
  notifyDbChanged('states');
  log('info', 'sync', 'Cleared stale sync marker from a previous worker lifetime');
}

/**
 * Refreshes tokens and re-syncs PIM data for every signed-in account. Runs on
 * the 5-minute token-refresh alarm, on browser startup, and on manual refresh
 * (TRIGGER_SYNC). Records sync state so the popup can show a syncing indicator.
 */
export async function runSyncCycle(force = false): Promise<void> {
  const db = await getDB();
  const accounts = await db.getAll('accounts');
  log('info', 'sync', `Sync cycle started: ${accounts.length} account(s)`);

  await setSyncRunning(true);

  await Promise.all(accounts.map(async (account) => {
    log('info', 'sync', `Processing account: ${maskUpn(account.userPrincipalName)} (${account.cloud})`);
    await refreshAccountTokens(account);
    // Re-read after refresh to get the updated access token before calling Graph.
    const freshDb = await getDB();
    const fresh = await freshDb.get('accounts', account.id);
    if (fresh?.accessToken) {
      await syncEligibleAssignments(fresh, { force });
    } else {
      log('info', 'sync', `Skipping PIM sync for ${maskUpn(account.userPrincipalName)}: no access token after refresh`);
    }
    // Independently check the ARM token on every cycle. refreshAccountTokens only
    // refreshes ARM when the Graph token itself needed refresh -- if Graph is still valid,
    // an expiring ARM token would otherwise be missed until the Graph token also expires.
    await refreshArmToken(account.id, freshDb);

    // One-time backfill: populate tenantDisplayName for accounts signed in before this field existed.
    // The guard ensures this runs at most once per account and never again after it succeeds.
    if (fresh?.accessToken && fresh.graphHost && fresh.tenantDisplayName === null) {
      const { tenantDisplayName } = await fetchTenantInfo(fresh.graphHost, fresh.accessToken);
      if (tenantDisplayName) {
        const backfillDb = await getDB();
        const current = await backfillDb.get('accounts', fresh.id);
        if (current) {
          await backfillDb.put('accounts', { ...current, tenantDisplayName });
          notifyDbChanged('accounts');
        }
      }
    }
  }));

  log('info', 'sync', 'Sync cycle complete');
  await setSyncRunning(false);
  await updateBadge();
  await checkExpiries();
}

/**
 * Force-refetches one Entra role policy after an activation validation failure
 * suggested the cache is stale. Fire-and-forget from the activation path.
 */
export async function refreshSingleRolePolicy(account: AccountRecord, roleDefinitionId: string, directoryScopeId: string): Promise<void> {
  await syncPolicyRules(
    account,
    [roleDefinitionId],
    new Map([[roleDefinitionId, roleDefinitionId]]),
    new Map([[roleDefinitionId, roleDefinitionId]]),
    new Map([[roleDefinitionId, directoryScopeId]]),
    { force: true },
  );
}

/** Force-refetches one group policy after an activation validation failure. */
export async function refreshSingleGroupPolicy(account: AccountRecord, groupId: string, accessId: 'member' | 'owner', displayName: string): Promise<void> {
  const headers = { Authorization: `Bearer ${account.accessToken!}` };
  const rules = await fetchPolicyRulesForPairs({
    pairs: [{ groupId, accessId }],
    headers,
    label: () => `"${displayName}" (${accessId})`,
    assignmentUrl: () =>
      `${account.graphHost}/v1.0/policies/roleManagementPolicyAssignments` +
      `?$filter=scopeId eq '${groupId}' and scopeType eq 'Group' and roleDefinitionId eq '${accessId}'` +
      `&$select=id,policyId`,
    policyIdOf: item => item.policyId,
    fetchRules: graphPolicyRulesFetcher(account.graphHost!, headers),
    logPrefix: 'Group',
  });
  const parsed = [...rules.values()][0];
  if (!parsed) return;
  const db = await getDB();
  await db.put('group_policies', {
    id: `${account.tenantId}::${groupId}::${accessId}`,
    groupId,
    tenantId: account.tenantId,
    ...parsed,
    lastSyncedAt: Date.now(),
  });
  notifyDbChanged('group_policies');
}

/** Force-refetches one Azure policy after an activation validation failure. */
export async function refreshSingleAzurePolicy(account: AccountRecord, scopeId: string, roleDefinitionId: string): Promise<void> {
  if (!account.armAccessToken) return;
  const armHost = getArmHost(account.cloud);
  const armHeaders = { Authorization: `Bearer ${account.armAccessToken}` };
  const rules = await fetchPolicyRulesForPairs({
    pairs: [{ scopeId, roleDefinitionId }],
    headers: armHeaders,
    label: p => `${p.scopeId}::${p.roleDefinitionId}`,
    assignmentUrl: p =>
      `${armHost}${p.scopeId}/providers/Microsoft.Authorization/roleManagementPolicyAssignments` +
      `?api-version=2020-10-01&$filter=roleDefinitionId eq '${p.roleDefinitionId}'`,
    policyIdOf: item => item.properties?.policyId,
    fetchRules: async (policyId) => {
      const res = await fetchWithRetry(`${armHost}${policyId}?api-version=2020-10-01`, { headers: armHeaders });
      if (!res.ok) return null;
      const json = await res.json() as { properties?: { rules?: RawPolicyRule[] } };
      return parsePolicyRules(json.properties?.rules ?? []);
    },
    logPrefix: 'Azure',
  });
  const parsed = [...rules.values()][0];
  if (!parsed) return;
  const db = await getDB();
  await db.put('azure_policies', {
    id: `${scopeId}::${roleDefinitionId}`,
    accountId: account.id,
    tenantId: account.tenantId,
    scopeId,
    roleDefinitionId,
    ...parsed,
    lastSyncedAt: Date.now(),
  });
  notifyDbChanged('azure_policies');
}
