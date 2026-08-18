/**
 * Message dispatcher for the Privly service worker.
 *
 * Every popup command maps to a dedicated handler function via the
 * `commandHandlers` dispatch table. Shared Entra activation/deactivation logic
 * lives in `handleActivate`/`handleDeactivate`; Azure ARM handlers live in
 * `azureHandlers.ts`; the step-up engine both use lives in `activation.ts`.
 */
import browser from 'webextension-polyfill';
import {
  getDB,
  getExtensionSettings,
  DEFAULT_EXTENSION_SETTINGS,
  type AccountRecord,
  type ActivatingRecord,
} from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import { isValidEmail } from '../tools/oauth.ts';
import { sendNotification, type CommandAck, type CommandMessage } from '../types/messages.ts';
import {
  fetchAccountPhoto,
  fetchTenantInfo,
  refreshArmToken,
  performSignIn,
  acquireTokenInteractive,
} from './auth.ts';
import {
  runSyncCycle,
  syncEligibleAssignments,
  syncRoleAssignments,
  syncActiveAssignments,
  syncGroupAssignments,
  syncPendingApprovals,
  syncMyPendingRequests,
  refreshSingleRolePolicy,
  refreshSingleGroupPolicy,
} from './sync.ts';
import { updateBadge, reconcilePendingApprovalAlarm } from './badge.ts';
import { executeActivationRequest } from './activation.ts';
import { handleActivateAzureRole, handleDeactivateAzureRole } from './azureHandlers.ts';
import {
  notifyDbChanged,
  parseGraphError,
  pollUntilProvisioned,
  fetchWithRetry,
  PENDING_ACTIVATION_STATUSES,
} from './utils.ts';
import { refreshAdminPortalTabs } from './tabs.ts';
import { log, maskUpn, shortId, refreshLogSettings, clearLogs } from './log.ts';
import { checkExpiries } from './expiry.ts';

/** Payload type for a specific command, derived from the message contract. */
type CommandPayload<K extends CommandMessage['type']> = Extract<CommandMessage, { type: K }>['payload'];

// ---------------------------------------------------------------------------
// Shared activation helper
// ---------------------------------------------------------------------------

type ActivateParams = {
  accountId: string;
  /** The roles or groups store key for the entity being activated. */
  entityId: string;
  durationMinutes: number;
  justification?: string;
  ticketNumber?: string;
  ticketSystem?: string;
};

/**
 * Shared implementation for ACTIVATE_ROLE and ACTIVATE_GROUP. Builds the Graph
 * request body, delegates step-up and error dispatch to the shared activation
 * engine, writes an `activating` record while polling for provisioning
 * completion, then triggers a post-activation sync.
 * @param kind - 'role' or 'group', determines the Graph endpoint and body shape.
 * @param params - Activation parameters from the message payload.
 */
async function handleActivate(kind: 'role' | 'group', params: ActivateParams): Promise<CommandAck> {
  const { accountId, entityId, durationMinutes, justification, ticketNumber, ticketSystem } = params;

  const db = await getDB();
  const account = await db.get('accounts', accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  if (!account.accessToken || !account.graphHost) return { ok: false, error: 'Account has no access token' };

  let url: string;
  let body: Record<string, unknown>;
  let displayName: string;
  let policyKey: string;
  let policyStoreName: 'role_policies' | 'group_policies';
  let refreshStalePolicy: () => Promise<void>;

  if (kind === 'role') {
    const roleRecord = await db.get('roles', entityId);
    if (!roleRecord) return { ok: false, error: 'Role record not found' };
    const roleDef = await db.get('role_definitions', roleRecord.roleDefinitionId);
    displayName = roleDef?.displayName ?? roleRecord.roleDefinitionId;
    url = `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests`;
    body = {
      action: 'SelfActivate',
      principalId: account.accountId,
      roleDefinitionId: roleRecord.roleDefinitionId,
      directoryScopeId: roleRecord.directoryScopeId,
      justification: justification ?? '',
      scheduleInfo: {
        startDateTime: new Date().toISOString(),
        expiration: { type: 'AfterDuration', duration: `PT${durationMinutes}M` },
      },
    };
    policyKey = `${account.tenantId}::${roleRecord.roleDefinitionId}`;
    policyStoreName = 'role_policies';
    refreshStalePolicy = () => refreshSingleRolePolicy(account, roleRecord.roleDefinitionId, roleRecord.directoryScopeId);
  } else {
    const groupRecord = await db.get('groups', entityId);
    if (!groupRecord) return { ok: false, error: 'Group record not found' };
    displayName = `${groupRecord.displayName} (${groupRecord.accessId})`;
    url = `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests`;
    body = {
      action: 'SelfActivate',
      principalId: account.accountId,
      groupId: groupRecord.groupId,
      accessId: groupRecord.accessId,
      justification: justification ?? '',
      scheduleInfo: {
        startDateTime: new Date().toISOString(),
        expiration: { type: 'AfterDuration', duration: `PT${durationMinutes}M` },
      },
    };
    policyKey = `${account.tenantId}::${groupRecord.groupId}::${groupRecord.accessId}`;
    policyStoreName = 'group_policies';
    refreshStalePolicy = () => refreshSingleGroupPolicy(account, groupRecord.groupId, groupRecord.accessId, groupRecord.displayName);
  }
  if (ticketNumber) body.ticketInfo = { ticketNumber, ticketSystem: ticketSystem ?? '' };

  const makePost = (token: string) => fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const cachedPolicy = await db.get(policyStoreName, policyKey);
  const result = await executeActivationRequest({
    account,
    resource: 'graph',
    initialToken: account.accessToken,
    makeRequest: makePost,
    isSuccess: r => r.status === 201,
    cachedPolicy,
    onPolicyStale: refreshStalePolicy,
    logLabel: `ACTIVATE_${kind.toUpperCase()}`,
    failLabel: kind === 'role' ? 'Activation' : 'Group activation',
    notifyLabel: kind === 'role' ? 'Activation failed' : 'Group activation failed',
  });
  if (!result.ok) return { ok: false, error: result.error };
  const { res, token: activeToken } = result;

  // If step-up elevated the token, persist it so the next activation in the same session
  // doesn't need to step up again.
  if (activeToken !== account.accessToken) {
    const stepUpDb = await getDB();
    const current = await stepUpDb.get('accounts', accountId);
    if (current) await stepUpDb.put('accounts', { ...current, accessToken: activeToken });
  }

  const resBody = await res.json() as { id?: string; status?: string };
  const requestId = resBody.id;
  let finalStatus = resBody.status ?? 'Unknown';

  // Only write an activating record and poll when the request is provisioning, not when
  // it requires approval (PendingApproval is a terminal wait state, not a provisioning state).
  if (requestId && (!resBody.status || PENDING_ACTIVATION_STATUSES.has(resBody.status))) {
    const activatingDb = await getDB();
    await activatingDb.put('activating', {
      id: requestId,
      accountId,
      kind,
      recordId: entityId,
      displayName,
      startedAt: Date.now(),
    } satisfies ActivatingRecord);
    notifyDbChanged('activating');

    const pollBase = kind === 'role'
      ? `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests`
      : `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests`;
    finalStatus = await pollUntilProvisioned(`${pollBase}/${requestId}`, activeToken);
    log('info', 'activate', `ACTIVATE_${kind.toUpperCase()} poll complete for ${displayName}: ${finalStatus}`);

    const cleanDb = await getDB();
    await cleanDb.delete('activating', requestId);
    notifyDbChanged('activating');
  }

  log('info', 'activate', `ACTIVATE_${kind.toUpperCase()} succeeded for ${maskUpn(account.userPrincipalName)}, ${kind} ${displayName}: ${finalStatus}`);
  if (finalStatus === 'PendingApproval') {
    await notify('Activation request submitted', `"${displayName}" is awaiting approval`);
  } else {
    await notify(kind === 'role' ? 'Role activated' : 'Group activated', `${displayName} activated`, 'ping');
    const settings = await getExtensionSettings();
    if (settings.reloadPortalsOnActivation) {
      setTimeout(() => refreshAdminPortalTabs().catch(() => {}), 1500);
    }
  }

  const freshDb = await getDB();
  const freshAccount = await freshDb.get('accounts', accountId) ?? account;
  // Targeted resync: only the stores this action changed, not the full cascade.
  if (kind === 'role') {
    await Promise.all([syncRoleAssignments(freshAccount), syncActiveAssignments(freshAccount)]);
  } else {
    await syncGroupAssignments(freshAccount);
  }
  await updateBadge();
  void checkExpiries().catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared deactivation helper
// ---------------------------------------------------------------------------

/**
 * Shared implementation for DEACTIVATE_ROLE and DEACTIVATE_GROUP. Looks up the
 * activation record, constructs the SelfDeactivate request body, and triggers a
 * post-deactivation sync. The `kind` parameter drives all role-vs-group branching.
 * @param kind - 'role' or 'group', determines the Graph endpoint and body shape.
 * @param params - Deactivation parameters from the message payload.
 */
async function handleDeactivate(
  kind: 'role' | 'group',
  params: { accountId: string; activationId: string },
): Promise<CommandAck> {
  const { accountId, activationId } = params;

  const db = await getDB();
  const [account, activationRecord] = await Promise.all([
    db.get('accounts', accountId),
    db.get('activations', activationId),
  ]);
  if (!account) return { ok: false, error: 'Account not found' };
  if (!account.accessToken || !account.graphHost) return { ok: false, error: 'Account has no access token' };
  if (!activationRecord) return { ok: false, error: 'Activation record not found' };

  let url: string;
  let body: Record<string, unknown>;
  let displayName: string;

  if (kind === 'role') {
    if (!activationRecord.roleDefinitionId) return { ok: false, error: 'Not a role activation' };
    const roleDef = await db.get('role_definitions', activationRecord.roleDefinitionId);
    displayName = roleDef?.displayName ?? activationRecord.roleDefinitionId;
    url = `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests`;
    body = {
      action: 'SelfDeactivate',
      principalId: account.accountId,
      roleDefinitionId: activationRecord.roleDefinitionId,
      directoryScopeId: activationRecord.directoryScopeId ?? '/',
    };
  } else {
    if (!activationRecord.groupId || !activationRecord.accessId) return { ok: false, error: 'Not a group activation' };
    const allGroups = await db.getAllFromIndex('groups', 'by-account', accountId);
    const groupRecord = allGroups.find(g => g.groupId === activationRecord.groupId);
    displayName = groupRecord?.displayName ?? activationRecord.groupId;
    url = `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests`;
    body = {
      action: 'SelfDeactivate',
      principalId: account.accountId,
      groupId: activationRecord.groupId,
      accessId: activationRecord.accessId,
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status !== 201) {
    const bodyText = await res.text().catch(() => '(unreadable)');
    log('error', 'activate', `DEACTIVATE_${kind.toUpperCase()} failed: HTTP ${res.status} ${bodyText}`);
    const errorMsg = parseGraphError(bodyText, `${kind === 'role' ? 'Deactivation' : 'Group deactivation'} failed (HTTP ${res.status})`);
    await notify(kind === 'role' ? 'Deactivation failed' : 'Group deactivation failed', errorMsg);
    return { ok: false, error: errorMsg };
  }

  const notifyMsg = kind === 'role'
    ? `${displayName} deactivated`
    : `${displayName} (${activationRecord.accessId}) deactivated`;
  log('info', 'activate', `DEACTIVATE_${kind.toUpperCase()} succeeded for ${maskUpn(account.userPrincipalName)}, ${kind} ${displayName}`);
  await notify(kind === 'role' ? 'Role deactivated' : 'Group deactivated', notifyMsg, 'ping');

  const freshDb = await getDB();
  const freshAccount = await freshDb.get('accounts', accountId) ?? account;
  // Targeted resync: only the stores this action changed, not the full cascade.
  if (kind === 'role') {
    await Promise.all([syncRoleAssignments(freshAccount), syncActiveAssignments(freshAccount)]);
  } else {
    await syncGroupAssignments(freshAccount);
  }
  await updateBadge();
  void checkExpiries().catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approval review helper
// ---------------------------------------------------------------------------

/**
 * Fetches the approval steps for a pending PIM request, finds the in-progress
 * step, and PATCHes it with the given `reviewResult`. Used by both APPROVE_REQUEST
 * and DENY_REQUEST handlers to avoid duplicating the two-step Graph API dance.
 *
 * Graph requires GET-then-PATCH because the step ID is not known until the approval
 * resource is expanded. Role approvals use the beta endpoint; group approvals use v1.0.
 * @param account - Authenticated account making the request.
 * @param approvalBase - Base URL for the approval resource (already includes the approvalId).
 * @param reviewResult - 'Approve' or 'Deny'.
 * @param justification - Reviewer justification text (may be empty).
 */
async function performApprovalReview(
  account: AccountRecord,
  approvalBase: string,
  reviewResult: 'Approve' | 'Deny',
  justification: string | undefined,
): Promise<CommandAck> {
  const stepsRes = await fetchWithRetry(`${approvalBase}?$expand=steps`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  if (!stepsRes.ok) {
    const bodyText = await stepsRes.text();
    log('error', 'approval', `${reviewResult} steps fetch failed: HTTP ${stepsRes.status} ${bodyText}`);
    return { ok: false, error: `Failed to fetch approval steps (HTTP ${stepsRes.status})` };
  }

  const stepsBody = await stepsRes.json() as { steps?: { id: string; status: string }[] };
  const pendingStep = stepsBody.steps?.find(s => s.status === 'InProgress');
  if (!pendingStep) return { ok: false, error: 'No pending approval step found' };

  const patchRes = await fetchWithRetry(`${approvalBase}/steps/${pendingStep.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewResult, justification: justification ?? '' }),
  });

  if (!patchRes.ok) {
    const bodyText = await patchRes.text();
    const action = reviewResult === 'Approve' ? 'Approval' : 'Denial';
    log('error', 'approval', `${reviewResult} patch failed: HTTP ${patchRes.status} ${bodyText}`);
    const errorMsg = parseGraphError(bodyText, `${action} failed (HTTP ${patchRes.status})`);
    return { ok: false, error: errorMsg };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-command handlers
// ---------------------------------------------------------------------------

/** SIGN_IN_NEW -- full interactive OAuth2 PKCE flow for a new account. */
async function handleSignInNew(payload: CommandPayload<'SIGN_IN_NEW'>): Promise<CommandAck> {
  const { username, tenantId } = payload;

  if (!isValidEmail(username)) {
    return { ok: false, error: 'Invalid email address' };
  }

  const startedAt = Date.now();
  const db = await getDB();
  await db.put('states', { id: 'sign-in:new', status: 'pending', startedAt });
  notifyDbChanged('states');

  try {
    const { discovery, tokens, claims } = await performSignIn(username, tenantId);
    const domain = username.includes('@') ? username.split('@')[1] : username;

    const [freshDb, photoDataUrl, { initialDomain, tenantDisplayName }] = await Promise.all([
      getDB(),
      fetchAccountPhoto(discovery.graphHost, tokens.accessToken),
      fetchTenantInfo(discovery.graphHost, tokens.accessToken),
    ]);
    const existing = await freshDb.getFromIndex('accounts', 'by-tenant-account', [discovery.tenantId, claims.oid]);
    const accountId = existing?.id ?? crypto.randomUUID();

    await freshDb.put('accounts', {
      id: accountId,
      tenantId: discovery.tenantId,
      accountId: claims.oid,
      displayName: claims.name ?? claims.preferred_username,
      userPrincipalName: claims.preferred_username,
      tenantDomain: domain,
      cloud: discovery.cloud,
      photoDataUrl: photoDataUrl ?? existing?.photoDataUrl ?? null,
      initialDomain: initialDomain ?? existing?.initialDomain ?? null,
      tenantDisplayName: tenantDisplayName ?? existing?.tenantDisplayName ?? null,
      needsAttention: null,
      loginHost: discovery.loginHost,
      graphHost: discovery.graphHost,
      tokenEndpoint: discovery.tokenEndpoint,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      // Preserve the user's preference on re-sign-in; default false for new accounts.
      showPermanentAssignments: existing?.showPermanentAssignments ?? false,
      // ARM token fields -- populated shortly after sign-in via refreshArmToken.
      armAccessToken: existing?.armAccessToken ?? null,
      armTokenExpiresAt: existing?.armTokenExpiresAt ?? null,
    });

    await browser.storage.local.set({ activeAccountId: accountId });
    await freshDb.delete('states', 'sign-in:new');
    notifyDbChanged('accounts', 'states');
    await updateBadge();

    // Acquire ARM token non-fatally; failure is logged but does not block sign-in.
    const armDb = await getDB();
    await refreshArmToken(accountId, armDb, { fatal: false });

    // Kick off PIM sync immediately after sign-in so eligible roles appear right away.
    // Re-read the account record to ensure we have the freshly written token fields.
    const signedInDb = await getDB();
    const signedInAccount = await signedInDb.get('accounts', accountId);
    if (signedInAccount?.accessToken) {
      log('info', 'sync', `Triggering initial PIM sync for ${maskUpn(signedInAccount.userPrincipalName)}`);
      sendNotification({ type: 'SYNC_STATUS', running: true });
      syncEligibleAssignments(signedInAccount)
        .catch(err => log('warn', 'sync', `Initial PIM sync failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { sendNotification({ type: 'SYNC_STATUS', running: false }); });
    } else {
      log('warn', 'account', `Cannot trigger initial PIM sync for ${maskUpn(username)}: no access token after sign-in`);
    }

    return { ok: true };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    log('error', 'account', `Sign-in failed for ${maskUpn(username)}: ${errorMessage}`);
    const errDb = await getDB();
    await errDb.put('states', { id: 'sign-in:new', status: 'error', startedAt, error: errorMessage });
    notifyDbChanged('states');
    return { ok: false, error: errorMessage };
  }
}

/** SIGN_IN_INTERACTIVE -- re-authenticate an existing account interactively. */
async function handleSignInInteractive(payload: CommandPayload<'SIGN_IN_INTERACTIVE'>): Promise<CommandAck> {
  const { accountId } = payload;
  const db = await getDB();
  const account = await db.get('accounts', accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  try {
    await acquireTokenInteractive(account);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('error', 'account', `Interactive re-auth failed for ${maskUpn(account.userPrincipalName)}: ${error}`);
    return { ok: false, error };
  }
}

/** SIGN_OUT -- delete the account and all associated FK records. */
async function handleSignOut(payload: CommandPayload<'SIGN_OUT'>): Promise<CommandAck> {
  const { accountId } = payload;
  const db = await getDB();
  const account = await db.get('accounts', accountId);
  const tenantId = account?.tenantId;

  // Delete account and all associated FK records in a single transaction.
  // Tenant-scoped stores (role_definitions, role_policies, group_policies) are only
  // cleaned when no other accounts remain in the same tenant.
  const tx = db.transaction(
    ['accounts', 'roles', 'groups', 'activations', 'approvals',
     'pending_requests', 'activating', 'states',
     'role_definitions', 'role_policies', 'group_policies',
     'azure_scopes', 'azure_roles', 'azure_activations', 'azure_policies'],
    'readwrite'
  );

  // Check if any other accounts share this tenant before deleting tenant-scoped data.
  const allAccounts = await tx.objectStore('accounts').getAll();
  const otherTenantAccounts = tenantId
    ? allAccounts.filter(a => a.tenantId === tenantId && a.id !== accountId)
    : [];
  const isLastInTenant = otherTenantAccounts.length === 0;

  const [roleKeys, groupKeys, activationKeys, approvalKeys,
         pendingRequestKeys, activatingKeys, allStates,
         azureScopeKeys, azureRoleKeys, azureActivationKeys, azurePolicyKeys] = await Promise.all([
    tx.objectStore('roles').index('by-account').getAllKeys(accountId),
    tx.objectStore('groups').index('by-account').getAllKeys(accountId),
    tx.objectStore('activations').index('by-account').getAllKeys(accountId),
    tx.objectStore('approvals').index('by-account').getAllKeys(accountId),
    tx.objectStore('pending_requests').index('by-account').getAllKeys(accountId),
    tx.objectStore('activating').index('by-account').getAllKeys(accountId),
    tx.objectStore('states').getAll(),
    tx.objectStore('azure_scopes').index('by-account').getAllKeys(accountId),
    tx.objectStore('azure_roles').index('by-account').getAllKeys(accountId),
    tx.objectStore('azure_activations').index('by-account').getAllKeys(accountId),
    tx.objectStore('azure_policies').index('by-account').getAllKeys(accountId),
  ]);
  const stateKeys = allStates.filter(s => s.accountId === accountId).map(s => s.id);

  // Tenant-scoped keys: only fetched when this is the last account in the tenant.
  const [rolePolicyKeys, groupPolicyKeys, customRoleDefKeys] = isLastInTenant && tenantId
    ? await Promise.all([
        tx.objectStore('role_policies').index('by-tenant').getAllKeys(tenantId),
        tx.objectStore('group_policies').index('by-tenant').getAllKeys(tenantId),
        tx.objectStore('role_definitions').index('by-tenant').getAllKeys(tenantId),
      ])
    : [[], [], []];

  await Promise.all([
    ...roleKeys.map(k => tx.objectStore('roles').delete(k)),
    ...groupKeys.map(k => tx.objectStore('groups').delete(k)),
    ...activationKeys.map(k => tx.objectStore('activations').delete(k)),
    ...approvalKeys.map(k => tx.objectStore('approvals').delete(k)),
    ...pendingRequestKeys.map(k => tx.objectStore('pending_requests').delete(k)),
    ...activatingKeys.map(k => tx.objectStore('activating').delete(k)),
    ...stateKeys.map(k => tx.objectStore('states').delete(k)),
    ...azureScopeKeys.map(k => tx.objectStore('azure_scopes').delete(k)),
    ...azureRoleKeys.map(k => tx.objectStore('azure_roles').delete(k)),
    ...azureActivationKeys.map(k => tx.objectStore('azure_activations').delete(k)),
    ...azurePolicyKeys.map(k => tx.objectStore('azure_policies').delete(k)),
    ...rolePolicyKeys.map(k => tx.objectStore('role_policies').delete(k)),
    ...groupPolicyKeys.map(k => tx.objectStore('group_policies').delete(k)),
    ...customRoleDefKeys.map(k => tx.objectStore('role_definitions').delete(k)),
    tx.objectStore('accounts').delete(accountId),
  ]);
  await tx.done;

  const remaining = await db.getAll('accounts');
  if (remaining.length > 0) {
    await browser.storage.local.set({ activeAccountId: remaining[0].id });
  } else {
    await browser.storage.local.remove('activeAccountId');
  }
  log('info', 'account', `Signed out ${maskUpn(account?.userPrincipalName)}`);
  notifyDbChanged('accounts');
  // With this account's pending_requests gone, the 1-minute alarm may no longer be needed.
  await reconcilePendingApprovalAlarm();
  await updateBadge();
  return { ok: true };
}

/** TEST_NOTIFICATION -- send a test notification to verify browser permissions. */
async function handleTestNotification(): Promise<CommandAck> {
  await notify('Privly', 'Notifications are working.');
  return { ok: true };
}

/** UPDATE_ACCOUNT_SETTING -- update a per-account setting (e.g. showPermanentAssignments). */
async function handleUpdateAccountSetting(payload: CommandPayload<'UPDATE_ACCOUNT_SETTING'>): Promise<CommandAck> {
  const { accountId, patch } = payload;
  const db = await getDB();
  const account = await db.get('accounts', accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  await db.put('accounts', { ...account, ...patch });
  notifyDbChanged('accounts');
  return { ok: true };
}

/** UPDATE_EXTENSION_SETTING -- update a global extension setting. */
async function handleUpdateExtensionSetting(payload: CommandPayload<'UPDATE_EXTENSION_SETTING'>): Promise<CommandAck> {
  const db = await getDB();
  const current = await db.get('extension_settings', 'global') ?? DEFAULT_EXTENSION_SETTINGS;
  const updated = { ...current, ...payload.patch };
  await db.put('extension_settings', updated);
  refreshLogSettings();
  // Turning logging off also discards the existing log history.
  if (payload.patch.loggingEnabled === false) await clearLogs();
  notifyDbChanged('extension_settings');
  await updateBadge(updated);
  // notifyMinutesBefore may have changed; reschedule the expiry alarm.
  void checkExpiries().catch(() => {});
  return { ok: true };
}

/** TRIGGER_SYNC -- manual sync triggered from the popup refresh button. */
async function handleTriggerSync(): Promise<CommandAck> {
  log('info', 'sync', 'Manual sync triggered from popup');
  // Fire-and-forget: the ack returns immediately; SYNC_STATUS drives the spinner.
  // force bypasses the policy TTL: a manual refresh always pulls fresh policies.
  runSyncCycle(true).catch(err => log('warn', 'sync', `Manual sync failed: ${err instanceof Error ? err.message : String(err)}`));
  return { ok: true };
}

/** APPROVE_REQUEST / DENY_REQUEST -- review a pending PIM activation request. */
async function handleApprovalCommand(
  reviewResult: 'Approve' | 'Deny',
  payload: CommandPayload<'APPROVE_REQUEST'>,
): Promise<CommandAck> {
  const { accountId, approvalId, justification } = payload;
  const db = await getDB();
  const account = await db.get('accounts', accountId);
  if (!account?.accessToken || !account.graphHost) return { ok: false, error: 'Account not found or not signed in' };
  const approvalRecord = await db.get('approvals', approvalId);
  const roleName = approvalRecord?.roleName ?? approvalId;
  // Role approvals use the beta endpoint because roleAssignmentApprovals is not yet promoted to v1.0.
  const approvalBase = approvalRecord?.kind === 'group'
    ? `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentApprovals/${approvalId}`
    : `${account.graphHost}/beta/roleManagement/directory/roleAssignmentApprovals/${approvalId}`;
  const result = await performApprovalReview(account, approvalBase, reviewResult, justification);
  if (!result.ok) return result;
  log('info', 'approval', `${reviewResult} succeeded for ${maskUpn(account.userPrincipalName)}, approval ${shortId(approvalId)}`);
  await syncPendingApprovals(account);
  await notify(
    reviewResult === 'Approve' ? 'Approval granted' : 'Request denied',
    reviewResult === 'Approve' ? `You approved "${roleName}"` : `You denied "${roleName}"`,
    'ping'
  );
  return { ok: true };
}

/** CANCEL_REQUEST -- cancel the current user's own pending activation request. */
async function handleCancelRequest(payload: CommandPayload<'CANCEL_REQUEST'>): Promise<CommandAck> {
  const { accountId, requestId, kind } = payload;
  const db = await getDB();
  const account = await db.get('accounts', accountId);
  if (!account?.accessToken || !account.graphHost) return { ok: false, error: 'Account not found or not signed in' };

  const pendingRecord = await db.get('pending_requests', requestId);
  const roleName = pendingRecord?.roleName ?? requestId;

  const cancelUrl = kind === 'group'
    ? `${account.graphHost}/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/${requestId}/cancel`
    : `${account.graphHost}/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/${requestId}/cancel`;

  const cancelRes = await fetchWithRetry(cancelUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
  });

  // Graph returns 204 No Content on success.
  if (!cancelRes.ok) {
    const bodyText = await cancelRes.text();
    log('error', 'approval', `CANCEL_REQUEST failed: HTTP ${cancelRes.status} ${bodyText}`);
    return { ok: false, error: parseGraphError(bodyText, `Cancel failed (HTTP ${cancelRes.status})`) };
  }

  log('info', 'approval', `CANCEL_REQUEST succeeded for ${maskUpn(account.userPrincipalName)}, request ${shortId(requestId)}`);
  await syncMyPendingRequests(account);
  await notify('Request cancelled', `"${roleName}" activation request cancelled`, 'ping');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch table + entry point
// ---------------------------------------------------------------------------

/** Fully typed command dispatch table: each key's handler receives that command's payload type. */
const commandHandlers: {
  [K in CommandMessage['type']]: (payload: CommandPayload<K>) => Promise<CommandAck>;
} = {
  SIGN_IN_NEW: handleSignInNew,
  SIGN_IN_INTERACTIVE: handleSignInInteractive,
  SIGN_OUT: handleSignOut,
  TEST_NOTIFICATION: handleTestNotification,
  UPDATE_ACCOUNT_SETTING: handleUpdateAccountSetting,
  UPDATE_EXTENSION_SETTING: handleUpdateExtensionSetting,
  TRIGGER_SYNC: handleTriggerSync,
  ACTIVATE_ROLE: ({ accountId, roleId, ...rest }) => handleActivate('role', { accountId, entityId: roleId, ...rest }),
  ACTIVATE_GROUP: ({ accountId, groupId, ...rest }) => handleActivate('group', { accountId, entityId: groupId, ...rest }),
  DEACTIVATE_ROLE: (payload) => handleDeactivate('role', payload),
  DEACTIVATE_GROUP: (payload) => handleDeactivate('group', payload),
  ACTIVATE_AZURE_ROLE: handleActivateAzureRole,
  DEACTIVATE_AZURE_ROLE: handleDeactivateAzureRole,
  APPROVE_REQUEST: (payload) => handleApprovalCommand('Approve', payload),
  DENY_REQUEST: (payload) => handleApprovalCommand('Deny', payload),
  CANCEL_REQUEST: handleCancelRequest,
  CLEAR_LOGS: async () => {
    await clearLogs();
    return { ok: true };
  },
  LOG_EVENT: async ({ level, message }) => {
    // Popup-originated entries; truncated as a safety bound since the popup
    // sends raw exception text.
    log(level, 'popup', message.slice(0, 500));
    return { ok: true };
  },
};

/**
 * Handles all typed commands arriving from the popup via `browser.runtime.onMessage`.
 * Registered synchronously in index.ts to satisfy the MV3 requirement.
 *
 * Messages from anywhere other than this extension are dropped. Nothing can
 * reach this listener today -- the manifests declare no `content_scripts` and no
 * `externally_connectable` -- but the dispatch table includes SIGN_OUT and the
 * activation commands, so the check is in place before either is ever added.
 *
 * Returns a `CommandAck` for known commands, or `undefined` for messages that
 * are not commands (no response expected).
 */
export async function handleMessage(
  message: unknown,
  sender: browser.Runtime.MessageSender,
): Promise<unknown> {
  const msgType = typeof message === 'object' && message !== null && 'type' in message
    ? String((message as { type: unknown }).type)
    : 'unknown';

  if (sender.id !== browser.runtime.id) {
    log('warn', 'message', `Dropped ${msgType} from unexpected sender`);
    return undefined;
  }

  log('info', 'message', `${msgType} received`);

  const handler = (commandHandlers as Record<string, (payload: unknown) => Promise<CommandAck>>)[msgType];
  if (!handler) return undefined;
  return handler((message as { payload?: unknown }).payload ?? {});
}
